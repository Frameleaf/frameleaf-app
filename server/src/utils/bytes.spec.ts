import { asHumanReadable } from 'src/utils/bytes.js';

describe('asHumanReadable', () => {
  // D5: decimal units, never KiB
  it.each([
    [0, '0 B'],
    [-0, '0 B'],
    [-1000, '-1000 B'],
    [999.5, '1000 B'],
    [1000, '1.0 KB'],
    [1024, '1.0 KB'],
    [1000 ** 2, '1.0 MB'],
    [4 * 1024 ** 3, '4.3 GB'],
    [1000 ** 6, '1.0 EB'],
    [1000 ** 7, '1000.0 EB'],
    [NaN, 'NaN B'],
    [Infinity, 'Infinity EB'],
  ] as const)('formats %s as %s', (bytes, expected) => {
    expect(asHumanReadable(bytes)).toBe(expected);
  });

  it('only applies precision after entering a scaled unit', () => {
    expect(asHumanReadable(1.5, -1)).toBe('2 B');
    expect(asHumanReadable(1500, 0)).toBe('2 KB');
    expect(asHumanReadable(1500, 3)).toBe('1.500 KB');
    expect(() => asHumanReadable(1000, -1)).toThrow(RangeError);
    expect(() => asHumanReadable(1000, 101)).toThrow(RangeError);
  });
});
