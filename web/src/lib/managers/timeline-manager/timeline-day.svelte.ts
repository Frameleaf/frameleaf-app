import { AssetOrder, TimeBucketDateType } from '@frameleaf/sdk';
import { SvelteSet } from 'svelte/reactivity';
import { cellGrid } from '$lib/frameleaf/library-grid';
import type { CommonLayoutOptions, CommonPosition } from '$lib/utils/layout-utils';
import { getJustifiedLayoutFromAssets } from '$lib/utils/layout-utils';
import { getOrderingDate, plainDateTimeCompare } from '$lib/utils/timeline-util';
import { TUNABLES } from '$lib/utils/tunables';
import type { TimelineMonth } from './timeline-month.svelte';
import type { Direction, MoveAsset, TimelineAsset } from './types';
import { ViewerAsset } from './viewer-asset.svelte';

const {
  TIMELINE: { INTERSECTION_EXPAND_TOP, INTERSECTION_EXPAND_BOTTOM },
} = TUNABLES;

function lowerBound(assets: ViewerAsset[], target: number, key: (pos: CommonPosition) => number): number {
  let lo = 0;
  let hi = assets.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (key(assets[mid].position!) < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export class TimelineDay {
  readonly timelineMonth: TimelineMonth;
  readonly index: number;
  readonly groupTitle: string;
  readonly day: number;
  readonly dateType: TimeBucketDateType;
  viewerAssets: ViewerAsset[] = $state([]);

  height = $state(0);
  width = $state(0);

  // Assets in or near the viewport; active assets should be added to the DOM.
  activeViewerAssets: ViewerAsset[] = $state([]);
  isInOrNearViewport = $state(false);

  #top: number = $state(0);
  #start: number = $state(0);
  #row = $state(0);
  #col = $state(0);
  #deferredLayout = false;

  constructor(
    timelineMonth: TimelineMonth,
    index: number,
    day: number,
    groupTitle: string,
    dateType: TimeBucketDateType,
  ) {
    this.index = index;
    this.timelineMonth = timelineMonth;
    this.day = day;
    this.groupTitle = groupTitle;
    this.dateType = dateType;
  }

  get top() {
    return this.#top;
  }

  set top(value: number) {
    this.#top = value;
  }

  get start() {
    return this.#start;
  }

  set start(value: number) {
    this.#start = value;
  }

  get row() {
    return this.#row;
  }

  set row(value: number) {
    this.#row = value;
  }

  get col() {
    return this.#col;
  }

  set col(value: number) {
    this.#col = value;
  }

  get deferredLayout() {
    return this.#deferredLayout;
  }

  set deferredLayout(value: boolean) {
    this.#deferredLayout = value;
  }

  sortAssets(sortOrder: AssetOrder = AssetOrder.Desc) {
    const sortFn = plainDateTimeCompare.bind(undefined, sortOrder === AssetOrder.Asc);
    this.viewerAssets.sort((a, b) => sortFn(a.asset.fileCreatedAt, b.asset.fileCreatedAt));
  }

  getFirstAsset() {
    return this.viewerAssets[0]?.asset;
  }

  *assetsIterator(options: { startAsset?: TimelineAsset; direction?: Direction } = {}) {
    const isEarlier = (options?.direction ?? 'earlier') === 'earlier';
    let assetIndex = options?.startAsset
      ? this.viewerAssets.findIndex((viewerAsset) => viewerAsset.asset.id === options.startAsset!.id)
      : isEarlier
        ? 0
        : this.viewerAssets.length - 1;

    while (assetIndex >= 0 && assetIndex < this.viewerAssets.length) {
      const viewerAsset = this.viewerAssets[assetIndex];
      yield viewerAsset.asset;
      assetIndex += isEarlier ? 1 : -1;
    }
  }

  getAssets() {
    return this.viewerAssets.map((viewerAsset) => viewerAsset.asset);
  }

  runAssetCallback(ids: Set<string>, callback: (asset: TimelineAsset) => void | { remove?: boolean }) {
    const unprocessedIds = new SvelteSet<string>(ids);
    const processedIds = new SvelteSet<string>();
    const moveAssets: MoveAsset[] = [];
    let changedGeometry = false;

    if (ids.size === 0) {
      return { moveAssets, processedIds, unprocessedIds, changedGeometry };
    }

    const headerExtraBefore = this.headerExtra;
    for (let index = this.viewerAssets.length - 1; index >= 0; index--) {
      const { id: assetId, asset } = this.viewerAssets[index];
      if (!ids.has(assetId)) {
        continue;
      }

      const oldTime = { ...getOrderingDate(asset, this.dateType) };
      const callbackResult = callback(asset);
      let remove = (callbackResult as { remove?: boolean } | undefined)?.remove ?? false;
      const newTime = getOrderingDate(asset, this.dateType);
      // A flat order (S-15) is not grouped by date: a new date moves nothing. Nor are the dates to
      // check (FL-1410): only the server knows whether a new date is right, and the refresh reads it.
      const dated = !this.timelineMonth.timelineManager.ordered && !this.timelineMonth.toCheck;
      if (dated && (oldTime.year !== newTime.year || oldTime.month !== newTime.month || oldTime.day !== newTime.day)) {
        const { year, month, day } = newTime;
        remove = true;
        moveAssets.push({ asset, date: { year, month, day } });
      }
      unprocessedIds.delete(assetId);
      processedIds.add(assetId);
      if (remove || this.timelineMonth.timelineManager.isExcluded(asset)) {
        this.viewerAssets.splice(index, 1);
        changedGeometry = true;
      }
    }
    // FL-1392: a day that gains its first place, or loses its last, changes its header's height on phones.
    changedGeometry ||= this.headerExtra !== headerExtraBefore;
    return { moveAssets, processedIds, unprocessedIds, changedGeometry };
  }

  layout(options: CommonLayoutOptions, noDefer: boolean) {
    if (!noDefer && !this.timelineMonth.isInOrNearViewport && !this.timelineMonth.timelineManager.isScrollingOnLoad) {
      this.#deferredLayout = true;
      return;
    }
    const manager = this.timelineMonth.timelineManager;
    if (manager.cells) {
      // FL-1398: Browse and Work grouped by day, each day a cell grid of its own.
      const grid = cellGrid(this.viewerAssets.length, manager.viewportWidth, manager.cells);
      this.width = grid.width;
      this.height = grid.height;
      for (const [index, viewerAsset] of this.viewerAssets.entries()) {
        viewerAsset.position = grid.position(index);
      }
      this.updateAssetBoundaries();
      return;
    }
    const assets = this.viewerAssets.map((viewerAsset) => viewerAsset.asset!);
    const geometry = getJustifiedLayoutFromAssets(assets, options);
    this.width = geometry.containerWidth;
    this.height = assets.length === 0 ? 0 : geometry.containerHeight;
    // TODO: lazily get positions instead of loading them all here
    for (let i = 0; i < this.viewerAssets.length; i++) {
      this.viewerAssets[i].position = geometry.getPosition(i);
    }
    this.updateAssetBoundaries();
  }

  updateAssetBoundaries() {
    const manager = this.timelineMonth.timelineManager;
    const visibleWindow = manager.visibleWindow;
    if (this.viewerAssets.length === 0 || !this.viewerAssets[0].position) {
      if (this.activeViewerAssets.length > 0) {
        this.activeViewerAssets = [];
      }
      this.isInOrNearViewport = false;
      return;
    }

    const dayOffset = this.absoluteTimelineDayTop;
    const headerHeight = manager.headerHeight;
    const expandedTop = visibleWindow.top - headerHeight - INTERSECTION_EXPAND_TOP - dayOffset;
    const expandedBottom = visibleWindow.bottom + headerHeight + INTERSECTION_EXPAND_BOTTOM - dayOffset;

    const first = lowerBound(this.viewerAssets, expandedTop, (p) => p.top + p.height);
    const last = lowerBound(this.viewerAssets, expandedBottom, (p) => p.top) - 1;

    const hasActive = last >= first && first < this.viewerAssets.length;
    const active = this.activeViewerAssets;
    const count = hasActive ? last - first + 1 : 0;
    if (active.length !== count || active.some((asset, index) => asset !== this.viewerAssets[first + index])) {
      this.activeViewerAssets = hasActive ? this.viewerAssets.slice(first, last + 1) : [];
    }
    this.isInOrNearViewport = hasActive;
  }

  /** The day's places, in the order its photos show them; its header names them (FL-1392). */
  get cities(): string[] {
    return [...new Set(this.viewerAssets.map(({ asset }) => asset?.city).filter((city): city is string => !!city))];
  }

  /**
   * Phones: how much taller this day's header is, for the line that names its places. The layout
   * puts the day's top this far down, so its rows sit where every position sum expects them
   * (`top` + the header height), and the header is drawn from this far above `top`.
   */
  get headerExtra(): number {
    const manager = this.timelineMonth.timelineManager;
    const perDay = manager.dayRows && manager.grouping === 'days' && manager.placeLineHeight > 0;
    // FL-1410: the dates to check say why they wait on that line ("The camera's clock was wrong")
    return perDay && (this.cities.length > 0 || this.timelineMonth.toCheck) ? manager.placeLineHeight : 0;
  }

  get absoluteTimelineDayTop() {
    return this.timelineMonth.top + this.#top;
  }
}
