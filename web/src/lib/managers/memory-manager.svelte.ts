import {
  type AssetResponseDto,
  MemorySearchOrder,
  addMemoryAssets,
  addMemoryShowLess,
  deleteMemory,
  getMemoryShowLess,
  type MemoryResponseDto,
  type MemoryShowLessDto,
  type MemoryShowLessResponseDto,
  removeMemoryAssets,
  removeMemoryShowLess,
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
import { memoryHeadline } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';
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

/** How long the "Remove from memory" toast offers Undo; an emptied memory is deleted after it. */
export const MEMORY_REMOVE_UNDO_TIMEOUT_MS = 6000;

class MemoryManager {
  #loading = $state<Promise<void>>();
  #filters = $state<MemoriesSearchDto>({ size: 250, order: MemorySearchOrder.Desc });
  #hasNextPage: boolean = true;
  #page: number = 1;
  #total: number | undefined = $state();
  /** Memories received from the server, including empty ones that are never listed. */
  #received = 0;
  #queued: boolean = false;

  constructor() {
    // FL-62: the first page already honours the owner's Memory settings.
    this.#filters = omitBy(this.#preferenceFilters(), (item) => item === undefined);
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
    this.setFilters(this.#preferenceFilters());

    return this.refresh();
  }

  #preferenceFilters(): MemoriesSearchDto {
    const { showUpcoming, onlyFavorites } = userPreferencesManager.memories;
    return {
      size: 250,
      order: MemorySearchOrder.Desc,
      isSaved: onlyFavorites ? true : undefined,
      isUpcoming: showUpcoming ? undefined : false,
    };
  }

  memories = $state<MemoryResponseDto[]>([]);

  /** FL-62: memories the owner hid, listed only under "Hidden memories" on the index. */
  hidden = $state<MemoryResponseDto[]>([]);
  /** FL-62: the owner's show-less rules (people, pets, days and kinds). */
  showLess = $state<MemoryShowLessResponseDto[]>([]);

  #memoryHeadline = fromStore(memoryHeadline);

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

    return { href, assetId: asset.id, title: this.#memoryHeadline.current(memory).title };
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
    // A memory whose items were all removed has nothing to show (it is deleted once its Undo closes).
    if (!loaded || loaded.assets.length === 0) {
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

  /**
   * FL-83 (MPY-1): removing the current item from its memory is undoable, as in the
   * prototype's `MemoryPlayer.jsx`. The removal is sent to the server at once (a reload or a
   * closed tab never loses it) and Undo puts the item back through the inverse call. A memory
   * emptied this way leaves the list at once and is deleted on the server when its Undo window
   * closes unused (`MemoryPlayer.jsx` keeps it only while it can still be restored). Until then an
   * empty memory from the server is never listed, so a reload in between shows nothing broken.
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
    const asset = memory.assets[assetIndex];
    const removed = await removeMemoryAssets({ id: memory.id, bulkIdsDto: { ids: [asset.id] } });
    if (removed.find((result) => result.id === asset.id)?.success !== true) {
      throw new Error('Unable to remove the item from this memory');
    }
    memory.assets.splice(assetIndex, 1);
    const memoryIndex = this.memories.indexOf(memory);
    const emptied = memory.assets.length === 0;
    if (emptied) {
      this.memories = this.memories.filter((item) => item !== memory);
    }
    await this.#goto(nextHref ?? previousHref ?? this.memoriesHref);

    const translate = get(t);
    // Undo and the end of the window race for one outcome; whichever runs first wins.
    let settled = false;
    const finalize = emptied
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          void deleteMemory({ id: memory.id }).catch((error) =>
            handleError(error, translate('errors.something_went_wrong')),
          );
        }, MEMORY_REMOVE_UNDO_TIMEOUT_MS)
      : undefined;
    toastManager.primary(
      {
        description: translate('frameleaf_memories_item_removed', { values: { name: asset.originalFileName } }),
        button: (close) => ({
          label: translate('undo'),
          onclick: () => {
            close();
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(finalize);
            void this.#restoreAsset(memory, memoryIndex, asset, assetIndex, emptied).catch((error) =>
              handleError(error, translate('errors.something_went_wrong')),
            );
          },
        }),
      },
      { timeout: MEMORY_REMOVE_UNDO_TIMEOUT_MS },
    );
  }

  async #restoreAsset(
    memory: MemoryResponseDto,
    memoryIndex: number,
    asset: AssetResponseDto,
    assetIndex: number,
    emptied: boolean,
  ) {
    const restored = await addMemoryAssets({ id: memory.id, bulkIdsDto: { ids: [asset.id] } });
    if (restored.find((result) => result.id === asset.id)?.success !== true) {
      throw new Error('Unable to restore the item to this memory');
    }
    memory.assets.splice(Math.min(assetIndex, memory.assets.length), 0, asset);
    if (emptied && !this.memories.includes(memory)) {
      this.memories.splice(Math.min(memoryIndex, this.memories.length), 0, memory);
    }
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

  /**
   * Toggles the saved (favorite) flag of any loaded memory, not just the one currently open.
   * Used by the memory index, whose cards act on a memory without opening the player. A saved
   * memory is kept: the server never cleans it up.
   */
  async toggleMemorySaved(id: string) {
    const memory = this.#getMemory(id);
    if (!memory) {
      return;
    }

    const isSaved = !memory.isSaved;
    await updateMemory({ id, memoryUpdateDto: { isSaved } });
    memory.isSaved = isSaved;
  }

  /**
   * FL-62 (MI-1, Memories.jsx:208-211): hiding replaces deleting. The memory leaves the index and
   * the player and waits under "Hidden memories", where Restore brings it back. Navigates away first
   * when it is the memory currently open, so the url never points at a hidden position.
   */
  async hideMemory(id: string) {
    const memory = this.#getMemory(id);
    if (!memory) {
      return;
    }

    if (this.current?.memory.id === id) {
      await this.#goto(this.current.nextMemory?.href ?? this.current.previousMemory?.href ?? this.memoriesHref);
    }
    const updated = await updateMemory({ id, memoryUpdateDto: { isHidden: true } });
    this.memories = this.memories.filter((item) => item.id !== id);
    this.hidden = [{ ...memory, ...updated, assets: updated.assets ?? memory.assets }, ...this.hidden];
  }

  /** FL-62: Restore from "Hidden memories" puts the memory back in its place in the index. */
  async restoreMemory(id: string) {
    const memory = this.hidden.find((item) => item.id === id);
    if (!memory) {
      return;
    }

    const updated = await updateMemory({ id, memoryUpdateDto: { isHidden: false } });
    const restored = { ...memory, ...updated, assets: updated.assets ?? memory.assets };
    this.hidden = this.hidden.filter((item) => item.id !== id);
    if (restored.assets.length > 0 && !this.#lookup.has(id)) {
      // memories are ordered by date, descending
      const index = this.memories.findIndex(({ memoryAt }) => memoryAt < restored.memoryAt);
      this.memories.splice(index === -1 ? this.memories.length : index, 0, restored);
    }
  }

  /** The owner's hidden memories, for the index's "Hidden memories" section. */
  async loadHidden() {
    const items = await searchMemories({ isHidden: true, order: MemorySearchOrder.Desc, size: 250 });
    this.hidden = items.filter((item) => item.assets.length > 0);
  }

  /**
   * FL-62: the owner's own title and item order. The title replaces the generated one everywhere
   * (null returns to it); the order is the memory's own items in the order the owner chose, and the
   * player plays them in that order from then on.
   */
  async updateCuration(id: string, curation: { title?: string | null; assetOrder?: string[] }) {
    const memory = this.#getMemory(id);
    if (!memory) {
      return;
    }

    const updated = await updateMemory({ id, memoryUpdateDto: curation });
    if (curation.title !== undefined) {
      memory.title = updated.title ?? null;
    }
    if (curation.assetOrder) {
      const byId = new Map(memory.assets.map((asset) => [asset.id, asset] as const));
      const ordered = curation.assetOrder.map((assetId) => byId.get(assetId)).filter((asset) => asset !== undefined);
      const rest = memory.assets.filter((asset) => !curation.assetOrder!.includes(asset.id));
      memory.assets = [...ordered, ...rest];
    }
  }

  /** The owner's show-less rules, for Memory settings. */
  async loadShowLess() {
    this.showLess = await getMemoryShowLess();
  }

  /**
   * FL-62: "Show less" for a person or pet, a day or a kind. The server drops matching memories from
   * every search and stops generating them, so the index reloads rather than guessing which to drop.
   */
  async addShowLess(rule: MemoryShowLessDto) {
    await addMemoryShowLess({ memoryShowLessDto: rule });
    await Promise.all([this.loadShowLess(), this.#reload()]);
  }

  async removeShowLess(rule: MemoryShowLessDto) {
    await removeMemoryShowLess({ memoryShowLessDto: { kind: rule.kind, value: rule.value } });
    await Promise.all([this.loadShowLess(), this.#reload()]);
  }

  async #reload() {
    // a page already in flight was asked for before the change; let it land, then start over
    await this.#loading?.catch(() => undefined);
    this.clearCache();
    return this.initialize();
  }

  // navigate away before removing something, so the url never points at a deleted position
  #leaveCurrentAsset() {
    const { nextHref, previousHref } = this.current ?? {};
    return this.#goto(nextHref ?? previousHref ?? this.memoriesHref);
  }

  #goto(href: string) {
    return goto(href, { replaceState: true, noScroll: true, keepFocus: true });
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
    this.#received = 0;
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

    this.#received += items.length;
    for (const item of items) {
      // Empty memories (every item removed, pending deletion) are never listed.
      if (item.assets.length > 0 && !this.#lookup.has(item.id)) {
        this.memories.push(item);
      }
    }

    if (this.#total === undefined) {
      const { total } = await memoriesStatistics(this.#filters);
      this.#total = total;
    }

    this.#hasNextPage = this.#received < this.#total;
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
