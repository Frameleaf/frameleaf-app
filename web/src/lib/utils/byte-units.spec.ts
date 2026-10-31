import { ByteUnit, getByteUnitString, getBytesWithUnit } from '$lib/utils/byte-units';

describe('getBytesWithUnit', () => {
  const tests = [
    { bytes: 0, expected: [0, ByteUnit.B] },
    { bytes: 42 + 69, expected: [111, ByteUnit.B] },
    { bytes: 42_000_000, expected: [42, ByteUnit.MB] },
    { bytes: 279_400_000, expected: [279, ByteUnit.MB] },
    // As in the prototype: one decimal under 10, a whole number from 10 up.
    { bytes: 1500, expected: [1.5, ByteUnit.KB] },
    { bytes: 696_600, expected: [697, ByteUnit.KB] },
    { bytes: 62_400_000, expected: [62, ByteUnit.MB] },
    { bytes: 42 + 1337, maxPrecision: 3, expected: [1.379, ByteUnit.KB] },
    // 999,999 bytes would round to "1000 KB"; it moves up to the next unit.
    { bytes: 999_999, expected: [1, ByteUnit.MB] },
    { bytes: 1_000_000_000, expected: [1, ByteUnit.GB] },
    { bytes: 2 ** 30, expected: [1.1, ByteUnit.GB] },
  ];
  for (const { bytes, maxPrecision, expected } of tests) {
    it(`${bytes} should be split up in the factor ${expected[0]} and unit ${expected[1]}`, () => {
      expect(getBytesWithUnit(bytes, maxPrecision)).toEqual(expected);
    });
  }
});

describe('asByteUnitString', () => {
  it('should correctly return string', () => {
    expect(getByteUnitString(42_000_000)).toEqual('42 MB');
  });

  it('never shows a binary unit (D5)', () => {
    expect(getByteUnitString(713_318)).toEqual('713 KB');
    expect(getByteUnitString(4 * 1024 ** 3)).toEqual('4.3 GB');
  });
});
