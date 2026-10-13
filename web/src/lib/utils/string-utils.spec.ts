import { afterEach, expect, it, vi } from 'vitest';
import { normalizeSearchString, removeAccents } from './string-utils';

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
