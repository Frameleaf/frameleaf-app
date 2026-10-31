import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from '../../../../../i18n/en.json';
import { CAPTION_LANGUAGE_ENGINE_STRINGS, captionLanguageEngineStrings } from './caption-language-strings';
import {
  isStudioCaptionTranslationRequest,
  serializeStudioSrt,
  studioCaptionExportSidecars,
  studioCaptionLanguageTracks,
  studioCaptionSidecarName,
} from './caption-languages';

const translated = (language: string, options: { trackId: string; from: number; subtitle?: boolean }) => ({
  id: `item-${language}`,
  type: 'subtitle',
  trackId: options.trackId,
  from: options.from,
  durationInFrames: 300,
  source: {
    type: 'subtitle-import',
    fileName: `${language}.srt`,
    format: 'srt',
    importedAt: 1,
    translation: { language, from: 'en', subtitle: options.subtitle ?? true, translatedAt: 1 },
  },
  cues: [
    { id: '1', startSeconds: 0, endSeconds: 2, text: `${language} one` },
    { id: '2', startSeconds: 4, endSeconds: 6, text: ` ${language} two ` },
    { id: '3', startSeconds: 7, endSeconds: 8, text: '  ' },
  ],
});

const graph = {
  metadata: { fps: 30 },
  timeline: {
    tracks: [
      { id: 'v1', visible: true },
      { id: 'fr-track', visible: true },
      { id: 'de-track', visible: false },
      { id: 'nb-track', visible: false },
    ],
    items: [
      { id: 'clip', type: 'video', trackId: 'v1', from: 0, durationInFrames: 900 },
      // An ordinary imported subtitle file is not a translation.
      {
        id: 'imported',
        type: 'subtitle',
        trackId: 'v1',
        from: 0,
        durationInFrames: 30,
        source: { type: 'subtitle-import', fileName: 'talk.srt', format: 'srt', importedAt: 1 },
        cues: [{ id: '1', startSeconds: 0, endSeconds: 1, text: 'Hi' }],
      },
      translated('fr', { trackId: 'fr-track', from: 60 }),
      translated('de', { trackId: 'de-track', from: 60 }),
      translated('nb', { trackId: 'nb-track', from: 60, subtitle: false }),
    ],
  },
};

describe('FL-641 caption translation requests from the editor', () => {
  it('accepts two offered languages and the lines', () => {
    expect(isStudioCaptionTranslationRequest({ source: 'en', target: 'nb', lines: ['Hi'] })).toBe(true);
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      [],
      'text',
      { source: 'en', target: 'ko', lines: ['Hi'] },
      { source: 'fr', target: 'fr', lines: ['Hi'] },
      { source: 'en', target: 'fr' },
      { source: 'en', target: 'fr', lines: [] },
      { source: 'en', target: 'fr', lines: [{ text: 'Hi' }] },
      { source: 'en', target: 'fr', lines: ['Hi'], destinationId: 'cloud' },
    ]) {
      expect(isStudioCaptionTranslationRequest(bad)).toBe(false);
    }
  });
});

describe('FL-641 export track selection', () => {
  it('reads every translated track with whether it is in the picture and ticked for the export', () => {
    const tracks = studioCaptionLanguageTracks(graph);
    expect(tracks.map(({ language, inPicture, subtitle }) => ({ language, inPicture, subtitle }))).toEqual([
      { language: 'fr', inPicture: true, subtitle: true },
      { language: 'de', inPicture: false, subtitle: true },
      { language: 'nb', inPicture: false, subtitle: false },
    ]);
    // Cues on the sequence clock (the segment starts at 2 s), trimmed, blank lines left out.
    expect(tracks[0].cues).toEqual([
      { startSeconds: 2, endSeconds: 4, text: 'fr one' },
      { startSeconds: 6, endSeconds: 8, text: 'fr two' },
    ]);
  });

  it('makes a subtitle file for each ticked language, burned-in or not', () => {
    const sidecars = studioCaptionExportSidecars(graph);
    expect(sidecars.map((sidecar) => sidecar.language)).toEqual(['fr', 'de']);
    expect(sidecars[1].srt).toBe(
      '1\n00:00:02,000 --> 00:00:04,000\nde one\n\n2\n00:00:06,000 --> 00:00:08,000\nde two',
    );
  });

  it('follows the exported range: trimmed to it and starting from its beginning', () => {
    const sidecars = studioCaptionExportSidecars(graph, { inPoint: 150, outPoint: 210 });
    // 5 s to 7 s: only the second line, from 1 s to 2 s of the exported video.
    expect(sidecars[0].srt).toBe('1\n00:00:01,000 --> 00:00:02,000\nfr two');
    expect(studioCaptionExportSidecars(graph, { inPoint: 600, outPoint: 900 })).toEqual([]);
  });

  it('has nothing to add for a project without translations or a graph', () => {
    expect(studioCaptionExportSidecars({ timeline: { items: [], tracks: [] } })).toEqual([]);
    expect(studioCaptionExportSidecars(null)).toEqual([]);
  });

  it('names each file after the export and its language', () => {
    expect(studioCaptionSidecarName('Lake day', 'fr')).toBe('Lake day.fr.srt');
    expect(studioCaptionSidecarName('a/b:c', 'nb')).toBe('a b c.nb.srt');
    expect(serializeStudioSrt([{ startSeconds: 3661.5, endSeconds: 3662, text: 'x' }])).toBe(
      '1\n01:01:01,500 --> 01:01:02,000\nx',
    );
  });
});

const messages = en as unknown as Record<string, string>;
const translate = (key: string, options?: { values?: Record<string, string> }) =>
  String(new IntlMessageFormat(messages[key], 'en').format(options?.values ?? {}));

describe('FL-641 Languages card strings', () => {
  it('has an English host message for every card string, with its run-time values', () => {
    for (const entry of Object.values(CAPTION_LANGUAGE_ENGINE_STRINGS)) {
      expect(messages[entry.host], entry.host).toBeTruthy();
      const values = 'values' in entry ? [...entry.values] : [];
      const used = [...messages[entry.host].matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      expect(new Set(used), entry.host).toEqual(new Set(values));
    }
  });

  it('hands the engine i18next markers in place of run-time values', () => {
    const strings = captionLanguageEngineStrings(translate);
    expect(strings.captionLanguagesMakeVoiceOver).toBe('Make a {{language}} voice-over');
    expect(strings.captionLanguagesTranslating).toBe('Translating into {{language}}… {{percent}}%');
    expect(strings.captionLanguagesInPicture).toBe('In the picture');
    expect(Object.keys(strings)).toEqual(Object.keys(CAPTION_LANGUAGE_ENGINE_STRINGS));
  });
});
