import { asHumanReadable } from 'src/utils/bytes.js';

describe('asHumanReadable', () => {
  it.each([
    [0, '0 B'],
    [-0, '0 B'],
    [-1024, '-1024 B'],
    [1023.5, '1024 B'],
    [1024, '1.0 KiB'],
    [1024 ** 2, '1.0 MiB'],
    [1024 ** 6, '1.0 EiB'],
    [1024 ** 7, '1024.0 EiB'],
    [NaN, 'NaN B'],
    [Infinity, 'Infinity EiB'],
  ] as const)('formats %s as %s', (bytes, expected) => {
    expect(asHumanReadable(bytes)).toBe(expected);
  });

  it('only applies precision after entering a scaled unit', () => {
    expect(asHumanReadable(1.5, -1)).toBe('2 B');
    expect(asHumanReadable(1536, 0)).toBe('2 KiB');
    expect(asHumanReadable(1536, 3)).toBe('1.500 KiB');
    expect(() => asHumanReadable(1024, -1)).toThrow(RangeError);
    expect(() => asHumanReadable(1024, 101)).toThrow(RangeError);
  });
});
