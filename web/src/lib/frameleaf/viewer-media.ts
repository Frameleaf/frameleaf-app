/**
 * Media-source classification shared by the Frameleaf viewer (FL-35).
 *
 * Production already decides these things inline in `AssetViewer.svelte` and
 * `asset.service.ts`; this module is the single pure definition both now use, so the
 * navbar's panorama control and the stage's choice of viewer can never disagree.
 */
import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import { ProjectionType } from '$lib/constants';

export const isVideoAsset = (asset: Pick<AssetResponseDto, 'type'>): boolean => asset.type === AssetTypeEnum.Video;

export const isImageAsset = (asset: Pick<AssetResponseDto, 'type'>): boolean => asset.type === AssetTypeEnum.Image;

/**
 * An equirectangular still, or an Insta360 `.insp` frame, which the photo-sphere viewer
 * can look around. Matches the existing condition in `AssetViewer.svelte`.
 */
export const isPanorama = (asset: Pick<AssetResponseDto, 'type' | 'exifInfo' | 'originalPath'>): boolean =>
  isImageAsset(asset) &&
  (asset.exifInfo?.projectionType === ProjectionType.EQUIRECTANGULAR ||
    (asset.originalPath ?? '').toLowerCase().endsWith('.insp'));

/** A still with a paired motion clip the viewer can play in place. */
export const isLivePhoto = (asset: Pick<AssetResponseDto, 'livePhotoVideoId'>): boolean => !!asset.livePhotoVideoId;

/** True when the asset's original file is recorded as missing from its library. */
export const isOffline = (asset: Pick<AssetResponseDto, 'isOffline'>): boolean => asset.isOffline;
