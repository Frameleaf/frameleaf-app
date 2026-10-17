import { tokenizeForSearch } from 'src/utils/database.js';

it.each([
  ['', []],
  [' \t\n\0', []],
  ['one\ttwo\nthree', ['one', 'two', 'three']],
  ['日本語', ['日本', '本語']],
  ['あいう', ['あい', 'いう']],
  ['アイウ', ['アイ', 'イウ']],
  ['한국어', ['한국', '국어']],
  ['㐀㐁', ['㐀㐁']],
  ['ABC漢字東京DEF', ['ABC', '漢字', '字東', '東京', 'DEF']],
  ['漢A字', ['漢', 'A', '字']],
  ['漢😀字', ['漢', '😀', '字']],
  ['A\u{A0}B', ['A\u{A0}B']],
  ['\u{D800}漢\u{DFFF}', ['\u{D800}', '漢', '\u{DFFF}']],
] as const)('retains stored-search token semantics for %j', (text, expected) => {
  expect(tokenizeForSearch(text)).toEqual(expected);
});

it.each(['one_long_word', '日本語漢字'])('inspects each code unit once within a run: %s', (text) => {
  const reads = vi.spyOn(String.prototype, 'charCodeAt');
  try {
    tokenizeForSearch(text);
    expect(reads).toHaveBeenCalledTimes(text.length);
  } finally {
    reads.mockRestore();
  }
});
