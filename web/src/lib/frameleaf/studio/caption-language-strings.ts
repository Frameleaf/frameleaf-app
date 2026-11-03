/**
 * The Languages card's words (FL-641), translated by the host.
 *
 * The card lives in the engine, whose locale files carry only its English for strings Frameleaf adds.
 * The host sends its own translation of each in `context.strings`, and the adapter writes it over the
 * engine key (`host-engine-strings.ts`), as for the transcript panel (FL-562). A value the engine fills
 * in at run time travels as an i18next `{{name}}` marker.
 */
export const CAPTION_LANGUAGE_ENGINE_STRINGS = {
  captionLanguagesTitle: { host: 'frameleaf_studio_caption_languages_title', engine: 'captionLanguages.title' },
  captionLanguagesOriginal: {
    host: 'frameleaf_studio_caption_languages_original',
    engine: 'captionLanguages.original',
    values: ['count'],
  },
  captionLanguagesOriginalLanguage: {
    host: 'frameleaf_studio_caption_languages_original_language',
    engine: 'captionLanguages.originalLanguage',
  },
  captionLanguagesTranslated: {
    host: 'frameleaf_studio_caption_languages_translated',
    engine: 'captionLanguages.translated',
    values: ['count'],
  },
  captionLanguagesTranslatedVoice: {
    host: 'frameleaf_studio_caption_languages_translated_voice',
    engine: 'captionLanguages.translatedVoice',
    values: ['count'],
  },
  captionLanguagesInPicture: {
    host: 'frameleaf_studio_caption_languages_in_picture',
    engine: 'captionLanguages.inPicture',
  },
  captionLanguagesSubtitleTrack: {
    host: 'frameleaf_studio_caption_languages_subtitle_track',
    engine: 'captionLanguages.subtitleTrack',
  },
  captionLanguagesReviewLines: {
    host: 'frameleaf_studio_caption_languages_review_lines',
    engine: 'captionLanguages.reviewLines',
  },
  captionLanguagesHideLines: {
    host: 'frameleaf_studio_caption_languages_hide_lines',
    engine: 'captionLanguages.hideLines',
  },
  captionLanguagesMakeVoiceOver: {
    host: 'frameleaf_studio_caption_languages_make_voice_over',
    engine: 'captionLanguages.makeVoiceOver',
    values: ['language'],
  },
  captionLanguagesNoVoice: {
    host: 'frameleaf_studio_caption_languages_no_voice',
    engine: 'captionLanguages.noVoice',
    values: ['language'],
  },
  captionLanguagesTranslateAgain: {
    host: 'frameleaf_studio_caption_languages_translate_again',
    engine: 'captionLanguages.translateAgain',
  },
  captionLanguagesRemove: { host: 'frameleaf_studio_caption_languages_remove', engine: 'captionLanguages.remove' },
  captionLanguagesAddLanguage: {
    host: 'frameleaf_studio_caption_languages_add_language',
    engine: 'captionLanguages.addLanguage',
  },
  captionLanguagesTranslate: {
    host: 'frameleaf_studio_caption_languages_translate',
    engine: 'captionLanguages.translate',
  },
  captionLanguagesTranslating: {
    host: 'frameleaf_studio_caption_languages_translating',
    engine: 'captionLanguages.translating',
    values: ['language', 'percent'],
  },
  captionLanguagesMakingVoice: {
    host: 'frameleaf_studio_caption_languages_making_voice',
    engine: 'captionLanguages.makingVoice',
    values: ['language', 'percent'],
  },
  captionLanguagesReady: {
    host: 'frameleaf_studio_caption_languages_ready',
    engine: 'captionLanguages.ready',
    values: ['language'],
  },
  captionLanguagesVoiceReady: {
    host: 'frameleaf_studio_caption_languages_voice_ready',
    engine: 'captionLanguages.voiceReady',
    values: ['language'],
  },
  captionLanguagesFailed: { host: 'frameleaf_studio_caption_languages_failed', engine: 'captionLanguages.failed' },
  captionLanguagesVoiceFailed: {
    host: 'frameleaf_studio_caption_languages_voice_failed',
    engine: 'captionLanguages.voiceFailed',
  },
  captionLanguagesUnavailable: {
    host: 'frameleaf_studio_caption_languages_unavailable',
    engine: 'captionLanguages.unavailable',
  },
  captionLanguagesNote: {
    host: 'frameleaf_studio_caption_languages_note',
    engine: 'captionLanguages.note',
    values: ['language'],
  },
  captionLanguagesWhereItRuns: {
    host: 'frameleaf_studio_caption_languages_where_it_runs',
    engine: 'captionLanguages.whereItRuns',
  },
  captionLanguagesTrackName: {
    host: 'frameleaf_studio_caption_languages_track_name',
    engine: 'captionLanguages.trackName',
    values: ['language'],
  },
  captionLanguagesVoiceTrackName: {
    host: 'frameleaf_studio_caption_languages_voice_track_name',
    engine: 'captionLanguages.voiceTrackName',
    values: ['language'],
  },
  captionLanguagesLineLabel: {
    host: 'frameleaf_studio_caption_languages_line_label',
    engine: 'captionLanguages.lineLabel',
    values: ['language', 'time'],
  },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type CaptionLanguageEngineString = keyof typeof CAPTION_LANGUAGE_ENGINE_STRINGS;

type CaptionLanguageHostKey = (typeof CAPTION_LANGUAGE_ENGINE_STRINGS)[CaptionLanguageEngineString]['host'];
type Translate = (key: CaptionLanguageHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every Languages card string, with engine markers left in place. */
export function captionLanguageEngineStrings(translate: Translate): Record<CaptionLanguageEngineString, string> {
  const strings = {} as Record<CaptionLanguageEngineString, string>;
  for (const [name, entry] of Object.entries(CAPTION_LANGUAGE_ENGINE_STRINGS) as Array<
    [CaptionLanguageEngineString, { host: CaptionLanguageHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
