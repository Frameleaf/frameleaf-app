import { extractPalette, rgbToOklab } from 'src/utils/asset-palette.js';

const pixels = (...values: number[][]) => Uint8Array.from(values.flat());

describe('bounded representative palette', () => {
  it.each([
    [
      [1, 0, 0],
      [0.62795536, 0.22486306, 0.1258463],
    ],
    [
      [0, 1, 0],
      [0.86643961, -0.23388757, 0.17949848],
    ],
    [
      [0, 0, 1],
      [0.45201372, -0.03245698, -0.31152815],
    ],
    [
      [1, 1, 1],
      [1, 0, 0],
    ],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  ])('matches fixed CSS Color 4 sRGB conversion vectors for %j', (rgb, expected) => {
    const actual = rgbToOklab(rgb[0], rgb[1], rgb[2]);
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, 5);
  });

  it('keeps pure red exact with its visible-area weight', () => {
    expect(extractPalette(pixels([255, 0, 0, 255]), 1, 1)).toEqual([
      { hex: '#ff0000', weight: 1, oklab: rgbToOklab(1, 0, 0) },
    ]);
  });
  it('ignores transparent black around a logo and weights partial alpha', () => {
    const palette = extractPalette(pixels([0, 0, 0, 0], [255, 0, 0, 255], [0, 0, 255, 85]), 3, 1);
    expect(palette.map(({ hex, weight }) => ({ hex, weight }))).toEqual([
      { hex: '#ff0000', weight: 0.75 },
      { hex: '#0000ff', weight: 0.25 },
    ]);
    expect(extractPalette(pixels([0, 0, 0, 0]), 1, 1)).toEqual([]);
  });
  it('merges nearby buckets and breaks equal-weight ties in RGB order', () => {
    expect(
      extractPalette(pixels([255, 0, 0, 255], [248, 0, 0, 255]), 2, 1).map(({ hex, weight }) => ({ hex, weight })),
    ).toEqual([{ hex: '#fc0000', weight: 1 }]);
    const a = pixels([255, 0, 0, 255], [0, 0, 255, 255]);
    const b = pixels([0, 0, 255, 255], [255, 0, 0, 255]);
    expect(extractPalette(a, 2, 1)).toEqual(extractPalette(b, 2, 1));
    expect(extractPalette(a, 2, 1)[0].hex).toBe('#0000ff');
  });
  it('handles accumulated fractional alpha without generating out-of-range channels', () => {
    const rgba = Uint8Array.from(Array.from({ length: 512 }, () => [255, 0, 0, 1]).flat());
    expect(extractPalette(rgba, 256, 2)).toEqual([{ hex: '#ff0000', weight: 1, oklab: rgbToOklab(1, 0, 0) }]);
  });
  it('rejects malformed or oversized decoded surfaces and non-normalized channels', () => {
    for (const [w, h] of [
      [0, 1],
      [257, 1],
      [1.5, 1],
      [256, 257],
    ]) {
      expect(() => extractPalette(new Uint8Array(4), w, h)).toThrow();
    }
    expect(() => extractPalette(new Uint8Array(3), 1, 1)).toThrow();
    for (const value of [NaN, Infinity, -0.1, 1.1]) expect(() => rgbToOklab(value, 0, 0)).toThrow();
  });
  it('retains at most eight reproducible swatches on a full-size representative surface', () => {
    const rgba = Uint8Array.from({ length: 256 * 256 * 4 }, (_, index) => (index % 4 === 3 ? 255 : (index * 37) % 256));
    const result = extractPalette(rgba, 256, 256);
    expect(result.length).toBeLessThanOrEqual(8);
    expect(result).toEqual(extractPalette(rgba, 256, 256));
    expect(result.every(({ weight }) => weight > 0 && weight <= 1)).toBe(true);
  });
});
