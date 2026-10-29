import { describe, expect, it } from 'vitest';
import { speechChunks, speechExcerpt, speechQuery, speechTail, speechWindows, speechWords } from 'src/utils/speech.js';

describe('spoken words indexing', () => {
  it('treats punctuation as literal word boundaries and preserves quoted phrase adjacency', () => {
    expect(speechQuery('HELLO "co-op déjà vu" !cat')).toEqual([['hello'], ['co', 'op', 'déjà', 'vu'], ['cat']]);
    expect(() => speechQuery('"unfinished')).toThrow();
    expect(() => speechQuery(Array.from({ length: 65 }, () => 'a').join(' '))).toThrow();
  });

  it('keeps repeated and late phrase positions bounded without losing boundary phrases', () => {
    const words = Array.from({ length: 17_000 }, (_, i) => ({
      text: i === 16_447 ? 'late' : i === 16_448 ? 'phrase' : 'again',
      startMs: i * 100,
      endMs: i * 100 + 90,
    }));
    const windows = speechWindows(words);
    expect(windows.some((w) => w.tokens.some((t, i) => t === 'late' && w.tokens[i + 1] === 'phrase'))).toBe(true);
    expect(windows.every((w) => w.tokens.length <= 128)).toBe(true);
    expect(windows.at(-1)?.endMs).toBe(1_699_990);
    expect(windows[0].vector).toContain("'again':1,2,3");
  });

  it('offsets and owns overlapping audio words once on original timestamps', () => {
    expect(
      speechWords(
        [
          {
            start: 0,
            end: 4,
            text: 'old new',
            words: [
              { start: 0.5, end: 1.5, text: 'old' },
              { start: 2, end: 3, text: ' new' },
            ],
            type: 'segment',
          },
        ],
        { startMs: 298_000, coreStartMs: 300_000, coreEndMs: 600_000 },
      ),
    ).toEqual([{ text: ' new', startMs: 300_000, endMs: 301_000 }]);
  });

  it('chunks long media and rejects invalid timestamps instead of indexing false seek positions', () => {
    expect([...speechChunks(601_000)]).toEqual([
      { startMs: 0, coreStartMs: 0, coreEndMs: 300_000, endMs: 302_000 },
      { startMs: 298_000, coreStartMs: 300_000, coreEndMs: 600_000, endMs: 601_000 },
      { startMs: 598_000, coreStartMs: 600_000, coreEndMs: 601_000, endMs: 601_000 },
    ]);
    expect(() =>
      speechWords([{ type: 'segment', start: 0, end: 3, text: 'bad', words: [{ start: 3, end: 2, text: 'bad' }] }], {
        startMs: 0,
        coreStartMs: 0,
        coreEndMs: 3000,
      }),
    ).toThrow();
  });
});

it('keeps native smart quotes as phrases and unspaced CJK independent of ASR word segmentation', () => {
  expect(speechQuery('“my fellow americans”')).toEqual([['my', 'fellow', 'americans']]);
});
it('matches unspaced CJK independently of ASR word boundaries', () => {
  expect(speechQuery('北京')).toEqual([['北', '京']]);
  expect(speechWindows([{ text: '北京', startMs: 0, endMs: 200 }])[0].tokens).toEqual(
    speechWindows([
      { text: '北', startMs: 0, endMs: 100 },
      { text: '京', startMs: 100, endMs: 200 },
    ])[0].tokens,
  );
});

it('formats natural excerpts using original spacing and unspaced CJK fragments', () => {
  expect(
    speechExcerpt([
      { text: ' Hello', startMs: 0, endMs: 10 },
      { text: '  world!', startMs: 20, endMs: 30 },
    ]),
  ).toBe('Hello  world!');
  expect(
    speechExcerpt([
      { text: '北', startMs: 0, endMs: 10 },
      { text: '京', startMs: 20, endMs: 30 },
    ]),
  ).toBe('北京');
});

it('starts an extreme-duration recording without allocating all chunk descriptors', () => {
  expect(typeof speechChunks(1).next).toBe('function');
  const chunks = speechChunks(Number.MAX_SAFE_INTEGER);
  expect(chunks.next().value).toMatchObject({ coreStartMs: 0, coreEndMs: 300_000 });
});

it('keeps combining marks within a literal lexical run and recognizes fullwidth phrase quotes', () => {
  expect(speechQuery('नमस्ते')).toEqual([['नमस्ते']]);
});
it('recognizes fullwidth phrase quotes before splitting clauses', () => {
  expect(speechQuery('＂hello world＂')).toEqual([['hello', 'world']]);
});

it('bounds checkpoint overlap even when a worker emits only punctuation', () => {
  expect(speechTail(Array.from({ length: 1000 }, () => ({ text: '.', startMs: 0, endMs: 1 })))).toEqual([]);
});
