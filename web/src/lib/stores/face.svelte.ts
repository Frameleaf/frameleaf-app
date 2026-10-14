import { getFaces, type AssetFaceResponseDto, type PersonResponseDto } from '@frameleaf/sdk';
import { SvelteMap } from 'svelte/reactivity';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';

class FaceManager {
  #data = $state<AssetFaceResponseDto[]>([]);
  /** FL-38: faces the asset's owner hid; listed only for the owner, behind "Show hidden". */
  #hiddenFaces = $state<AssetFaceResponseDto[]>([]);
  #hiddenRequest: AbortController | undefined;
  #loading: Promise<void> | undefined;
  #generation = 0;

  readonly people = $derived.by(() => {
    const people = new Map<string, PersonResponseDto>();

    for (const face of this.data) {
      if (face.person) {
        people.set(face.person.id, face.person);
      }
    }

    return Array.from(people.values());
  });

  readonly facesByPersonId = $derived.by(() => {
    const map = new SvelteMap<string, AssetFaceResponseDto[]>();
    for (const face of this.data) {
      if (!face.person) {
        continue;
      }
      const existing = map.get(face.person.id);
      if (existing) {
        existing.push(face);
      } else {
        map.set(face.person.id, [face]);
      }
    }
    return map;
  });

  get data() {
    return this.#data;
  }

  get hiddenFaces() {
    return this.#hiddenFaces;
  }

  constructor() {
    // Hidden reads bypass the shared cache, so retire them at the same access boundaries.
    onLibraryAccessChange(() => this.#clearHidden());
  }

  /** Owner only: the server refuses `withHidden` to anyone else. */
  async loadHiddenFaces(assetId: string) {
    const previous = this.#hiddenRequest;
    const request = new AbortController();
    this.#hiddenRequest = request;
    previous?.abort();
    try {
      if (this.#hiddenRequest !== request) {
        return;
      }
      const faces = await getFaces({ id: assetId, withHidden: true }, { signal: request.signal });
      if (this.#hiddenRequest === request && !request.signal.aborted) {
        this.#hiddenFaces = faces.filter((face) => !!face.hiddenAt);
      }
    } catch {
      if (this.#hiddenRequest === request && !request.signal.aborted) {
        this.#hiddenFaces = [];
      }
    } finally {
      if (this.#hiddenRequest === request) {
        this.#hiddenRequest = undefined;
      }
    }
  }

  async getAssetFaces(id: string) {
    if (this.#loading) {
      await this.#loading;
      return;
    }
    const generation = this.#generation;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    this.#loading = pending;
    try {
      const faces = await assetCacheManager.getAssetFaces(id);
      if (generation === this.#generation && this.#loading === pending) {
        this.#data = faces;
      }
    } catch {
      if (generation === this.#generation && this.#loading === pending) {
        this.#loading = undefined;
      }
    } finally {
      resolve();
    }
  }

  clear() {
    this.#generation++;
    this.#loading = undefined;
    assetCacheManager.clearFaceCache();
    this.#data = [];
    this.#clearHidden();
  }

  #clearHidden() {
    const request = this.#hiddenRequest;
    this.#hiddenRequest = undefined;
    this.#hiddenFaces = [];
    request?.abort();
  }
}

export const faceManager = new FaceManager();
