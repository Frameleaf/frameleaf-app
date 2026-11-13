import assert from 'node:assert/strict';
import sharp from 'sharp';

// Supplementary oracle: Sharp ICC-to-sRGB/Lanczos3; Lab D65 and CIE76, never Sharp's Lab D50.
async function labD65(input: Buffer) {
  const { data, info } = await sharp(input)
    .withIccProfile('srgb')
    .removeAlpha()
    .resize(384, 256, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  const values: number[][] = [];
  const f = (value: number) => (value > (6 / 29) ** 3 ? Math.cbrt(value) : value / (3 * (6 / 29) ** 2) + 4 / 29);
  for (let index = 0; index < data.length; index += 3) {
    const [r, g, b] = [...data.subarray(index, index + 3)].map((byte) => {
      const value = byte / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    values.push([116 * y - 16, 500 * (x - y), 200 * (y - z)]);
  }
  return values;
}

export async function nativeMeanDeltaE76(reference: Buffer, rendered: Buffer) {
  const [expected, actual] = await Promise.all([labD65(reference), labD65(rendered)]);
  const delta = actual.map((value, index) => Math.hypot(...value.map((channel, c) => channel - expected[index][c])));
  const sorted = delta.toSorted((a, b) => a - b);
  return {
    mean: delta.reduce((sum, value) => sum + value, 0) / delta.length,
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)],
  };
}
