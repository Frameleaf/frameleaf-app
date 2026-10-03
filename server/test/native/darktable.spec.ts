import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { encodeNativeDevelopOutput, renderDarktable } from 'src/utils/darktable-renderer.js';

it('develops an actual RAW through pinned darktable, changes EV, and preserves the original', async () => {
  const original = resolve('../e2e/test-assets/formats/raw/Canon/EOS_70D.CR2');
  const checksum = createHash('sha256')
    .update(await readFile(original))
    .digest('hex');
  const recipe = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0 };
  const baseline = await renderDarktable(original, recipe);
  const brighter = await renderDarktable(original, { ...recipe, exposureEV: 1 });
  const repeated = await renderDarktable(original, recipe);
  const metadata = await sharp(baseline).metadata();
  expect(metadata.bitsPerSample).toBe(16);
  expect(metadata.icc).toBeDefined();
  expect(Math.max(metadata.width!, metadata.height!)).toBeGreaterThan(4000);
  expect(await sharp(repeated).raw().toBuffer()).toEqual(await sharp(baseline).raw().toBuffer());
  const before = await sharp(baseline).stats();
  const after = await sharp(brighter).stats();
  expect(after.channels[0].mean + after.channels[1].mean + after.channels[2].mean).toBeGreaterThan(
    before.channels[0].mean + before.channels[1].mean + before.channels[2].mean,
  );

  const options = { format: 'jpeg' as const, quality: 92 };
  const master = await encodeNativeDevelopOutput(brighter, options);
  const preview = await encodeNativeDevelopOutput(brighter, { ...options, size: 640 });
  expect((await sharp(master!).metadata()).width).toBe(metadata.width);
  const previewMetadata = await sharp(preview!).metadata();
  expect(Math.max(previewMetadata.width!, previewMetadata.height!)).toBe(640);
  expect(
    createHash('sha256')
      .update(await readFile(original))
      .digest('hex'),
  ).toBe(checksum);
});

it('qualifies full native controls and sensor masks after crop, straighten and rotation', async () => {
  const original = resolve('../e2e/test-assets/formats/raw/Canon/EOS_70D.CR2');
  const base = { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0 };
  const baseline = await renderDarktable(original, base);
  const developed = await renderDarktable(original, {
    ...base,
    whiteBalance: { red: 1.1, green: 1, blue: 0.9 },
    shadows: 20,
    highlights: -20,
    saturation: 1.1,
    contrast: 1.05,
    curve: [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.55 },
      { x: 1, y: 1 },
    ],
    noiseThreshold: 0.01,
    sharpen: { radius: 2, amount: 0.5, threshold: 0.5 },
    crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    rotation: 90,
    straighten: 1,
    masks: [
      { id: 'radial', kind: 'radial', x: 0.5, y: 0.5, coordinates: 'sensor-active', adjustments: { exposureEV: 0.7 } },
    ],
  });
  expect(await sharp(developed).raw().toBuffer()).not.toEqual(await sharp(baseline).raw().toBuffer());
  const metadata = await sharp(developed).metadata();
  expect(metadata.bitsPerSample).toBe(16);
  expect(metadata.icc).toBeDefined();
  expect(metadata.height).toBeGreaterThan(metadata.width!);
  expect(metadata.width).toBeLessThan((await sharp(baseline).metadata()).height!);
});
