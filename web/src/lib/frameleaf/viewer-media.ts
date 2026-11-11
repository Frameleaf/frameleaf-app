/**
 * Media-source classification shared by the Frameleaf viewer (FL-35).
 *
 * Production already decides these things inline in `AssetViewer.svelte` and
 * `asset.service.ts`; this module is the single pure definition both now use, so the
 * navbar's panorama control and the stage's choice of viewer can never disagree.
 */
import { AssetTypeEnum, type AssetResponseDto } from '@frameleaf/sdk';
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

/**
 * FL-968: raw 360° video layouts. The server stitches them into an equirectangular playback copy,
 * so they play in the panorama viewer, but their original file is not itself equirectangular.
 */
export const isStitchedVideoProjection = (projectionType: string | null | undefined): boolean =>
  projectionType === ProjectionType.DUAL_FISHEYE || projectionType === ProjectionType.EQUIANGULAR_CUBEMAP;

/** A video the panorama viewer can look around: equirectangular, or a raw 360° layout played stitched. */
export const isPanoramaVideoProjection = (projectionType: string | null | undefined): boolean =>
  projectionType === ProjectionType.EQUIRECTANGULAR || isStitchedVideoProjection(projectionType);

/**
 * FL-1392 (UI review 2026-11-10, B6): on a phone the viewer has one bottom bar, the actions. The
 * footer under it stays only for what the "…" menu does not offer: a video's Original / Optimized
 * switch and its zoom row, and a panorama's look-around switch. A photo's Play, slideshow settings
 * and filmstrip are in "…", and its zoom is a pinch or a double tap.
 */
export const keepsPhoneFooter = (asset: Pick<AssetResponseDto, 'type' | 'exifInfo' | 'originalPath'>): boolean =>
  isVideoAsset(asset) || isPanorama(asset);

/** A still with a paired motion clip the viewer can play in place. */
export const isLivePhoto = (asset: Pick<AssetResponseDto, 'livePhotoVideoId'>): boolean => !!asset.livePhotoVideoId;

/** True when the asset's original file is recorded as missing from its library. */
export const isOffline = (asset: Pick<AssetResponseDto, 'isOffline'>): boolean => asset.isOffline;
