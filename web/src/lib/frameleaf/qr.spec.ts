import { describe, expect, it } from 'vitest';
import { byteCapacity, encodeQr, qrPath, qrSize, selectVersion } from './qr';

describe('qr encoder', () => {
  it('encodes a short shared-link URL into a valid symbol', () => {
    const symbol = encodeQr('https://frameleaf.local/s/summer-trip');
    expect(symbol.ecc).toBe('M');
    expect(symbol.size).toBe(qrSize(symbol.version));
    expect(symbol.modules).toHaveLength(symbol.size);
    for (const row of symbol.modules) {
      expect(row).toHaveLength(symbol.size);
    }
    // A well formed symbol always draws its three finder patterns as dark.
    expect(symbol.modules[0][0]).toBe(true);
    expect(symbol.modules[0][symbol.size - 1]).toBe(true);
    expect(symbol.modules[symbol.size - 1][0]).toBe(true);
  });

  it('selects a larger version as the payload grows', () => {
    const short = encodeQr('short');
    const long = encodeQr('a'.repeat(200));
    expect(long.version).toBeGreaterThan(short.version);
  });

  it('throws when the text exceeds the version 10 capacity', () => {
    expect(() => encodeQr('x'.repeat(byteCapacity(10, 'M') + 1))).toThrow(RangeError);
  });

  it('returns null from selectVersion once no version fits', () => {
    expect(selectVersion(byteCapacity(10, 'M') + 1, 'M')).toBeNull();
  });

  it('builds an SVG path with one command group per dark module', () => {
    const symbol = encodeQr('hi');
    let dark = 0;
    for (const row of symbol.modules) {
      for (const cell of row) {
        if (cell) {
          dark++;
        }
      }
    }
    const path = qrPath(symbol.modules, 4);
    expect(path.match(/z/g)).toHaveLength(dark);
    // Quiet zone offsets every coordinate by 4 modules.
    expect(path.startsWith('M')).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const a = encodeQr('https://frameleaf.local/s/rockies-2026');
    const b = encodeQr('https://frameleaf.local/s/rockies-2026');
    expect(a).toEqual(b);
  });
});
