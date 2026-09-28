import { SvelteMap } from 'svelte/reactivity';

/**
 * FL-115: "Use for playback" changes the file that an asset's video playback, photo preview and
 * photo full-size URLs serve, without changing the asset's thumbhash. Those URLs were cached by the
 * browser (a day plus stale-while-revalidate) before any restoration existed, so after a choice the
 * viewer needs a fresh cache key or it keeps showing the old version.
 *
 * Each asset id carries a revision that is bumped whenever the owner's playback choice (or a saved
 * edit) may have changed what those URLs serve. Thumbnails keep the plain thumbhash key because the
 * server never replaces them.
 */
const revisions = new SvelteMap<string, number>();

export const bumpPlaybackRevision = (assetId: string) => {
  revisions.set(assetId, (revisions.get(assetId) ?? 0) + 1);
};

export const getPlaybackRevision = (assetId: string) => revisions.get(assetId) ?? 0;

/** The cache key for URLs whose file follows the playback choice: the thumbhash, plus the revision once bumped. */
export const playbackCacheKey = (asset: { id: string; thumbhash?: string | null }) => {
  const revision = getPlaybackRevision(asset.id);
  return revision > 0 ? `${asset.thumbhash ?? ''}-${revision}` : (asset.thumbhash ?? null);
};

/** Test helper: forget every revision. */
export const resetPlaybackRevisions = () => {
  revisions.clear();
};
