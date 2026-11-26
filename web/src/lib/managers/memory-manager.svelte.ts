import {
  type AssetResponseDto,
  MemorySearchOrder,
  addMemoryAssets,
  addMemoryShowLess,
  deleteMemory,
  getMemoryShowLess,
  type MemoryResponseDto,
  type MemorySlimAssetDto,
  type MemoryShowLessDto,
  type MemoryShowLessResponseDto,
  removeMemoryAssets,
  removeMemoryShowLess,
  searchMemories,
  updateAsset,
  updateMemory,
  memoriesStatistics,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { isEqual, omitBy } from 'lodash-es';
import { DateTime } from 'luxon';
import { t } from 'svelte-i18n';
import { SvelteMap } from 'svelte/reactivity';
import { fromStore, get } from 'svelte/store';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { QueryParameter } from '$lib/constants';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { trackSessionLockRefresh } from '$lib/frameleaf/session-access.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { userPreferencesManager } from '$lib/managers/user-preferences-manager.svelte';
import { Route } from '$lib/route';
import { memoryHeadline } from '$lib/utils';
import { handleError } from '$lib/utils/handle-error';
import { toTimelineAsset } from '$lib/utils/timeline-util';

type MemoriesSearchDto = Parameters<typeof searchMemories>[0];

/**
 * FL-1793: the list is read slim. Every memory held here has `slimAssets` (cover, count, links);
 * `assets` is empty until the memory is opened (`loadMemory`), which reads its full items.
 */
export type LoadedMemory = MemoryResponseDto & { slimAssets: MemorySlimAssetDto[] };

const toSlimAsset = (asset: AssetResponseDto): MemorySlimAssetDto => ({
  id: asset.id,
  type: asset.type,
  thumbhash: asset.thumbhash,
  fileCreatedAt: asset.fileCreatedAt,
  localDateTime: asset.localDateTime,
  width: asset.width ?? null,
  height: asset.height ?? null,
  visibility: asset.visibility,
});

/** A memory as the server sent it, with `slimAssets` filled from its full items when it came with those. */
const withSlimAssets = (memory: MemoryResponseDto): LoadedMemory =>
  Object.assign(memory, {
    slimAssets: memory.assets.length > 0 ? memory.assets.map((asset) => toSlimAsset(asset)) : (memory.slimAssets ?? []),
  });

type AdjacentMemory = {
  href: string;
  assetId: string;
  title: string;
};

/** Everything the memory viewer renders, for the position currently in the url. */
export type MemoryState = {
  memory: LoadedMemory;
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
  #generation = 0;

  constructor() {
    // FL-62: the first page already honours the owner's Memory settings.
    this.#filters = omitBy(this.#preferenceFilters(), (item) => item === undefined);
    eventManager.on({
      AuthLogout: () => {
        this.clearCache();
        this.hidden = [];
        this.showLess = [];
      },
      AuthUserLoaded: () => this.initialize(),
    });
    // FL-195 follow-up: a memory holding a Locked item shows only to the owner's unlocked session, so
    // every lock and unlock reloads the list rather than keep what the other state saw
    onLibraryAccessChange((change) => {
      if (change === 'restricted' || change === 'expanded') {
        void trackSessionLockRefresh(this.reloadForSessionAccess());
      }
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

  /** Drop every memory this session state loaded and read them again (a page in flight is discarded). */
  async reloadForSessionAccess() {
    this.clearCache();
    this.hidden = [];
    this.showLess = [];
    await Promise.all([this.initialize(), this.loadHidden(), this.loadShowLess()]);
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

  #memories = $state<LoadedMemory[]>([]);
  get memories(): LoadedMemory[] {
    return this.#memories;
  }
  /** Whatever is assigned leaves with `slimAssets` filled (`withSlimAssets`). */
  set memories(memories: MemoryResponseDto[]) {
    this.#memories = memories.map((memory) => withSlimAssets(memory));
  }

  /** FL-1408: the library has photos and its first memories are a night away (the day after a first import). */
  preparing = $state(false);

  /** FL-62: memories the owner hid, listed only under "Hidden memories" on the index. */
  #hidden = $state<LoadedMemory[]>([]);
  get hidden(): LoadedMemory[] {
    return this.#hidden;
  }
  set hidden(memories: MemoryResponseDto[]) {
    this.#hidden = memories.map((memory) => withSlimAssets(memory));
  }
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
      const assetIndexes = new Map(memory.slimAssets.map((asset, assetIndex) => [asset.id, assetIndex] as const));
      lookup.set(memory.id, { memoryIndex, assetIndexes });
    }

    return lookup;
  });

  #memoryLocation = $derived(this.#lookup.get(this.#url.memoryId ?? ''));

  #viewerAssets = $derived.by(() => {
    const location = this.#memoryLocation;
    if (!location) {
      return [];
    }
    const index = location.memoryIndex;
    return [
      ...(this.memories[index - 1]?.assets ?? []),
      ...this.memories[index].assets,
      ...(this.memories[index + 1]?.assets ?? []),
    ];
  });

  current = $derived.by((): MemoryState | undefined => {
    const { memoryId, assetId } = this.#url;
    if (memoryId === undefined || assetId === undefined) {
      return;
    }

    const location = this.#memoryLocation;
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
    // Nothing to show until the opened memory's full items are here (`loadMemory`).
    const asset = memory.assets.find(({ id }) => id === assetId);
    if (!asset) {
      return;
    }

    return {
      memory,
      asset: toTimelineAsset(asset),
      viewerAssets: this.#viewerAssets,
      previousMemory: this.#toAdjacentMemory(previousMemory),
      nextMemory: this.#toAdjacentMemory(nextMemory),
      previousHref:
        assetIndex > 0
          ? this.#toHref(memory, memory.slimAssets[assetIndex - 1])
          : this.#toHref(previousMemory, previousMemory?.slimAssets.at(-1)),
      nextHref:
        assetIndex < memory.slimAssets.length - 1
          ? this.#toHref(memory, memory.slimAssets[assetIndex + 1])
          : this.#toHref(nextMemory, nextMemory?.slimAssets[0]),
      getAssetHref: (assetId: string) => this.#toHref(memory, { id: assetId }),
    };
  });

  #toHref(memory: { id: string } | undefined, asset: { id: string } | undefined) {
    return memory && asset
      ? Route.viewMemory({ id: memory.id, assetId: asset.id, isSaved: this.#url.isSaved })
      : undefined;
  }

  #toAdjacentMemory(memory: LoadedMemory | undefined): AdjacentMemory | undefined {
    if (!memory) {
      return;
    }

    const asset = memory.slimAssets[0];
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

  #captureState() {
    const generation = this.#generation;
    const isCurrentSession = authManager.captureSession();
    return () => generation === this.#generation && isCurrentSession();
  }

  /**
   * The memory with its full items, for the player. The list holds memories slim (FL-1793), so opening
   * one reads its items; a memory outside the loaded pages (a link to an older one) joins the list.
   * The memories either side are read too, in the background, as the viewer pages across them.
   */
  async loadMemory(id: string) {
    const memory = await this.#loadFull(id);
    if (memory) {
      const index = this.memories.findIndex((item) => item.id === id);
      for (const neighbour of [this.memories[index - 1], this.memories[index + 1]]) {
        if (neighbour) {
          void this.#loadFull(neighbour.id);
        }
      }
    }
    return memory;
  }

  /** Reads in flight, so the page load and a background read of the same memory share one request. */
  #fullLoads = new Map<string, Promise<MemoryResponseDto | undefined>>();

  async #loadFull(id: string) {
    const memory = this.#getMemory(id);
    if (memory && memory.assets.length > 0) {
      return memory;
    }

    const isCurrent = this.#captureState();
    let pending = this.#fullLoads.get(id);
    if (!pending) {
      pending = searchMemories({ id })
        .then(([found]) => found)
        .catch(() => undefined)
        .finally(() => this.#fullLoads.delete(id));
      this.#fullLoads.set(id, pending);
    }
    const found = await pending;
    if (!isCurrent()) {
      return;
    }
    // A memory whose items were all removed has nothing to show (it is deleted once its Undo closes).
    if (!found || found.assets.length === 0) {
      return;
    }
    const loaded = withSlimAssets(found);

    const listed = this.memories.findIndex((item) => item.id === id);
    if (listed === -1) {
      // memories are ordered by date, descending
      const index = this.memories.findIndex(({ memoryAt }) => memoryAt < loaded.memoryAt);
      this.memories.splice(index === -1 ? this.memories.length : index, 0, loaded);
    } else {
      this.memories[listed] = loaded;
    }

    return this.#getMemory(id);
  }

  async hideAssets(ids: string[]) {
    if (this.current && ids.includes(this.current.asset.id)) {
      await this.#leaveCurrentAsset();
    }

    const idSet = new Set<string>(ids);
    for (const memory of this.memories) {
      memory.assets = memory.assets.filter((asset) => !idSet.has(asset.id));
      memory.slimAssets = memory.slimAssets.filter((asset) => !idSet.has(asset.id));
    }
    // if we removed all assets from a memory, then lets remove those memories (we don't show memories with 0 assets)
    this.memories = this.memories.filter((memory) => memory.slimAssets.length > 0);
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
    const isCurrentSession = authManager.captureSession();
    const asset = memory.assets[assetIndex];
    const removed = await removeMemoryAssets({ id: memory.id, bulkIdsDto: { ids: [asset.id] } });
    if (!isCurrentSession()) {
      return;
    }
    if (removed.find((result) => result.id === asset.id)?.success !== true) {
      throw new Error('Unable to remove the item from this memory');
    }
    memory.assets.splice(assetIndex, 1);
    memory.slimAssets = memory.slimAssets.filter(({ id }) => id !== asset.id);
    const memoryIndex = this.memories.indexOf(memory);
    const emptied = memory.slimAssets.length === 0;
    if (emptied) {
      this.memories = this.memories.filter((item) => item !== memory);
    }
    await this.#goto(nextHref ?? previousHref ?? this.memoriesHref);
    if (!isCurrentSession()) {
      return;
    }

    const translate = get(t);
    // Undo and the end of the window race for one outcome; whichever runs first wins.
    let settled = false;
    const finalize = emptied
      ? setTimeout(() => {
          if (settled || !isCurrentSession()) {
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
            if (settled || !isCurrentSession()) {
              return;
            }
            settled = true;
            clearTimeout(finalize);
            void this.#restoreAsset(memory, memoryIndex, asset, assetIndex, emptied, isCurrentSession).catch((error) =>
              handleError(error, translate('errors.something_went_wrong')),
            );
          },
        }),
      },
      { timeout: MEMORY_REMOVE_UNDO_TIMEOUT_MS },
    );
  }

  async #restoreAsset(
    memory: LoadedMemory,
    memoryIndex: number,
    asset: AssetResponseDto,
    assetIndex: number,
    emptied: boolean,
    isCurrentSession: () => boolean,
  ) {
    const restored = await addMemoryAssets({ id: memory.id, bulkIdsDto: { ids: [asset.id] } });
    if (!isCurrentSession()) {
      return;
    }
    if (restored.find((result) => result.id === asset.id)?.success !== true) {
      throw new Error('Unable to restore the item to this memory');
    }
    memory.assets.splice(Math.min(assetIndex, memory.assets.length), 0, asset);
    memory.slimAssets.splice(Math.min(assetIndex, memory.slimAssets.length), 0, toSlimAsset(asset));
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
    const isCurrentSession = authManager.captureSession();
    await updateAsset({ id, updateAssetDto: { isFavorite } });
    if (!isCurrentSession()) {
      return;
    }
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
    const isCurrentSession = authManager.captureSession();
    await updateMemory({ id, memoryUpdateDto: { isSaved } });
    if (isCurrentSession()) {
      memory.isSaved = isSaved;
    }
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

    const isCurrentSession = authManager.captureSession();
    if (this.current?.memory.id === id) {
      await this.#goto(this.current.nextMemory?.href ?? this.current.previousMemory?.href ?? this.memoriesHref);
    }
    if (!isCurrentSession()) {
      return;
    }
    const updated = await updateMemory({ id, memoryUpdateDto: { isHidden: true } });
    if (!isCurrentSession()) {
      return;
    }
    this.memories = this.memories.filter((item) => item.id !== id);
    this.hidden = [{ ...memory, ...updated, assets: updated.assets ?? memory.assets }, ...this.hidden];
  }

  /** FL-62: Restore from "Hidden memories" puts the memory back in its place in the index. */
  async restoreMemory(id: string) {
    const memory = this.hidden.find((item) => item.id === id);
    if (!memory) {
      return;
    }

    const isCurrentSession = authManager.captureSession();
    const updated = await updateMemory({ id, memoryUpdateDto: { isHidden: false } });
    if (!isCurrentSession()) {
      return;
    }
    const restored = withSlimAssets({ ...memory, ...updated, assets: updated.assets ?? memory.assets });
    this.hidden = this.hidden.filter((item) => item.id !== id);
    if (restored.slimAssets.length > 0 && !this.#lookup.has(id)) {
      // memories are ordered by date, descending
      const index = this.memories.findIndex(({ memoryAt }) => memoryAt < restored.memoryAt);
      this.memories.splice(index === -1 ? this.memories.length : index, 0, restored);
    }
  }

  /** The owner's hidden memories, for the index's "Hidden memories" section. */
  async loadHidden() {
    const isCurrent = this.#captureState();
    const items = await searchMemories({ isHidden: true, order: MemorySearchOrder.Desc, size: 250, slim: true });
    if (!isCurrent()) {
      return;
    }
    this.hidden = items.filter((item) => item.assets.length > 0 || (item.slimAssets?.length ?? 0) > 0);
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

    const isCurrentSession = authManager.captureSession();
    const updated = await updateMemory({ id, memoryUpdateDto: curation });
    if (!isCurrentSession()) {
      return;
    }
    if (curation.title !== undefined) {
      memory.title = updated.title ?? null;
    }
    if (curation.assetOrder) {
      const reorder = <T extends { id: string }>(assets: T[]) => {
        const byId = new Map(assets.map((asset) => [asset.id, asset] as const));
        const ordered = curation.assetOrder!.map((assetId) => byId.get(assetId)).filter((asset) => asset !== undefined);
        return [...ordered, ...assets.filter((asset) => !curation.assetOrder!.includes(asset.id))];
      };
      memory.assets = reorder(memory.assets);
      memory.slimAssets = reorder(memory.slimAssets);
    }
  }

  /** The owner's show-less rules, for Memory settings. */
  async loadShowLess() {
    const isCurrent = this.#captureState();
    const rules = await getMemoryShowLess();
    if (isCurrent()) {
      this.showLess = rules;
    }
  }

  /**
   * FL-62: "Show less" for a person or pet, a day or a kind. The server drops matching memories from
   * every search and stops generating them, so the index reloads rather than guessing which to drop.
   */
  async addShowLess(rule: MemoryShowLessDto) {
    const isCurrentSession = authManager.captureSession();
    await addMemoryShowLess({ memoryShowLessDto: rule });
    if (!isCurrentSession()) {
      return;
    }
    const loading = this.#reload();
    await Promise.all([this.loadShowLess(), loading]);
  }

  async removeShowLess(rule: MemoryShowLessDto) {
    const isCurrentSession = authManager.captureSession();
    await removeMemoryShowLess({ memoryShowLessDto: { kind: rule.kind, value: rule.value } });
    if (!isCurrentSession()) {
      return;
    }
    const loading = this.#reload();
    await Promise.all([this.loadShowLess(), loading]);
  }

  async #reload() {
    this.clearCache();
    return this.initialize();
  }

  // navigate away before removing something, so the url never points at a deleted position
  #leaveCurrentAsset() {
    const { nextHref, previousHref } = this.current ?? {};
    return this.#goto(nextHref ?? previousHref ?? this.memoriesHref);
  }

  #goto(href: string) {
    return goto(href, { replace: true, reset: false });
  }

  loadNextPage() {
    if (this.#hasNextPage) {
      if (this.#loading === undefined) {
        void this.initialize().catch((error) => handleError(error, get(t)('errors.something_went_wrong')));
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
    this.#generation++;
    this.#loading = undefined;
    this.#queued = false;
    this.#hasNextPage = true;
    this.#page = 1;
    this.#total = undefined;
    this.#received = 0;
    this.memories = [];
    this.preparing = false;
  }

  private initialize() {
    if (!this.#loading) {
      const loading = this.load(this.#generation).finally(() => {
        if (this.#loading === loading) {
          this.#loading = undefined;
        }
      });
      this.#loading = loading;
    }

    return this.#loading;
  }

  private async load(generation: number) {
    // Every page is already here when the server has no more: asking again would only read past the end.
    while (this.#hasNextPage) {
      this.#queued = false;
      // FL-1793: the list only draws covers, so it never asks for whole assets
      const items = await searchMemories({ ...this.#filters, slim: true, page: this.#page });
      if (generation !== this.#generation) {
        return;
      }

      const statistics = this.#total === undefined ? await memoriesStatistics(this.#filters) : undefined;
      if (generation !== this.#generation) {
        return;
      }
      const total = statistics?.total ?? this.#total ?? 0;
      if (statistics) {
        this.preparing = statistics.preparing ?? false;
      }

      this.#page++;
      this.#received += items.length;
      this.#total = total;
      const knownIds = new Set(this.memories.map(({ id }) => id));
      for (const received of items) {
        const item = withSlimAssets(received);
        // Empty memories count toward pagination but never appear in the list.
        if (item.slimAssets.length > 0 && !knownIds.has(item.id)) {
          knownIds.add(item.id);
          this.memories.push(item);
        }
      }
      // A reload while the player is open (a lock, the hourly refresh) reads the open memory's items again.
      const openId = page.params?.id;
      if (openId && this.#getMemory(openId)) {
        void this.loadMemory(openId);
      }

      this.#hasNextPage = this.#received < total;
      if (!this.#queued) {
        break;
      }
    }
  }

  private scheduleHourlyRefresh() {
    const now = DateTime.utc();
    let nextEvent = now.set({ minute: 0, second: 5 });

    if (nextEvent <= now) {
      nextEvent = nextEvent.plus({ hours: 1 });
    }

    const initialDelay = nextEvent.diff(now).as('milliseconds');

    const refresh = () => {
      if (!authManager.authenticated || this.#page > 2) {
        return;
      }
      this.clearCache();
      this.loadNextPage();
    };

    setTimeout(() => {
      refresh();
      setInterval(refresh, 60 * 60 * 1000);
    }, initialDelay);
  }
}

export const memoryManager = new MemoryManager();
