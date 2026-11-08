import { AssetTypeEnum } from '@frameleaf/sdk';
import { ProjectionType } from '$lib/constants';
import {
  isImageAsset,
  isLivePhoto,
  isOffline,
  isPanorama,
  isPanoramaVideoProjection,
  isStitchedVideoProjection,
  isVideoAsset,
} from '$lib/frameleaf/viewer-media';
import { assetFactory } from '@test-data/factories/asset-factory';

describe('viewer media classification', () => {
  it('separates images from video', () => {
    const image = assetFactory.build({ type: AssetTypeEnum.Image });
    const video = assetFactory.build({ type: AssetTypeEnum.Video });

    expect(isImageAsset(image)).toBe(true);
    expect(isVideoAsset(image)).toBe(false);
    expect(isVideoAsset(video)).toBe(true);
    expect(isImageAsset(video)).toBe(false);
  });

  describe('isPanorama', () => {
    it('accepts an equirectangular still', () => {
      const asset = assetFactory.build({
        type: AssetTypeEnum.Image,
        exifInfo: { projectionType: ProjectionType.EQUIRECTANGULAR },
      });
      expect(isPanorama(asset)).toBe(true);
    });

    it('accepts an Insta360 .insp frame regardless of case', () => {
      expect(isPanorama(assetFactory.build({ type: AssetTypeEnum.Image, originalPath: '/library/a.insp' }))).toBe(true);
      expect(isPanorama(assetFactory.build({ type: AssetTypeEnum.Image, originalPath: '/library/A.INSP' }))).toBe(true);
    });

    it('rejects an ordinary still and any video', () => {
      expect(isPanorama(assetFactory.build({ type: AssetTypeEnum.Image, originalPath: '/library/a.jpg' }))).toBe(false);
      expect(
        isPanorama(
          assetFactory.build({
            type: AssetTypeEnum.Video,
            exifInfo: { projectionType: ProjectionType.EQUIRECTANGULAR },
          }),
        ),
      ).toBe(false);
    });
  });

  describe('360° video (FL-968)', () => {
    it.each([
      [ProjectionType.EQUIRECTANGULAR, true, false],
      [ProjectionType.DUAL_FISHEYE, true, true],
      [ProjectionType.EQUIANGULAR_CUBEMAP, true, true],
      [ProjectionType.CUBEMAP, false, false],
      [ProjectionType.NONE, false, false],
      [null, false, false],
      [undefined, false, false],
    ])('classifies %s', (projectionType, panorama, stitched) => {
      expect(isPanoramaVideoProjection(projectionType)).toBe(panorama);
      expect(isStitchedVideoProjection(projectionType)).toBe(stitched);
    });
  });

  it('reports a paired motion clip', () => {
    expect(isLivePhoto(assetFactory.build({ livePhotoVideoId: 'motion-id' }))).toBe(true);
    expect(isLivePhoto(assetFactory.build({ livePhotoVideoId: null }))).toBe(false);
  });

  it('reports a missing original', () => {
    expect(isOffline(assetFactory.build({ isOffline: true }))).toBe(true);
    expect(isOffline(assetFactory.build({ isOffline: false }))).toBe(false);
  });
});
