import { SvelteMap } from 'svelte/reactivity';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';

export type AssetMultiSelectOptions = {
  resetOnNavigate?: boolean;
};
export class AssetMultiSelectManager {
  #selectedMap = new SvelteMap<string, TimelineAsset>();

  selectionActive = $derived(this.#selectedMap.size > 0);

  assets = $derived(Array.from(this.#selectedMap.values()));
  ownedAssets = $derived(
    authManager.authenticated ? this.assets.filter((asset) => asset.ownerId === authManager.user.id) : this.assets,
  );

  constructor(options?: AssetMultiSelectOptions) {
    const { resetOnNavigate = false } = options ?? {};
    if (resetOnNavigate) {
      eventManager.on({ AppNavigate: () => this.clear() });
    }
  }

  hasSelectedAsset(assetId: string) {
    return this.#selectedMap.has(assetId);
  }

  selectAsset(asset: TimelineAsset) {
    this.#selectedMap.set(asset.id, asset);
  }

  selectAssets(assets: TimelineAsset[]) {
    for (const asset of assets) {
      this.selectAsset(asset);
    }
  }

  removeAssetFromMultiselectGroup(assetId: string) {
    this.#selectedMap.delete(assetId);
  }

  clear() {
    this.#selectedMap.clear();
  }
}

export const assetMultiSelectManager = new AssetMultiSelectManager({ resetOnNavigate: true });
