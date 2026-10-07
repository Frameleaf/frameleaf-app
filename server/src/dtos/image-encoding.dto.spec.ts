import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { ImageEncodingSchema } from 'src/dtos/image-encoding.dto.js';
import { AssetFileType, AssetType } from 'src/enum.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForAsset } from 'test/mappers.js';

it('keeps unprocessed encoding unknown instead of inventing SDR or reference white', () => {
  const result = mapAsset(getForAsset(AssetFactory.create()));
  expect(result.imageEncoding).toEqual({ dynamicRange: 'unknown', gainMap: 'none', reconstructionAvailable: false });
});

it('keeps technical HDR information when private EXIF is stripped', () => {
  const encoding = ImageEncodingSchema.parse({
    dynamicRange: 'hdr',
    gainMap: 'apple-legacy',
    reconstructionAvailable: false,
    fallbackReason: 'apple-gain-map-interpretation-unqualified',
    GPSLatitude: 49,
    originalPath: '/private/source.heic',
  });
  const asset = AssetFactory.from().exif({ imageEncoding: encoding, latitude: 49 }).build();
  const result = mapAsset(getForAsset(asset), { stripMetadata: true });
  expect(result.imageEncoding).toEqual(encoding);
  expect(result.exifInfo).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('/private/');
  expect(JSON.stringify(result)).not.toContain('GPSLatitude');
  expect(result.imageEncoding?.reconstructionAvailable).toBe(false);
});

it('does not infer still-image encoding for Live Photo motion or other video', () => {
  expect(mapAsset(getForAsset(AssetFactory.create({ type: AssetType.Video }))).imageEncoding).toBeUndefined();
});

it('reports only available current HDR derivatives without exposing their identity or path', () => {
  vi.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
  try {
    const asset = AssetFactory.from({ isEdited: true })
      .file({ type: AssetFileType.HdrPreview, isEdited: false, renditionIdentity: 'aa'.repeat(32) })
      .file({ type: AssetFileType.HdrFullSize, isEdited: true, renditionIdentity: 'bb'.repeat(32) })
      .build();
    const result = mapAsset({ ...asset, hasCurrentDevelop: false }, { stripMetadata: true });
    expect(result.imageRenditions).toEqual({
      sdrPreview: false,
      sdrFullsize: false,
      hdrPreview: false,
      hdrFullsize: true,
    });
    expect(JSON.stringify(result)).not.toContain('bb'.repeat(32));
    vi.stubEnv('FRAMELEAF_HDR_IMAGES', '');
    expect(mapAsset({ ...asset, hasCurrentDevelop: false }).imageRenditions?.hdrFullsize).toBe(false);
    expect(mapAsset({ ...asset, hasCurrentDevelop: true }).imageRenditions).toBeUndefined();
    expect(mapAsset(asset).imageRenditions).toBeUndefined();
  } finally {
    vi.unstubAllEnvs();
  }
});

it('leaves rendition availability unknown when file evidence was not loaded', () => {
  const asset = AssetFactory.create();
  expect(mapAsset({ ...asset, files: undefined }).imageRenditions).toBeUndefined();
});
