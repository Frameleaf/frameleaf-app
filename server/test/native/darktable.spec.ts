import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { encodeNativeDevelopOutput, renderDarktable, renderDarktableHistory } from 'src/utils/darktable-renderer.js';
import { readNativeHistory } from 'src/utils/develop-import/native-history.js';
import { readDevelopXmp } from 'src/utils/develop-import/xmp.js';
import { nativeMeanDeltaE76 } from 'test/native/deltae.js';

it.each([
  ['canon', 'Canon/EOS_70D.CR2', '2928f74fac36110319d2fc4f6849ff6181f6c401ff162dc8a8dea782d4cc3fcf'],
  ['nikon', 'Nikon/D80/glarus.nef', 'fe9f0880136d438b881ee5f44b88d84402091c24b12431160298c0353c311f4b'],
  ['canon-repeated', 'Canon/EOS_70D.CR2', '1d0a26a042952dc67723f3eaed97f62e59aba364350cee910be5140ee3cf3bd7'],
])(
  'replays genuine %s XMP within mean CIE76 DeltaE <6 of its independent native reference',
  async (camera, file, referenceHash) => {
    const original = resolve(`../e2e/test-assets/formats/raw/${file}`);
    const before = createHash('sha256')
      .update(await readFile(original))
      .digest('hex');
    const fixture = resolve(`test/fixtures/develop-import/darktable-native-${camera}.xmp`);
    const reference = await readFile(resolve(`test/fixtures/develop-import/${camera}-native-reference.jpg`));
    expect(createHash('sha256').update(reference).digest('hex')).toBe(referenceHash);
    const output = await renderDarktableHistory(original, readNativeHistory(readDevelopXmp(await readFile(fixture))));
    expect((await sharp(output).metadata()).bitsPerSample).toBe(16);
    const rendered = await encodeNativeDevelopOutput(output, { format: 'jpeg', quality: 100, size: 1536 });
    const { mean } = await nativeMeanDeltaE76(reference, rendered!);
    expect(mean).toBeLessThan(6);
    expect(
      createHash('sha256')
        .update(await readFile(original))
        .digest('hex'),
    ).toBe(before);
  },
);

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
