// Hosted-only regression. Supply an existing genuine DNG fixture; never download or render cameras locally.
import { exiftool } from 'exiftool-vendored';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { defaults } from 'src/dtos/config.dto.js';
import { Colorspace } from 'src/enum.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MediaService } from 'src/services/media.service.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { getMocks, newTestService } from 'test/utils.js';

// This opt-in test is additional orientation/source proof, not a camera support matrix.
describe.runIf(process.env.FRAMELEAF_RAW_NATIVE === '1')('real RAW sensor viewing', () => {
  it('applies DNG orientation once, reads the sensor with extraction enabled and preserves originals', async () => {
    const fixture = process.env.FRAMELEAF_RAW_DNG_FIXTURE;
    if (!fixture || !fixture.toLowerCase().endsWith('.dng')) {
      throw new Error('FRAMELEAF_RAW_DNG_FIXTURE must name an existing genuine DNG fixture');
    }
    const checksum = async (path: string) =>
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    const beforeFixture = await checksum(fixture);
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-raw-orientation-'));
    try {
      const normal = join(directory, 'normal.DNG');
      const rotated = join(directory, 'rotated.DNG');
      // Only disposable copies receive test metadata. The genuine source is always read-only.
      await copyFile(fixture, normal);
      await copyFile(fixture, rotated);
      await exiftool.write(normal, {}, { writeArgs: ['-Orientation#=1', '-overwrite_original'] });
      await exiftool.write(rotated, {}, { writeArgs: ['-Orientation#=6', '-overwrite_original'] });
      const beforeCopies = await Promise.all([checksum(normal), checksum(rotated)]);
      const mocks = getMocks();
      const media = new MediaRepository(mocks.logger as never);
      const extract = vi.spyOn(media, 'extract');
      const { sut } = newTestService(MediaService, { media });
      const image = {
        ...defaults.image,
        fullsize: { ...defaults.image.fullsize, enabled: true },
        extractEmbedded: true,
        enhancedRaw: { enabled: false },
      };
      const source = (path: string, orientation: string) =>
        getForGenerateThumbnail(
          AssetFactory.from({
            originalFileName: 'photo.DNG',
            originalPath: path,
          })
            .exif({ orientation, colorspace: 'sRGB' })
            .build(),
        );
      const outputs = (prefix: string) => ({
        thumbnail: { path: join(directory, `${prefix}-thumbnail.${image.thumbnail.format}`), options: image.thumbnail },
        preview: { path: join(directory, `${prefix}-preview.${image.preview.format}`), options: image.preview },
        fullsize: { path: join(directory, `${prefix}-fullsize.${image.fullsize.format}`), options: image.fullsize },
      });
      const baselineOutputs = outputs('normal');
      const rotatedOutputs = outputs('rotated');
      const baseline = await sut['extractOriginalImage'](source(normal, '1'), image, false, baselineOutputs);
      const result = await sut['extractOriginalImage'](source(rotated, '6'), image, false, rotatedOutputs);
      expect(extract).not.toHaveBeenCalled();
      expect(result.convertFullsize).toBe(true);
      expect(result.info.width).toBe(baseline.info.height);
      expect(result.info.height).toBe(baseline.info.width);
      // Non-square genuine pixels expose both a missing rotation and an accidental second rotation.
      expect(baseline.info.width).not.toBe(baseline.info.height);
      // The batch retains raw pixels in its child. Build the independent once-rotated oracle
      // from the normal sensor render, then compare the actual files and thumbhash it produced.
      const decode = { colorspace: Colorspace.Srgb, processInvalidImages: false };
      const normalPixels = await media.decodeImage(await renderRawWithLibRaw(normal), decode);
      const expected = await sharp(normalPixels.data, { raw: normalPixels.info })
        .rotate(90)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const expectedOptions = { ...decode, raw: expected.info };
      expect(result.thumbhash).toEqual(await media.generateThumbhash(expected.data, expectedOptions));
      for (const [name, output] of Object.entries(rotatedOutputs)) {
        const expectedPath = join(directory, `expected-${name}.${output.options.format}`);
        await media.generateThumbnail(expected.data, { ...output.options, ...expectedOptions }, expectedPath);
        expect(await readFile(output.path)).toEqual(await readFile(expectedPath));
      }
      expect(result).not.toHaveProperty('data');
      expect(await Promise.all([checksum(normal), checksum(rotated)])).toEqual(beforeCopies);
      expect(await checksum(fixture)).toBe(beforeFixture);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 300_000);
});
