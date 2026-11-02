import sharp from 'sharp';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { Colorspace } from 'src/enum.js';
import { SharpProcessPool } from 'src/queue/sharp-pool.js';

const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };

describe('isolated representative palette decoding', () => {
  let pool: SharpProcessPool;
  beforeEach(() => {
    pool = new SharpProcessPool({ workers: 1, pending: 0, deadlineMs: 10_000 });
  });
  afterEach(async () => {
    await pool.close();
  });
  it('preserves alpha and ignores the transparent background of a logo', async () => {
    const bytes = await sharp(Buffer.from([0, 0, 0, 0, 255, 0, 0, 255]), { raw: { width: 2, height: 1, channels: 4 } })
      .png()
      .toBuffer();
    const result = await pool.run('extractAssetPalette', [bytes, options]);
    expect(result).toEqual({
      swatches: [expect.objectContaining({ hex: '#ff0000', weight: 1 })],
      hasTransparency: true,
    });
  });
  it('keeps a GIF representative frame transparent and bounds panoramic output', async () => {
    const bytes = await sharp(Buffer.from([0, 0, 0, 0, 255, 0, 0, 255]), { raw: { width: 2, height: 1, channels: 4 } })
      .gif()
      .toBuffer();
    expect(await pool.run('extractAssetPalette', [bytes, options])).toEqual({
      swatches: [expect.objectContaining({ hex: '#ff0000', weight: 1 })],
      hasTransparency: true,
    });
    const panorama = await sharp({ create: { width: 2560, height: 16, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    expect((await pool.run('extractAssetPalette', [panorama, options])).swatches).toEqual([
      expect.objectContaining({ hex: '#ff0000', weight: 1 }),
    ]);
  });
  it('decodes a bounded SVG without flattening its transparent canvas', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="8" y="8" width="16" height="16" fill="red"/></svg>',
    );
    expect(await pool.run('extractAssetPalette', [svg, options])).toEqual({
      swatches: [expect.objectContaining({ hex: '#ff0000', weight: 1 })],
      hasTransparency: true,
    });
  });
  it('normalizes equivalent sRGB and Display P3 profiled images', async () => {
    const base = sharp({ create: { width: 16, height: 16, channels: 3, background: '#c06030' } });
    const srgb = await base.clone().withIccProfile('srgb').png().toBuffer();
    const p3 = await base.clone().withIccProfile('p3').png().toBuffer();
    const first = await pool.run('extractAssetPalette', [srgb, options]);
    const second = await pool.run('extractAssetPalette', [p3, options]);
    for (let index = 0; index < 3; index++)
      expect(second.swatches[0].oklab[index]).toBeCloseTo(first.swatches[0].oklab[index], 2);
  });
  it('applies orientation before the current edit crop', async () => {
    const rgba = Buffer.from(
      Array.from({ length: 8 }, (_, i) => (i % 4 < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255])).flat(),
    );
    const input = await sharp(rgba, { raw: { width: 4, height: 2, channels: 4 } })
      .png()
      .toBuffer();
    const result = await pool.run('extractAssetPalette', [
      input,
      {
        ...options,
        orientation: 6,
        edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 2, height: 2 } }],
      },
    ]);
    expect(result.swatches).toEqual([expect.objectContaining({ hex: '#ff0000', weight: 1 })]);
  });
  it('rejects corrupt and oversized sources within the existing child budget', async () => {
    await expect(pool.run('extractAssetPalette', [Buffer.from('corrupt'), options])).rejects.toThrow();
    await pool.close();
    pool = new SharpProcessPool({ workers: 1, pending: 0, maxPixels: 64, maxBytes: 4096 });
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await expect(pool.run('extractAssetPalette', [bytes, options])).rejects.toThrow(/pixel|budget|limit/i);
  });
});
