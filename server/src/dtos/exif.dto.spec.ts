import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { ExifResponseSchema, mapExif } from 'src/dtos/exif.dto.js';
import { AssetExifFactory } from 'test/factories/asset-exif.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAsset } from 'test/mappers.js';

describe('EXIF response projection', () => {
  it('retains zero size in full asset metadata and excludes EXIF from stripped responses', () => {
    const asset = getForAsset(AssetFactory.from().exif({ fileSizeInByte: 0 }).build());
    expect(mapAsset(asset).exifInfo?.fileSizeInByte).toBe(0);
    expect(mapAsset(asset, { stripMetadata: true }).exifInfo).toBeUndefined();
  });

  it.each([
    [0, 0],
    ['0', 0],
    [1, 1],
    ['4096', 4096],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [null, null],
    [undefined, null],
  ])('preserves a stored file size of %s as %s', (fileSizeInByte, expected) => {
    const entity = {
      ...AssetExifFactory.create(),
      fileSizeInByte,
    } as unknown as Parameters<typeof mapExif>[0];
    expect(ExifResponseSchema.parse(mapExif(entity)).fileSizeInByte).toBe(expected);
  });

  it('projects stored color facts and rejected rating without claiming HDR', () => {
    const projected = mapExif(
      AssetExifFactory.create({
        bitsPerSample: 12,
        colorspace: 'Uncalibrated',
        profileDescription: 'Display P3',
        rating: -1,
      }),
    );
    expect(ExifResponseSchema.parse(projected)).toMatchObject({
      bitsPerSample: 12,
      colorspace: 'Uncalibrated',
      profileDescription: 'Display P3',
      rating: null,
      isRejected: true,
    });
  });
  it('keeps the legacy response rating range positive or null', () => {
    expect(ExifResponseSchema.parse({ rating: null })).toMatchObject({
      rating: null,
      isRejected: null,
      bitsPerSample: null,
      colorspace: null,
      profileDescription: null,
    });
    for (const rating of [-2, -1, 0, 6]) {
      expect(ExifResponseSchema.safeParse({ rating }).success).toBe(false);
    }
  });
  it.each([null, 1, 2, 3, 4, 5])('projects non-rejected stored rating %s unchanged', (rating) => {
    expect(ExifResponseSchema.parse(mapExif(AssetExifFactory.create({ rating })))).toMatchObject({
      rating,
      isRejected: false,
    });
  });
});
