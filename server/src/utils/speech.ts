import type { TranscriptSegment } from 'src/repositories/machine-learning.repository.js';

export const SPEECH_INDEX_VERSION = 1;
export type SpeechWord = { text: string; startMs: number; endMs: number };
export type SpeechChunk = { startMs: number; endMs: number; coreStartMs: number; coreEndMs: number };
export type SpeechWindow = { tokens: string[]; words: SpeechWord[]; vector: string; startMs: number; endMs: number };

const lexicalRuns = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
// Unspaced scripts must not inherit the ASR worker's arbitrary word segmentation.
const runTokens = (run: string) =>
  run.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu,
  ) ?? [];
const tokens = (text: string) => lexicalRuns(text).flatMap((run) => runTokens(run));
const quote = (text: string) => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
export const speechTsQuery = (phrase: string[]) => phrase.map((term) => quote(term)).join(' <-> ');

export function speechQuery(query: string): string[][] {
  query = query.normalize('NFKC').replaceAll(/[“”]/g, '"');
  if (!query.trim() || query.length > 4096 || (query.match(/"/g)?.length ?? 0) % 2) {
    throw new Error('Enter words or a complete quoted phrase');
  }
  const clauses: string[][] = [];
  for (const part of query.matchAll(/"([^"]*)"|([^"\s]+)/g)) {
    const terms = tokens(part[1] ?? part[2]);
    if (part[1] !== undefined) {
      if (terms.length === 0) throw new Error('A phrase must contain words');
      clauses.push(terms);
    } else {
      clauses.push(...lexicalRuns(part[2]).map((run) => runTokens(run)));
    }
  }
  if (
    clauses.length === 0 ||
    clauses.flat().length > 64 ||
    clauses.flat().some((term) => Buffer.byteLength(term) > 2046)
  ) {
    throw new Error('Search accepts between 1 and 64 words');
  }
  return clauses;
}

export function* speechChunks(durationMs: number, startChunk = 0): Generator<SpeechChunk> {
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error('Invalid media duration');
  for (let coreStartMs = startChunk * 300_000; coreStartMs < durationMs; coreStartMs += 300_000) {
    const coreEndMs = Math.min(durationMs, coreStartMs + 300_000);
    yield {
      startMs: Math.max(0, coreStartMs - 2000),
      coreStartMs,
      coreEndMs,
      endMs: Math.min(durationMs, coreEndMs + 2000),
    };
  }
}

export function speechWords(
  segments: TranscriptSegment[],
  chunk: Pick<SpeechChunk, 'startMs' | 'coreStartMs' | 'coreEndMs'>,
): SpeechWord[] {
  const result: SpeechWord[] = [];
  for (const segment of segments) {
    if (segment.text.trim() && segment.words.length === 0) throw new Error('The worker omitted word timestamps');
    for (const word of segment.words) {
      const startMs = chunk.startMs + Math.round(word.start * 1000);
      const endMs = chunk.startMs + Math.round(word.end * 1000);
      if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs < startMs || startMs < 0) {
        throw new Error('Invalid speech timestamp');
      }
      // The midpoint owns words in the audio overlap; the original time remains unchanged.
      const midpoint = (startMs + endMs) / 2;
      if (midpoint >= chunk.coreStartMs && midpoint < chunk.coreEndMs && word.text.trim()) {
        result.push({ text: word.text, startMs, endMs });
      }
    }
  }
  return result.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function speechWindows(words: SpeechWord[]): SpeechWindow[] {
  const all = words.flatMap((word) => tokens(word.text).map((token) => ({ token, word })));
  const windows: SpeechWindow[] = [];
  for (let offset = 0; offset < all.length; offset += 64) {
    const slice = all.slice(offset, offset + 128);
    const positions = new Map<string, number[]>();
    for (const [index, { token }] of slice.entries()) {
      if (Buffer.byteLength(token) > 2046) throw new Error('The worker sent an oversized speech word');
      positions.set(token, [...(positions.get(token) ?? []), index + 1]);
    }
    windows.push({
      tokens: slice.map(({ token }) => token),
      words: slice.map(({ word }) => word),
      vector: [...positions].map(([token, indexes]) => `${quote(token)}:${indexes.join(',')}`).join(' '),
      startMs: slice[0].word.startMs,
      endMs: slice.at(-1)!.word.endMs,
    });
    if (offset + 128 >= all.length) break;
  }
  return windows;
}

export function speechTail(words: SpeechWord[]): SpeechWord[] {
  // Punctuation-only output must neither grow checkpoints nor displace lexical phrase overlap.
  return words.filter((word) => tokens(word.text).length > 0).slice(-64);
}

export function speechExcerpt(words: SpeechWord[]): string {
  const unique = words.filter(
    (word, index) =>
      index === 0 ||
      word.startMs !== words[index - 1].startMs ||
      word.endMs !== words[index - 1].endMs ||
      word.text !== words[index - 1].text,
  );
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  let text = '';
  for (const word of unique) {
    const last = [...text].at(-1) ?? '',
      first = [...word.text][0] ?? '';
    const separator =
      /[\p{L}\p{N}]/u.test(last) && /[\p{L}\p{N}]/u.test(first) && !(cjk.test(last) && cjk.test(first)) ? ' ' : '';
    text += separator + word.text;
  }
  return text.trim();
}

export function speechHits(window: Pick<SpeechWindow, 'tokens' | 'words'>, clauses: string[][]): SpeechWord[] {
  const hits: SpeechWord[] = [];
  for (const clause of clauses) {
    for (let start = 0; start <= window.tokens.length - clause.length; start++) {
      if (clause.some((token, index) => window.tokens[start + index] !== token)) continue;
      const end = start + clause.length;
      const context = window.words.slice(Math.max(0, start - 6), Math.min(window.words.length, end + 6));
      const text = speechExcerpt(context);
      hits.push({ text, startMs: window.words[start].startMs, endMs: window.words[end - 1].endMs });
    }
  }
  return hits;
}
