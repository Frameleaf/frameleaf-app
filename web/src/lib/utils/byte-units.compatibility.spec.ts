import { getByteUnitString as sharedByteString } from '@frameleaf/ui/byte-units';
import { afterEach, expect, it, vi } from 'vitest';
import { ByteUnit, convertFromBytes, convertToBytes, getByteUnitString, getBytesWithUnit } from './byte-units';

afterEach(() => vi.restoreAllMocks());

// D5 (owner, 2026-10-16): sizes are decimal everywhere, never KiB.
it.each([
  [ByteUnit.B, 1],
  [ByteUnit.KB, 1000],
  [ByteUnit.MB, 1_000_000],
  [ByteUnit.GB, 1_000_000_000],
  [ByteUnit.TB, 1_000_000_000_000],
  [ByteUnit.PB, 1_000_000_000_000_000],
  [ByteUnit.EB, 1_000_000_000_000_000_000],
] as const)('uses the decimal scale for %s', (unit, bytes) => {
  expect(convertToBytes(1, unit)).toBe(bytes);
  expect(convertFromBytes(bytes, unit)).toBe(1);
  expect(convertToBytes(-0, unit)).toBe(-0);
  expect(convertFromBytes(-0, unit)).toBe(-0);
});

it('never names a binary unit', () => {
  expect(Object.values(ByteUnit).some((unit) => unit.includes('i'))).toBe(false);
});

it('keeps a fixed factor for unknown unit values', () => {
  expect(convertToBytes(1000, 'toString' as ByteUnit)).toBe(1);
  expect(convertFromBytes(1, 'unknown' as ByteUnit)).toBe(1000);
});

it('handles numeric extremes', () => {
  expect(getBytesWithUnit(-1)).toEqual([-1, ByteUnit.B]);
  expect(getBytesWithUnit(Infinity)).toEqual([NaN, undefined]);
  expect(() => getBytesWithUnit(1024, 101)).toThrow(RangeError);
});

it('retains localized strings and the UI package separator', () => {
  expect(getByteUnitString(1500, 'de-DE')).toBe('1,5 KB');
  expect(sharedByteString(1500, 'de-DE', 1, '|')).toBe('1,5|KB');
  expect(() => getByteUnitString(1500, '')).toThrow(RangeError);
});

it('does not recalculate the fixed logarithm per byte conversion', () => {
  const log = vi.spyOn(Math, 'log');
  expect(getBytesWithUnit(1500)).toEqual([1.5, ByteUnit.KB]);
  expect(log).toHaveBeenCalledExactlyOnceWith(1500);
});
