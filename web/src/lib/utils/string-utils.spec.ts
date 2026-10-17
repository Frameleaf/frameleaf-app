import { afterEach, expect, it, vi } from 'vitest';
import { normalizeSearchString, removeAccents, splitSearchMatch } from './string-utils';

afterEach(() => vi.restoreAllMocks());

it.each(['', 'Album 123', '\0\t\r\n~'])('preserves ASCII %j without Unicode work', (value) => {
  const normalize = vi.spyOn(String.prototype, 'normalize');
  const replace = vi.spyOn(String.prototype, 'replaceAll');
  expect(removeAccents(value)).toBe(value);
  expect(normalize).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it.each([
  ['Café Ångström', 'Cafe Angstrom'],
  ['e\u{301}\u{323}', 'e'],
  ['가', '\u{1100}\u{1161}'],
  ['\u{1AB0}', '\u{1AB0}'],
])('retains Unicode normalization for %j', (input, expected) => {
  expect(removeAccents(input)).toBe(expected);
});

it('keeps locale casing, whitespace trimming and accent removal in their existing order', () => {
  expect(normalizeSearchString('  CAFÉ\u{A0}')).toBe('cafe');
  expect(normalizeSearchString(' \u{130} ')).toBe('i');
});

it('retains boxed-string normalization and invalid-input errors', () => {
  const input = new Object('Café') as { normalize: (form: string) => string };
  const normalize = vi.spyOn(input, 'normalize');
  expect(removeAccents(input as unknown as string)).toBe('Cafe');
  expect(normalize).toHaveBeenCalledExactlyOnceWith('NFD');
  expect(normalize.mock.contexts).toEqual([input]);
  expect(() => removeAccents(null as unknown as string)).toThrow(TypeError);
  expect(() => removeAccents(undefined as unknown as string)).toThrow(TypeError);
});

it.each([
  ['  Summer trip  ', '  trip  ', ['  Summer ', 'trip', '  ']],
  ['Cafe\u{301} trip', 'café', ['', 'Cafe\u{301}', ' trip']],
  ['가족 여행', '여행', ['가족 ', '여행', '']],
  ['가족', '\u{1161}', ['', '가', '족']],
  ['ΟΣ trip', 'ος', ['', 'ΟΣ', ' trip']],
  ['İstanbul', 'istan', ['', 'İstan', 'bul']],
  ['👩‍👩‍👧‍👦 trip', '👧', ['', '👩‍👩‍👧‍👦', ' trip']],
  ['First first', 'first', ['', 'First', ' first']],
  ['Album', 'missing', ['Album', '', '']],
  ['Album', ' '.repeat(3), ['Album', '', '']],
])('highlights the original graphemes in %j for %j', (value, query, expected) => {
  const parts = splitSearchMatch(value, query);
  expect(parts).toEqual(expected);
  expect(parts.join('')).toBe(value);
});

it.each([
  ['tr', 'IŞIK İstanbul', 'ışık', ['', 'IŞIK', ' İstanbul']],
  ['lt', 'I\u{301} trip', 'i', ['', 'I\u{301}', ' trip']],
  ['el', 'ΟΣ trip', 'ος', ['', 'ΟΣ', ' trip']],
])('maps original offsets with %s locale casing', (locale, value, query, expected) => {
  const lower = String.prototype.toLocaleLowerCase;
  vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
    return lower.call(this, locale);
  });
  expect(splitSearchMatch(value, query)).toEqual(expected);
});
