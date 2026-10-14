import { getByteUnitString as sharedByteString } from '@frameleaf/ui/byte-units';
import { afterEach, expect, it, vi } from 'vitest';
import { ByteUnit, convertFromBytes, convertToBytes, getByteUnitString, getBytesWithUnit } from './byte-units';

afterEach(() => vi.restoreAllMocks());

it.each([
  [ByteUnit.B, 1],
  [ByteUnit.KiB, 1024],
  [ByteUnit.MiB, 1_048_576],
  [ByteUnit.GiB, 1_073_741_824],
  [ByteUnit.TiB, 1_099_511_627_776],
  [ByteUnit.PiB, 1_125_899_906_842_624],
  [ByteUnit.EiB, 1_152_921_504_606_846_976],
] as const)('retains the binary scale for %s', (unit, bytes) => {
  expect(convertToBytes(1, unit)).toBe(bytes);
  expect(convertFromBytes(bytes, unit)).toBe(1);
  expect(convertToBytes(-0, unit)).toBe(-0);
  expect(convertFromBytes(-0, unit)).toBe(-0);
});

it('retains the historical factor for unknown unit values', () => {
  expect(convertToBytes(1024, 'toString' as ByteUnit)).toBe(1);
  expect(convertFromBytes(1, 'unknown' as ByteUnit)).toBe(1024);
});

it('preserves rounding errors and numeric extremes', () => {
  expect(getBytesWithUnit(0.5)).toEqual([512, undefined]);
  expect(getBytesWithUnit(-1)).toEqual([NaN, undefined]);
  expect(getBytesWithUnit(Infinity)).toEqual([NaN, undefined]);
  expect(() => getBytesWithUnit(1024, 101)).toThrow(RangeError);
});

it('retains localized strings and the UI package separator', () => {
  expect(getByteUnitString(1536, 'de-DE')).toBe('1,5 KiB');
  expect(sharedByteString(1536, 'de-DE', 1, '|')).toBe('1,5|KiB');
  expect(() => getByteUnitString(1536, '')).toThrow(RangeError);
});

it('does not recalculate the fixed logarithm per byte conversion', () => {
  const log = vi.spyOn(Math, 'log');
  expect(getBytesWithUnit(1536)).toEqual([1.5, ByteUnit.KiB]);
  expect(log).toHaveBeenCalledExactlyOnceWith(1536);
});
