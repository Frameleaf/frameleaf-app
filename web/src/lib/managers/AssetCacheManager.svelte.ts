import { getAssetInfo, getAssetOcr, getFaces } from '@immich/sdk';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

const defaultSerializer = <K>(params: K) => JSON.stringify(params);

class AsyncCache<K, V> {
  #cache = new Map<string, V>();
  #generation = 0;
  #keyGenerations = new Map<string, number>();

  constructor(private fetcher: (params: K) => Promise<V>) {}

  async getOrFetch(params: K, updateCache: boolean): Promise<V> {
    const cacheKey = defaultSerializer(params);

    const cached = this.#cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const generation = this.#generation;
    const keyGeneration = this.#keyGenerations.get(cacheKey);
    let value: V;
    try {
      value = await this.fetcher(params);
    } catch (error) {
      if (generation !== this.#generation || keyGeneration !== this.#keyGenerations.get(cacheKey)) {
        throw new DOMException('Asset cache invalidated', 'AbortError');
      }
      throw error;
    }
    if (generation !== this.#generation || keyGeneration !== this.#keyGenerations.get(cacheKey)) {
      throw new DOMException('Asset cache invalidated', 'AbortError');
    }
    if (value && updateCache) {
      this.#cache.set(cacheKey, value);
    }

    return value;
  }

  clearKey(params: K) {
    const cacheKey = defaultSerializer(params);
    this.#cache.delete(cacheKey);
    this.#keyGenerations.set(cacheKey, (this.#keyGenerations.get(cacheKey) ?? 0) + 1);
  }

  /** `revoke` also rejects fetches still in flight: their answers belong to the old access boundary. */
  clear(revoke = false) {
    if (revoke) {
      this.#generation++;
      this.#keyGenerations.clear();
    }
    this.#cache.clear();
  }
}

class AssetCacheManager {
  #assetCache = new AsyncCache(getAssetInfo);
  #ocrCache = new AsyncCache(getAssetOcr);
  #faceCache = new AsyncCache(getFaces);

  constructor() {
    onLibraryAccessChange(() => this.revoke());
    eventManager.on({
      AssetEditsApplied: (assetId) => {
        this.invalidateAsset(assetId);
      },
      AssetUpdate: (asset) => {
        this.invalidateAsset(asset.id);
      },
    });
  }

  async getAsset({ id, key, slug }: { id: string; key?: string; slug?: string }, updateCache = true) {
    return this.#assetCache.getOrFetch({ id, key, slug }, updateCache);
  }

  async getAssetOcr(id: string) {
    return this.#ocrCache.getOrFetch({ id }, true);
  }

  async getAssetFaces(id: string) {
    return this.#faceCache.getOrFetch({ id }, true);
  }

  invalidateAsset(id: string) {
    const { key, slug } = authManager.params;
    this.#assetCache.clearKey({ id, key, slug });
    this.#ocrCache.clearKey({ id });
    this.#faceCache.clearKey({ id });
  }

  clearAssetCache() {
    this.#assetCache.clear();
  }

  clearOcrCache() {
    this.#ocrCache.clear();
  }

  clearFaceCache() {
    this.#faceCache.clear();
  }

  /** Drops cached answers; fetches in flight still resolve (a data refresh, not an access change). */
  invalidate() {
    this.clearAssetCache();
    this.clearOcrCache();
    this.clearFaceCache();
  }

  /** An access boundary (lock, account switch): drops cached answers and rejects fetches in flight. */
  revoke() {
    this.#assetCache.clear(true);
    this.#ocrCache.clear(true);
    this.#faceCache.clear(true);
  }
}

export const assetCacheManager = new AssetCacheManager();
