import {
  type AssetResponseDto,
  MemorySearchOrder,
  deleteMemory,
  type MemoryResponseDto,
  removeMemoryAssets,
  searchMemories,
  updateAsset,
  updateMemory,
  memoriesStatistics,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { isEqual, omitBy } from 'lodash-es';
import { DateTime } from 'luxon';
import { t } from 'svelte-i18n';
import { SvelteMap } from 'svelte/reactivity';
import { fromStore, get } from 'svelte/store';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { QueryParameter } from '$lib/constants';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { userPreferencesManager } from '$lib/managers/user-preferences-manager.svelte';
import { Route } from '$lib/route';
import { memoryLaneTitle } from '$lib/utils';
import { toTimelineAsset } from '$lib/utils/timeline-util';

type MemoriesSearchDto = Parameters<typeof searchMemories>[0];

type AdjacentMemory = {
  href: string;
  assetId: string;
  title: string;
};

/** Everything the memory viewer renders, for the position currently in the url. */
export type MemoryState = {
  memory: MemoryResponseDto;
  asset: TimelineAsset;
  /** The assets the asset viewer can navigate through, spanning the adjacent memories. */
  viewerAssets: AssetResponseDto[];
  previousMemory?: AdjacentMemory;
  nextMemory?: AdjacentMemory;
  previousHref?: string;
  nextHref?: string;
  getAssetHref: (assetId: string) => string | undefined;
};

class MemoryManager {
  #loading = $state<Promise<void>>();
  #filters = $state<MemoriesSearchDto>({ size: 250, order: MemorySearchOrder.Desc });
  #hasNextPage: boolean = true;
  #page: number = 1;
  #total: number | undefined = $state();
  #queued: boolean = false;

  constructor() {
    eventManager.on({
      AuthLogout: () => this.clearCache(),
      AuthUserLoaded: () => this.initialize(),
    });

    // loaded event might have already happened
    if (authManager.authenticated) {
      void this.initialize();
    }

    this.scheduleHourlyRefresh();
  }

  get filters() {
    return this.#filters;
  }

  setFilters(filters: MemoriesSearchDto) {
    filters = omitBy(filters, (item) => item === undefined);
    if (!isEqual(this.#filters, filters)) {
      this.#filters = filters;
      this.clearCache();
      void this.loadNextPage();
    }
  }

  refresh() {
    return this.initialize();
  }

  applyPreferences() {
    const { showUpcoming, onlyFavorites } = userPreferencesManager.memories;
    this.setFilters({
      order: MemorySearchOrder.Desc,
      isSaved: onlyFavorites ? true : undefined,
      isUpcoming: showUpcoming ? undefined : false,
    });

    return this.refresh();
  }

  memories = $state<MemoryResponseDto[]>([]);

  #memoryLaneTitle = fromStore(memoryLaneTitle);

  #url = $derived({
    memoryId: page.params.id,
    assetId: page.url.searchParams.get(QueryParameter.ASSET_ID) ?? undefined,
    isSaved: page.url.searchParams.get(QueryParameter.IS_SAVED) === 'true' || undefined,
  });

  memoriesHref = $derived(Route.memories({ isSaved: this.#url.isSaved }));

  #lookup = $derived.by(() => {
    const lookup = new SvelteMap<string, { memoryIndex: number; assetIndexes: Map<string, number> }>();

    for (const [memoryIndex, memory] of this.memories.entries()) {
      const assetIndexes = new Map(memory.assets.map((asset, assetIndex) => [asset.id, assetIndex] as const));
      lookup.set(memory.id, { memoryIndex, assetIndexes });
    }

    return lookup;
  });

  current = $derived.by((): MemoryState | undefined => {
    const { memoryId, assetId } = this.#url;
    if (memoryId === undefined || assetId === undefined) {
      return;
    }

    const location = this.#lookup.get(memoryId);
    if (!location) {
      return;
    }

    const { memoryIndex, assetIndexes } = location;
    const assetIndex = assetIndexes.get(assetId);
    if (assetIndex === undefined) {
      return;
    }

    const memory = this.memories[memoryIndex];
    const previousMemory = this.memories[memoryIndex - 1];
    const nextMemory = this.memories[memoryIndex + 1];

    return {
      memory,
      asset: toTimelineAsset(memory.assets[assetIndex]),
      viewerAssets: [...(previousMemory?.assets ?? []), ...memory.assets, ...(nextMemory?.assets ?? [])],
      previousMemory: this.#toAdjacentMemory(previousMemory),
      nextMemory: this.#toAdjacentMemory(nextMemory),
      previousHref:
        assetIndex > 0
          ? this.#toHref(memory, memory.assets[assetIndex - 1])
          : this.#toHref(previousMemory, previousMemory?.assets.at(-1)),
      nextHref:
        assetIndex < memory.assets.length - 1
          ? this.#toHref(memory, memory.assets[assetIndex + 1])
          : this.#toHref(nextMemory, nextMemory?.assets[0]),
      getAssetHref: (assetId: string) => this.#toHref(memory, { id: assetId }),
    };
  });

  #toHref(memory: { id: string } | undefined, asset: { id: string } | undefined) {
    return memory && asset
      ? Route.viewMemory({ id: memory.id, assetId: asset.id, isSaved: this.#url.isSaved })
      : undefined;
  }

  #toAdjacentMemory(memory: MemoryResponseDto | undefined): AdjacentMemory | undefined {
    if (!memory) {
      return;
    }

    const asset = memory.assets[0];
    const href = this.#toHref(memory, asset);
    if (!href) {
      return;
    }

    return { href, assetId: asset.id, title: this.#memoryLaneTitle.current(memory) };
  }

  // the memory holding an asset, checking the given memory first, then the ones next to it
  getMemoryWithAsset(assetId: string, memoryId: string) {
    const location = this.#lookup.get(memoryId);
    if (!location) {
      return;
    }

    const { memoryIndex } = location;
    return [memoryIndex, memoryIndex - 1, memoryIndex + 1]
      .map((index) => this.memories[index])
      .find((memory) => memory && this.#lookup.get(memory.id)?.assetIndexes.has(assetId));
  }

  #getMemory(id: string) {
    const location = this.#lookup.get(id);
    return location ? this.memories[location.memoryIndex] : undefined;
  }

  /** Fetch a memory that is not part of the loaded pages, i.e. when opening a link to an older one. */
  async loadMemory(id: string) {
    const memory = this.#getMemory(id);
    if (memory) {
      return memory;
    }

    const [loaded] = await searchMemories({ id }).catch(() => []);
    if (!loaded) {
      return;
    }

    // memories are ordered by date, descending
    const index = this.memories.findIndex(({ memoryAt }) => memoryAt < loaded.memoryAt);
    this.memories.splice(index === -1 ? this.memories.length : index, 0, loaded);

    return loaded;
  }

  async hideAssets(ids: string[]) {
    if (this.current && ids.includes(this.current.asset.id)) {
      await this.#leaveCurrentAsset();
    }

    const idSet = new Set<string>(ids);
    for (const memory of this.memories) {
      memory.assets = memory.assets.filter((asset) => !idSet.has(asset.id));
    }
    // if we removed all assets from a memory, then lets remove those memories (we don't show memories with 0 assets)
    this.memories = this.memories.filter((memory) => memory.assets.length > 0);
  }

  async deleteCurrentAsset() {
    const current = this.current;
    if (!current) {
      return;
    }

    const memoryId = current.memory.id;
    const assetId = current.asset.id;
    await this.#leaveCurrentAsset();
    await this.#deleteAsset(memoryId, assetId);
  }

  /** How long an item stays undoable after "Remove from memory" before the removal is committed. */
  static readonly REMOVE_UNDO_DELAY = 6000;

  #pendingRemovals = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * FL-83 (MPY-1): removing the current item from its memory is undoable, as in the
   * prototype's `MemoryPlayer.jsx`. The item is hidden at once, a toast offers Undo, and the
   * server call only happens after `REMOVE_UNDO_DELAY` unless Undo put the item back.
   */
  async removeCurrentAsset() {
    const current = this.current;
    if (!current) {
      return;
    }

    const memory = this.#getMemory(current.memory.id);
    const assetIndex = memory?.assets.findIndex((asset) => asset.id === current.asset.id) ?? -1;
    if (!memory || assetIndex === -1) {
      return;
    }

    // Captured before the item disappears, since `current` is derived from the loaded assets.
    const { nextHref, previousHref } = current;
    const [asset] = memory.assets.splice(assetIndex, 1);
    const memoryIndex = this.memories.indexOf(memory);
    const emptied = memory.assets.length === 0;
    if (emptied) {
      this.memories = this.memories.filter((item) => item !== memory);
    }
    await this.#goto(nextHref ?? previousHref ?? this.memoriesHref);

    const $t = get(t);
    const key = `${memory.id}:${asset.id}`;
    const commit = async () => {
      this.#pendingRemovals.delete(key);
      await (emptied
        ? deleteMemory({ id: memory.id })
        : removeMemoryAssets({ id: memory.id, bulkIdsDto: { ids: [asset.id] } }));
    };
    this.#pendingRemovals.set(
      key,
      setTimeout(() => void commit(), MemoryManager.REMOVE_UNDO_DELAY),
    );

    toastManager.primary(
      {
        description: $t('frameleaf_memories_item_removed', { values: { name: asset.originalFileName } }),
        button: (close) => ({
          label: $t('undo'),
          onclick: () => {
            close();
            const timer = this.#pendingRemovals.get(key);
            if (timer === undefined) {
              return;
            }
            clearTimeout(timer);
            this.#pendingRemovals.delete(key);
            memory.assets.splice(Math.min(assetIndex, memory.assets.length), 0, asset);
            if (emptied && !this.memories.includes(memory)) {
              this.memories.splice(Math.min(memoryIndex, this.memories.length), 0, memory);
            }
          },
        }),
      },
      { timeout: MemoryManager.REMOVE_UNDO_DELAY },
    );
  }

  /**
   * FL-83 (MPY-3): the player's heart favorites the item being shown, not the memory
   * (the memory's own saved flag lives on the index card).
   */
  async toggleCurrentAssetFavorite() {
    const current = this.current;
    if (!current) {
      return;
    }

    const { id } = current.asset;
    const isFavorite = !current.asset.isFavorite;
    await updateAsset({ id, updateAssetDto: { isFavorite } });
    for (const memory of this.memories) {
      for (const asset of memory.assets) {
        if (asset.id === id) {
          asset.isFavorite = isFavorite;
        }
      }
    }
  }

  async deleteCurrentMemory() {
    const current = this.current;
    if (!current) {
      return;
    }

    const { id } = current.memory;
    await this.#goto(current.nextMemory?.href ?? current.previousMemory?.href ?? this.memoriesHref);
    await this.#deleteMemory(id);
    toastManager.primary(get(t)('removed_memory'));
  }

  async toggleCurrentMemorySaved() {
    const memory = this.current?.memory;
    if (!memory) {
      return;
    }

    await this.toggleMemorySaved(memory.id);
  }

  /**
   * Toggles the saved (favorite) flag of any loaded memory, not just the one currently open.
   * Used by the memory index, whose cards act on a memory without opening the player.
   */
  async toggleMemorySaved(id: string) {
    const memory = this.#getMemory(id);
    if (!memory) {
      return;
    }

    const isSaved = !memory.isSaved;
    await updateMemory({ id, memoryUpdateDto: { isSaved } });
    memory.isSaved = isSaved;
    toastManager.primary(get(t)(isSaved ? 'added_to_favorites' : 'removed_from_favorites'));
  }

  /**
   * Removes any loaded memory, not just the one currently open. Navigates away first when the
   * removed memory is the one currently open, so the url never points at a deleted position.
   */
  async removeMemory(id: string) {
    if (this.current?.memory.id === id) {
      await this.deleteCurrentMemory();
      return;
    }

    await this.#deleteMemory(id);
    toastManager.primary(get(t)('removed_memory'));
  }

  // navigate away before removing something, so the url never points at a deleted position
  #leaveCurrentAsset() {
    const { nextHref, previousHref } = this.current ?? {};
    return this.#goto(nextHref ?? previousHref ?? this.memoriesHref);
  }

  #goto(href: string) {
    return goto(href, { replaceState: true, noScroll: true, keepFocus: true });
  }

  async #deleteMemory(id: string) {
    if (!this.#getMemory(id)) {
      return;
    }

    await deleteMemory({ id });
    this.memories = this.memories.filter((memory) => memory.id !== id);
  }

  async #deleteAsset(memoryId: string, assetId: string) {
    const memory = this.#getMemory(memoryId);
    if (!memory?.assets.some((asset) => asset.id === assetId)) {
      return;
    }

    if (memory.assets.length === 1) {
      await this.#deleteMemory(memoryId);
      return;
    }

    await removeMemoryAssets({ id: memoryId, bulkIdsDto: { ids: [assetId] } });
    memory.assets = memory.assets.filter((asset) => asset.id !== assetId);
  }

  loadNextPage() {
    if (this.#hasNextPage) {
      if (this.#loading === undefined) {
        this.#loading = this.load(this.#page++);
      } else {
        this.#queued = true;
      }
    }
  }

  get hasNextPage() {
    return this.#hasNextPage;
  }

  get total() {
    return this.#total;
  }

  get loading() {
    return this.#loading;
  }

  private clearCache() {
    this.#hasNextPage = true;
    this.#page = 1;
    this.#total = undefined;
    this.memories = [];
  }

  private initialize() {
    if (!this.#loading) {
      this.#loading = this.load(this.#page++);
    }

    return this.#loading;
  }

  private async load(page: number) {
    const items = await searchMemories({ ...this.#filters, page });

    if (this.#queued) {
      this.#queued = false;
      this.#loading = this.load(this.#page++);
      await this.#loading;
      return;
    }

    for (const item of items) {
      if (!this.#lookup.has(item.id)) {
        this.memories.push(item);
      }
    }

    if (this.#total === undefined) {
      const { total } = await memoriesStatistics(this.#filters);
      this.#total = total;
    }

    this.#hasNextPage = this.memories.length < this.#total;
    this.#loading = undefined;
  }

  private scheduleHourlyRefresh() {
    const now = DateTime.utc();
    let nextEvent = now.set({ minute: 0, second: 5 });

    if (nextEvent <= now) {
      nextEvent = nextEvent.plus({ hours: 1 });
    }

    const initialDelay = nextEvent.diff(now).as('milliseconds');

    setTimeout(() => {
      if (this.#page <= 2) {
        this.clearCache();
        this.loadNextPage();
      }

      // Schedule subsequent events hourly
      setInterval(
        () => {
          if (this.#page > 2) {
            return;
          }
          this.clearCache();
          this.loadNextPage();
        },
        60 * 60 * 1000,
      );
    }, initialDelay);
  }
}

export const memoryManager = new MemoryManager();
