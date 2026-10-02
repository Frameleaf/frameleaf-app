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
      rating: -1,
    });
  });
  it('keeps unavailable technical facts nullable and accepts rejection', () => {
    expect(ExifResponseSchema.parse({ rating: -1 })).toMatchObject({
      rating: -1,
      bitsPerSample: null,
      colorspace: null,
      profileDescription: null,
    });
    expect(ExifResponseSchema.safeParse({ rating: -2 }).success).toBe(false);
    expect(ExifResponseSchema.safeParse({ rating: 0 }).success).toBe(false);
  });
});
