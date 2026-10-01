import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Colorspace, ImageFormat } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { type RawImageInfo } from 'src/types.js';
import { renderDarktable } from 'src/utils/darktable-renderer.js';

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

  const media = new MediaRepository({ setContext: () => {} } as unknown as LoggingRepository);
  const decoded = await media.decodeImage(brighter, { colorspace: Colorspace.Srgb, processInvalidImages: false });
  const options = {
    detail: { median: 0 as const },
    colorspace: Colorspace.Srgb,
    format: ImageFormat.Jpeg,
    quality: 92,
  };
  const master = await media.encodeDevelopOutput(decoded.data, decoded.info as RawImageInfo, options);
  const preview = await media.encodeDevelopOutput(decoded.data, decoded.info as RawImageInfo, {
    ...options,
    size: 640,
  });
  expect((await sharp(master!).metadata()).width).toBe(decoded.info.width);
  const previewMetadata = await sharp(preview!).metadata();
  expect(Math.max(previewMetadata.width!, previewMetadata.height!)).toBe(640);
  expect(
    createHash('sha256')
      .update(await readFile(original))
      .digest('hex'),
  ).toBe(checksum);
});
