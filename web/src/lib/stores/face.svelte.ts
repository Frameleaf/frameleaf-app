import { getFaces, type AssetFaceResponseDto, type PersonResponseDto } from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import type { Faces } from '$lib/managers/asset-viewer-manager.svelte';
import { CancellableTask } from '$lib/utils/cancellable-task';

class FaceManager {
  #data = $state<AssetFaceResponseDto[]>([]);
  /** FL-38: faces the asset's owner hid; listed only for the owner, behind "Show hidden". */
  #hiddenFaces = $state<AssetFaceResponseDto[]>([]);
  #hiddenFor: string | null = null;
  #faceLoader = new CancellableTask();
  #cleared = false;

  readonly faceNames = $derived.by(() => {
    const map = new Map<Faces, string>();

    for (const face of this.data) {
      if (!face.person) {
        continue;
      }
      map.set(face, face.person.name);
    }

    return map;
  });

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
    for (const face of faceManager.data) {
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

  /** Owner only: the server refuses `withHidden` to anyone else. */
  async loadHiddenFaces(assetId: string) {
    this.#hiddenFor = assetId;
    try {
      const faces = await getFaces({ id: assetId, withHidden: true });
      if (this.#hiddenFor === assetId) {
        this.#hiddenFaces = faces.filter((face) => !!face.hiddenAt);
      }
    } catch {
      if (this.#hiddenFor === assetId) {
        this.#hiddenFaces = [];
      }
    }
  }

  async getAssetFaces(id: string) {
    if (this.#cleared) {
      await this.#faceLoader.reset();
      this.#cleared = false;
    }
    await this.#faceLoader.execute(async () => {
      this.#data = await assetCacheManager.getAssetFaces(id);
    }, false);
  }

  clear() {
    this.#cleared = true;
    assetCacheManager.clearFaceCache();
    this.#data = [];
    this.#hiddenFaces = [];
    this.#hiddenFor = null;
  }
}

export const faceManager = new FaceManager();
