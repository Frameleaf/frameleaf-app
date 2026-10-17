import { SvelteMap } from 'svelte/reactivity';
import { authManager } from '$lib/managers/auth-manager.svelte';

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
const unresolvedDevelop = Symbol('unresolved develop revision');
const developRevisions = new SvelteMap<string, string | null | typeof unresolvedDevelop>();

/** The current rendered photo version read from the authenticated develop API. */
export const setDevelopPlaybackRevision = (assetId: string, revisionId: string | null) => {
  developRevisions.set(assetId, revisionId);
};

/** A failed lookup cannot prove whether the server has a current develop version. */
export const markDevelopPlaybackUnresolved = (assetId: string) => {
  developRevisions.set(assetId, unresolvedDevelop);
};

export const bumpPlaybackRevision = (assetId: string) => {
  revisions.set(assetId, (revisions.get(assetId) ?? 0) + 1);
};

export const getPlaybackRevision = (assetId: string) => revisions.get(assetId) ?? 0;

const canUseDevelopPlayback = (asset: { ownerId?: string }) =>
  authManager.authenticated && !authManager.isSharedLink && asset.ownerId === authManager.user.id;

export const currentDevelopPlaybackRevision = (asset: { id: string; ownerId?: string }) => {
  const revision = canUseDevelopPlayback(asset) ? developRevisions.get(asset.id) : null;
  return typeof revision === 'string' ? revision : null;
};

/** Current or unresolved versions must use the media route, which selects matching pixels. */
export const mayHaveDevelopPlaybackRevision = (asset: { id: string; ownerId?: string }) => {
  const revision = canUseDevelopPlayback(asset) ? developRevisions.get(asset.id) : null;
  return revision !== null && revision !== undefined;
};

/** The cache key for URLs whose file follows the playback choice: the thumbhash, plus the revision once bumped. */
export const playbackCacheKey = (asset: { id: string; ownerId?: string; thumbhash?: string | null }) => {
  const revision = getPlaybackRevision(asset.id);
  const developRevision = currentDevelopPlaybackRevision(asset);
  const key = revision > 0 ? `${asset.thumbhash ?? ''}-${revision}` : (asset.thumbhash ?? null);
  return developRevision ? `${key ?? ''}-develop-${developRevision}` : key;
};

/** Test helper: forget every revision. */
export const resetPlaybackRevisions = () => {
  revisions.clear();
  developRevisions.clear();
};
