/**
 * Turning library assets into the media the React editor may see (FL-88).
 *
 * The engine gets no SDK, no token and no API base URL. It gets this projection: a name, a
 * duration and three URLs the host already authorized with the session's own credentials.
 * That keeps FL-96's rule — no client API dependency inside the editor — explicit in the
 * contract. It is a convention the pinned engine follows, not an enforced boundary: the editor
 * runs same-origin with the session's cookies, and the server authorizes every request itself.
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
import {
  AssetMediaSize,
  AssetRestorationFileKind,
  AssetRestorationSourceType,
  AssetTypeEnum,
  type AssetResponseDto,
  type StudioRestoredVersionDto,
} from '@frameleaf/sdk';
import { restorationFileUrl } from '$lib/frameleaf/restoration';
import { actsAsRegular } from '$lib/frameleaf/session-access.svelte';
import { getAssetMediaUrl, getAssetPlaybackUrl, getStudioHdrVideoUrl } from '$lib/utils';
import type { StudioAssetRef } from './host-contract';
import { fromMilliseconds } from './rational-time';

/** Whether an asset may be offered to the editor at all. */
export const isStudioEligibleAsset = (asset: AssetResponseDto): boolean =>
  !asset.isTrashed &&
  // FL-195: the owner's revealed marks and detections place like any other item while unlocked
  actsAsRegular(asset) &&
  (asset.type === AssetTypeEnum.Image || asset.type === AssetTypeEnum.Video);

export const toStudioAsset = (asset: AssetResponseDto): StudioAssetRef => {
  const isVideo = asset.type === AssetTypeEnum.Video;
  const cacheKey = asset.thumbhash;

  return {
    id: asset.id,
    kind: isVideo ? 'video' : 'image',
    name: asset.originalFileName,
    // FL-93: the DTO carries whole milliseconds and the timeline works in seconds, but the
    // conversion is exact rather than a division — 12500 ms is 25/2 s, and 1 ms is 1/1000 s
    // instead of a float that is already wrong before anything is placed on a track.
    duration: isVideo && asset.duration !== null ? fromMilliseconds(asset.duration) : null,
    thumbnailUrl: getAssetMediaUrl({ id: asset.id, cacheKey, size: AssetMediaSize.Thumbnail }),
    previewUrl: getAssetMediaUrl({ id: asset.id, cacheKey, size: AssetMediaSize.Preview }),
    playbackUrl: isVideo ? getAssetPlaybackUrl({ id: asset.id, cacheKey }) : null,
    isOffline: asset.isOffline,
    width: asset.width ?? null,
    height: asset.height ?? null,
    mimeType: asset.originalMimeType ?? null,
  };
};

/**
 * FL-97: mark the assets the server reported as HDR originals (`resources.hdrSources`), and hand
 * the engine the HDR intermediate of those that have one (`resources.hdrProxySources`).
 */
export const withHdrSources = (
  assets: readonly StudioAssetRef[],
  hdrSources: readonly string[] | null | undefined,
  hdrProxySources?: readonly string[] | null,
): StudioAssetRef[] => {
  const hdr = new Set(hdrSources);
  const proxies = new Set(hdrProxySources);
  return assets.map((asset) =>
    hdr.has(asset.id)
      ? {
          ...asset,
          hdr: true,
          ...(proxies.has(asset.id) && { hdrSourceUrl: getStudioHdrVideoUrl(asset.id) }),
        }
      : asset,
  );
};

/**
 * Project a list, keeping the caller's order. A "make a movie" handoff arrives in the order
 * the person selected, and that order is the editor's starting cut, so it must not be
 * re-sorted here.
 */
export const toStudioAssets = (assets: readonly AssetResponseDto[]): StudioAssetRef[] =>
  assets.filter((asset) => isStudioEligibleAsset(asset)).map((asset) => toStudioAsset(asset));

/**
 * An accepted AI restoration the person chose with Use in Studio (FL-115), as a bin entry of its own.
 *
 * Its id is the server's `mediaId` (`restored-<restoration id>`), so a clip of it carries exactly that
 * into the graph and the server resolves it as the restored version: never as the original, and never
 * because the original's playback choice happens to point at it. The pixels come from the restoration
 * file endpoint, which applies the same owner-only rules; the thumbnail is the original's, because a
 * restoration has none of its own.
 */
export const toStudioRestoredAsset = (version: StudioRestoredVersionDto, name: string): StudioAssetRef => {
  const isVideo = version.sourceType === AssetRestorationSourceType.Video;
  const cacheKey = version.restoredAt;
  const file = (kind: AssetRestorationFileKind) =>
    restorationFileUrl(version.assetId, version.restorationId, kind, cacheKey);
  return {
    id: version.mediaId,
    kind: isVideo ? 'video' : 'image',
    name,
    duration:
      isVideo && version.durationSeconds !== null ? fromMilliseconds(Math.round(version.durationSeconds * 1000)) : null,
    thumbnailUrl: getAssetMediaUrl({ id: version.assetId, size: AssetMediaSize.Thumbnail }),
    previewUrl: isVideo
      ? getAssetMediaUrl({ id: version.assetId, size: AssetMediaSize.Preview })
      : file(AssetRestorationFileKind.ResultPreview),
    playbackUrl: isVideo ? file(AssetRestorationFileKind.Result) : null,
    // A version that can no longer be placed is flagged like an offline original: the bin shows it and
    // the engine refuses to cut with it, rather than quietly playing the original in its place.
    isOffline: !version.available,
    width: version.width,
    height: version.height,
    mimeType: isVideo ? 'video/mp4' : null,
  };
};

const RESTORED_MEDIA_ID = /^restored-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const RESTORATION_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The restoration a bin media id names, or null for anything else (a library asset's own id). */
export const restorationIdOfMedia = (mediaId: string): string | null =>
  RESTORED_MEDIA_ID.test(mediaId) ? mediaId.slice('restored-'.length) : null;

/**
 * Every restored version a stored project places (FL-115), so a reopened project brings them back into
 * the bin, and one that was discarded or expired is reported instead of silently missing. It reads the
 * same keys the server's resolver does: `mediaId` / `assetId` with the `restored-` prefix, and
 * `restorationId`. Bounded, like the resolver's walk.
 */
export const restoredVersionIdsIn = (graph: unknown, limit = 200): string[] => {
  const found = new Set<string>();
  const stack: { node: unknown; depth: number }[] = [{ node: graph, depth: 0 }];
  while (stack.length > 0 && found.size < limit) {
    const { node, depth } = stack.pop()!;
    if (depth > 64 || !node || typeof node !== 'object') {
      continue;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push({ node: item, depth: depth + 1 });
      }
      continue;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') {
        const id =
          key === 'mediaId' || key === 'assetId'
            ? restorationIdOfMedia(value)
            : key === 'restorationId' && RESTORATION_ID.test(value)
              ? value
              : null;
        if (id) {
          found.add(id.toLowerCase());
        }
      } else {
        stack.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return [...found];
};

/** Ordinary library references in a stored graph; generated/restored media use other resolvers. */
export const libraryAssetIdsIn = (graph: unknown): string[] => {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const stack = [{ node: graph, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > 64 || !node || typeof node !== 'object' || seen.has(node)) {
      continue;
    }
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === 'assetId' || key === 'mediaId') &&
        typeof value === 'string' &&
        /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)
      ) {
        ids.add(value.toLowerCase());
      } else if (value && typeof value === 'object') {
        stack.push({ node: value, depth: depth + 1 });
      }
    }
  }
  return [...ids];
};

/** Normal caller reads, with bounded concurrency and the existing Studio privacy projection. */
export const resolveStudioAssets = async (
  ids: readonly string[],
  lookup: (id: string) => Promise<AssetResponseDto>,
): Promise<AssetResponseDto[]> => {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
  const found: AssetResponseDto[] = [];
  for (let at = 0; at < wanted.length; at += 8) {
    const batch = wanted.slice(at, at + 8);
    const results = await Promise.allSettled(batch.map((id) => lookup(id)));
    for (const [index, result] of results.entries()) {
      if (
        result.status === 'fulfilled' &&
        result.value.id.toLowerCase() === batch[index] &&
        isStudioEligibleAsset(result.value)
      ) {
        found.push(result.value);
      }
    }
  }
  return found;
};
