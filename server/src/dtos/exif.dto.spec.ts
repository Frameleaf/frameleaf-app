import { ExifResponseSchema, mapExif } from 'src/dtos/exif.dto.js';
import { AssetExifFactory } from 'test/factories/asset-exif.factory.js';

describe('EXIF response projection', () => {
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
