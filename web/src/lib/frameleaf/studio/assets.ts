/**
 * Turning library assets into the media the React editor may see (FL-88).
 *
 * The engine gets no SDK, no token and no API base URL. It gets this projection: a name, a
 * duration and three URLs the host already authorized with the session's own credentials.
 * That is what makes FL-96's rule — no client API dependency inside the editor — a property
 * of the boundary rather than a convention the engine is asked to observe.
 *
 * The projection is also where the library's privacy rules are enforced for Studio:
 *
 * - Locked assets never cross the boundary. The Locked space needs its own elevated
 *   session, and an editor timeline is not that session. Filtering is not the security
 *   boundary (the server still checks every read), but nothing should ever be handed over
 *   that the person did not unlock for this purpose.
 * - Trashed assets are excluded: a timeline must not reference media that is on its way out.
 * - Only images and video can go on a timeline; audio and other types are dropped rather
 *   than shown as something that cannot be placed.
 * - Offline originals are passed through but flagged, so the bin can show them and the
 *   engine can refuse to cut with them, rather than the person finding a broken clip later.
 */

import { AssetMediaSize, AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
import type { StudioAssetRef } from './host-contract';

/** Whether an asset may be offered to the editor at all. */
export const isStudioEligibleAsset = (asset: AssetResponseDto): boolean =>
  !asset.isTrashed &&
  asset.visibility !== AssetVisibility.Locked &&
  (asset.type === AssetTypeEnum.Image || asset.type === AssetTypeEnum.Video);

export const toStudioAsset = (asset: AssetResponseDto): StudioAssetRef => {
  const isVideo = asset.type === AssetTypeEnum.Video;
  const cacheKey = asset.thumbhash;

  return {
    id: asset.id,
    kind: isVideo ? 'video' : 'image',
    name: asset.originalFileName,
    // The DTO carries milliseconds; the timeline works in seconds.
    durationSeconds: isVideo && asset.duration !== null ? asset.duration / 1000 : null,
    thumbnailUrl: getAssetMediaUrl({ id: asset.id, cacheKey, size: AssetMediaSize.Thumbnail }),
    previewUrl: getAssetMediaUrl({ id: asset.id, cacheKey, size: AssetMediaSize.Preview }),
    playbackUrl: isVideo ? getAssetPlaybackUrl({ id: asset.id, cacheKey }) : null,
    isOffline: asset.isOffline,
  };
};

/**
 * Project a list, keeping the caller's order. A "make a movie" handoff arrives in the order
 * the person selected, and that order is the editor's starting cut, so it must not be
 * re-sorted here.
 */
export const toStudioAssets = (assets: readonly AssetResponseDto[]): StudioAssetRef[] =>
  assets.filter((asset) => isStudioEligibleAsset(asset)).map((asset) => toStudioAsset(asset));
