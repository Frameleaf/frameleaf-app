import { BadRequestException } from '@nestjs/common';
import { rational } from 'src/utils/rational-time.js';
import {
  CUE_MAX_CHARACTERS,
  cueTextsOf,
  mapTranscript,
  transcriptionClipOf,
  transcriptionWindow,
  whisperLanguageOf,
} from 'src/utils/studio-transcription.js';

const assetId = '0195e2a0-0000-7000-8000-000000000011';
const graph = (clip: Record<string, unknown>, metadata?: Record<string, unknown>) => ({
  metadata: metadata ?? { fps: 30 },
  timeline: {
    items: [
      { id: 'title', type: 'text', from: 0, durationInFrames: 30, text: 'x' },
      {
        id: 'clip',
        type: 'video',
        mediaId: assetId,
        from: 60,
        durationInFrames: 300,
        sourceStart: 90,
        sourceFps: 30,
        ...clip,
      },
    ],
  },
});

describe('transcriptionClipOf', () => {
  it('reads a main-timeline video clip with its source window and speed', () => {
    expect(transcriptionClipOf(graph({ speed: 2 }), 'clip')).toEqual({
      clipId: 'clip',
      type: 'video',
      sourceKey: `library-asset:${assetId}`,
      cadence: rational(30),
      from: 60,
      durationInFrames: 300,
      sourceStart: rational(3),
      speed: rational(2),
    });
  });

  it('names restored versions, imports and generated media by their manifest key', () => {
    const restoration = '0195e2a0-0000-7000-8000-0000000000aa';
    expect(transcriptionClipOf(graph({ mediaId: `restored-${restoration}` }), 'clip').sourceKey).toBe(
      `restored-version:${restoration}`,
    );
    expect(
      transcriptionClipOf(graph({ type: 'audio', mediaId: undefined, importId: 'voice-1' }), 'clip').sourceKey,
    ).toBe('project-import:voice-1');
    expect(transcriptionClipOf(graph({ mediaId: undefined, generatedId: 'reverse-x' }), 'clip').sourceKey).toBe(
      'generated-intermediate:reverse-x',
    );
  });

  it('reads an NTSC source rate exactly', () => {
    const clip = transcriptionClipOf(graph({ sourceFps: 29.97, sourceStart: 30_000 }, { fps: 30 }), 'clip');
    expect(clip.sourceStart).toEqual(rational(1001));
  });

  it.each([
    ['a missing clip', graph({}), 'other'],
    ['a title', graph({}), 'title'],
    ['a reversed clip', graph({ isReversed: true }), 'clip'],
    ['an inexact source rate', graph({ sourceFps: 12.345 }), 'clip'],
    ['media this server does not hold', graph({ mediaId: 'https://example.com/a.mp4' }), 'clip'],
    ['an inexact project rate', graph({}, { fps: 12.345 }), 'clip'],
  ])('refuses %s', (_name, value, clipId) => {
    expect(() => transcriptionClipOf(value, clipId)).toThrow(BadRequestException);
  });
});

describe('transcriptionWindow', () => {
  it('covers the timeline length at the clip speed, in exact ffmpeg seconds', () => {
    const window = transcriptionWindow(transcriptionClipOf(graph({ speed: 1.5 }), 'clip'));
    expect(window).toMatchObject({ startSeconds: '3.000000', durationSeconds: '15.000000' });
  });

  it('refuses a clip longer than four hours', () => {
    expect(() =>
      transcriptionWindow(transcriptionClipOf(graph({ durationInFrames: 30 * 4 * 3600 + 1 }), 'clip')),
    ).toThrow(BadRequestException);
  });
});

describe('whisperLanguageOf', () => {
  it.each([
    ['auto', null],
    ['en', 'en'],
    ['pt-BR', 'pt'],
    ['EN-gb', 'en'],
    ['zh-yue', 'yue'],
    ['iw', 'he'],
    ['nb-NO', 'no'],
  ])('%s is %s', (tag, expected) => {
    expect(whisperLanguageOf(tag)).toBe(expected);
  });

  it.each(['english', 'e', '../en', 'en_US', ''])('refuses %s', (tag) => {
    expect(() => whisperLanguageOf(tag)).toThrow(BadRequestException);
  });
});

const word = (start: number, end: number, text: string) => ({ start, end, text });

describe('cueTextsOf', () => {
  it('keeps a short segment whole', () => {
    expect(cueTextsOf({ start: 0, end: 2, text: ' Hello there.', words: [] })).toEqual([
      { start: 0, end: 2, text: 'Hello there.', words: [] },
    ]);
  });

  it('splits a long segment at word boundaries by length and duration', () => {
    const words = Array.from({ length: 30 }, (_, index) => word(index * 0.5, index * 0.5 + 0.4, ` word${index}`));
    const parts = cueTextsOf({ start: 0, end: 15, text: words.map((w) => w.text).join(''), words });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(CUE_MAX_CHARACTERS);
      expect(part.end - part.start).toBeLessThanOrEqual(7);
    }
    expect(parts.flatMap((part) => part.words)).toEqual(words);
  });
});

describe('mapTranscript', () => {
  const clip = transcriptionClipOf(graph({}), 'clip');

  it('offsets cues and words by the clip start, exactly', () => {
    const { cues, words } = mapTranscript(clip, [
      { start: 0, end: 1.5, text: ' Hello there.', words: [word(0, 0.5, ' Hello'), word(0.5, 1.5, ' there.')] },
    ]);
    expect(cues).toEqual([{ start: rational(2), end: rational(7, 2), text: 'Hello there.' }]);
    expect(words).toEqual([
      { start: rational(2), end: rational(5, 2), text: 'Hello', cue: 0 },
      { start: rational(5, 2), end: rational(7, 2), text: 'there.', cue: 0 },
    ]);
  });

  it('divides by the clip speed and keeps NTSC frame starts exact', () => {
    const fast = transcriptionClipOf(graph({ speed: 2, from: 30 }, { fps: 29.97 }), 'clip');
    const { cues } = mapTranscript(fast, [{ start: 1, end: 3, text: 'x', words: [] }]);
    expect(cues[0].start).toEqual(rational(1001 + 500, 1000));
    expect(cues[0].end).toEqual(rational(1001 + 1500, 1000));
  });

  it('clamps to the clip, stretches a cue to one frame and drops cues past the end', () => {
    const { cues } = mapTranscript(clip, [
      { start: 1, end: 1.001, text: 'blink', words: [] },
      { start: 9.5, end: 12, text: 'tail', words: [] },
      { start: 10, end: 11, text: 'after', words: [] },
      { start: 2, end: 3, text: ' '.repeat(3), words: [] },
    ]);
    expect(cues).toEqual([
      { start: rational(3), end: rational(91, 30), text: 'blink' },
      { start: rational(23, 2), end: rational(12), text: 'tail' },
    ]);
  });

  it('removes control characters captions.set refuses', () => {
    const { cues } = mapTranscript(clip, [{ start: 0, end: 1, text: 'a\u{7}b\nc', words: [] }]);
    expect(cues[0].text).toBe('a b c');
  });
});
