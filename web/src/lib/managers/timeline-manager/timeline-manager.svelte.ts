import {
  AssetLockReason,
  AssetOrder,
  AssetVisibility,
  getAssetInfo,
  getTimeBuckets,
  TimeBucketDateType,
  type AssetResponseDto,
} from '@immich/sdk';
import { clamp, isEqual } from 'lodash-es';
import { SvelteDate, SvelteSet } from 'svelte/reactivity';
import { revealsLocks, sessionAccess, trackSessionLockRefresh } from '$lib/frameleaf/session-access.svelte';
import { VirtualScrollManager } from '$lib/managers/VirtualScrollManager/VirtualScrollManager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { GroupInsertionCache } from '$lib/managers/timeline-manager/group-insertion-cache.svelte';
import { batchFlow, linkFlows } from '$lib/managers/timeline-manager/internal/flow-support.svelte';
import { updateTimelineMonthViewportProximity } from '$lib/managers/timeline-manager/internal/intersection-support.svelte';
import { updateGeometry } from '$lib/managers/timeline-manager/internal/layout-support.svelte';
import {
  loadFromTimeBuckets,
  loadOrderedPage,
  ORDERED_PAGE_SIZE,
  orderedPageYearMonth,
} from '$lib/managers/timeline-manager/internal/load-support.svelte';
import {
  findClosestTimelineMonthForDate,
  findTimelineMonthForAsset as findTimelineMonthForAssetUtil,
  findTimelineMonthForDate,
  getAssetWithOffset,
  getTimelineMonthByDate,
  retrieveRange as retrieveRangeUtil,
} from '$lib/managers/timeline-manager/internal/search-support.svelte';
import { WebsocketSupport } from '$lib/managers/timeline-manager/internal/websocket-support.svelte';
import { userPreferencesManager } from '$lib/managers/user-preferences-manager.svelte';
import { CancellableTask } from '$lib/utils/cancellable-task';
import {
  getOrderingDate,
  isAssetResponseDto,
  setDifference,
  toTimelineAsset,
  type TimelineDateTime,
  type TimelineYearMonth,
} from '$lib/utils/timeline-util';
import { isMismatched, updateObject } from './internal/utils.svelte';
import { TimelineDay } from './timeline-day.svelte';
import { TimelineMonth } from './timeline-month.svelte';
import type {
  AssetDescriptor,
  Direction,
  MoveAsset,
  ScrubberMonth,
  TimelineAsset,
  TimelineGrouping,
  TimelineManagerOptions,
  Viewport,
} from './types';

type ViewportTopMonthIntersection = {
  month: TimelineMonth | undefined;
  // Where viewport top intersects month (0 = month top, 1 = month bottom)
  viewportTopRatioInMonth: number;
  // Where month bottom is in viewport (0 = viewport top, 1 = viewport bottom)
  monthBottomViewportRatio: number;
};
export class TimelineManager extends VirtualScrollManager {
  override bottomSectionHeight = $state(60);

  override bodySectionHeight = $derived.by(() => {
    let height = 0;
    for (const month of this.months) {
      height += month.height;
    }
    return height;
  });

  assetCount = $derived.by(() => {
    let count = 0;
    for (const month of this.months) {
      count += month.assetsCount;
    }
    return count;
  });

  isInitialized = $state(false);
  isScrollingOnLoad = false;
  months: TimelineMonth[] = $state([]);
  #grouping: TimelineGrouping = $state('days');

  /** How the months are grouped for display; changing it lays every month out again. */
  get grouping(): TimelineGrouping {
    return this.#grouping;
  }

  set grouping(value: TimelineGrouping) {
    if (this.#grouping === value) {
      return;
    }
    this.#grouping = value;
    this.refreshLayout();
  }

  /**
   * FL-143: a group's rows run on from one month bucket into the next, as the prototype lays it out.
   * Years and All over justified rows are one flow per group (`TimelineLibrary.jsx` justifiedRows
   * over `group.assets`); the Browse and Work cell grids are one grid over the whole library
   * (`App.jsx` `.media-grid`). Timeline month and day groups stay per month and per day.
   */
  get continuousGroups(): boolean {
    if (this.cells) {
      return true;
    }
    return this.fillRowWidth && (this.#grouping === 'years' || this.#grouping === 'all');
  }

  /** Flow bookkeeping for `internal/flow-support.svelte.ts` (FL-143). */
  flowDirty = new Set<TimelineMonth>();
  flowBatchDepth = 0;
  flowReconciling = false;
  /** While set, a month's new height leaves the scroll position alone; the flow compensates itself. */
  flowHoldsScroll = false;
  albumAssets: Set<string> = new SvelteSet();
  // Assets hidden in this view because they were just marked NSFW. The server
  // hides NSFW assets via a query-time filter (not the `visibility` enum), so a
  // subsequent `on_asset_update` websocket event would otherwise re-add them.
  // Tracking their ids lets isExcluded() keep them out until the next refresh.
  #nsfwHiddenAssetIds: Set<string> = new SvelteSet();
  scrubberMonths: ScrubberMonth[] = $state([]);
  scrubberTimelineHeight: number = $state(0);
  viewportTopMonthIntersection: ViewportTopMonthIntersection | undefined;
  limitedScroll = $derived(this.maxScrollPercent < 0.5);
  initTask = new CancellableTask(
    () => {
      this.isInitialized = true;
      if (this.#options.albumId || this.#options.personId) {
        return;
      }
      this.connect();
    },
    () => {
      this.disconnect();
      this.isInitialized = false;
    },
    () => void 0,
  );

  static #INIT_OPTIONS = {};
  #websocketSupport: WebsocketSupport | undefined;
  #options: TimelineManagerOptions = TimelineManager.#INIT_OPTIONS;
  #updatingViewportProximities = false;
  #scrollableElement: HTMLElement | undefined = $state();
  #unsubscribes: Array<() => void> = [];

  get showAssetOwners() {
    return userPreferencesManager.showAssetOwners;
  }

  setShowAssetOwners(value: boolean) {
    userPreferencesManager.showAssetOwners = value;
  }

  toggleShowAssetOwners() {
    userPreferencesManager.showAssetOwners = !userPreferencesManager.showAssetOwners;
  }

  constructor() {
    super();

    this.#unsubscribes.push(
      eventManager.on({
        AssetUpdate: (asset: AssetResponseDto) => {
          const timelineAsset = toTimelineAsset(asset);
          if (this.#options.albumId || this.#options.personId) {
            this.#updateAssets([timelineAsset]);
          } else {
            this.upsertAssets([timelineAsset]);
          }
        },
        AssetsUnarchive: (assets) => this.upsertAssets(assets),
        AssetsMarkNsfw: (ids: string[]) => this.#handleMarkNsfw(ids),
        SessionLocked: () => {
          this.initTask.cancel();
          this.months = [];
          this.albumAssets.clear();
        },
        SessionAccessChanged: () => void trackSessionLockRefresh(this.refresh()),
        PartnerRevoke: (revoke) => this.#handlePartnerRevoke(revoke),
      }),
    );
  }

  /**
   * FL-54: a partner who stops sharing takes their photos out of every open timeline at once. A
   * timeline that could hold them (the main one with partners, or that partner's own library) drops
   * the months it loaded and reads them again, so nothing of theirs stays on screen or cached here.
   */
  #handlePartnerRevoke({ sharedById, sharedWithId }: { sharedById: string; sharedWithId: string }) {
    if (!authManager.authenticated || sharedWithId !== authManager.user.id) {
      return;
    }
    if (this.#options.withPartners || this.#options.userId === sharedById) {
      void this.refresh();
    }
  }

  /**
   * The query the time buckets were asked with (the view's filters and the viewer's key), for a
   * request that must cover exactly the same assets — the curated Years and Months cards (FL-33).
   */
  get bucketQuery() {
    const options = { ...this.#options };
    delete options.timelineAlbumId;
    delete options.deferInit;
    delete options.assetFilter;
    return { ...authManager.params, ...options };
  }

  override get scrollTop(): number {
    return this.#scrollableElement?.scrollTop ?? 0;
  }

  set scrollableElement(element: HTMLElement | undefined) {
    this.#scrollableElement = element;
  }

  scrollTo(top: number) {
    this.#scrollableElement?.scrollTo({ top });
    this.updateSlidingWindow();
  }

  scrollBy(y: number) {
    this.#scrollableElement?.scrollBy(0, y);
    this.updateSlidingWindow();
  }

  async *assetsIterator(options?: {
    startTimelineMonth?: TimelineMonth;
    startTimelineDay?: TimelineDay;
    startAsset?: TimelineAsset;
    direction?: Direction;
  }) {
    const direction = options?.direction ?? 'earlier';
    let { startTimelineDay, startAsset } = options ?? {};
    for (const timelineMonth of this.timelineMonthIterator({
      direction,
      startTimelineMonth: options?.startTimelineMonth,
    })) {
      await this.loadTimelineMonth(timelineMonth.yearMonth, { cancelable: false });
      yield* timelineMonth.assetsIterator({ startTimelineDay, startAsset, direction });
      startTimelineDay = startAsset = undefined;
    }
  }

  *timelineMonthIterator(options?: { direction?: Direction; startTimelineMonth?: TimelineMonth }) {
    const isEarlier = options?.direction === 'earlier';
    let startIndex = options?.startTimelineMonth
      ? this.months.indexOf(options.startTimelineMonth)
      : isEarlier
        ? 0
        : this.months.length - 1;

    while (startIndex >= 0 && startIndex < this.months.length) {
      yield this.months[startIndex];
      startIndex += isEarlier ? 1 : -1;
    }
  }

  connect() {
    if (this.#websocketSupport) {
      throw new Error('TimelineManager already connected');
    }
    this.#websocketSupport = new WebsocketSupport(this);
    this.#websocketSupport.connectWebsocketEvents();
  }

  disconnect() {
    if (!this.#websocketSupport) {
      return;
    }
    this.#websocketSupport.disconnectWebsocketEvents();
    this.#websocketSupport = undefined;
  }

  #calculateMonthBottomViewportRatio(month: TimelineMonth | undefined) {
    if (!month) {
      return 0;
    }
    const windowHeight = this.visibleWindow.bottom - this.visibleWindow.top;
    const bottomOfMonth = month.top + month.height;
    const bottomOfMonthInViewport = bottomOfMonth - this.visibleWindow.top;
    return clamp(bottomOfMonthInViewport / windowHeight, 0, 1);
  }

  #calculateVewportTopRatioInMonth(month: TimelineMonth | undefined) {
    if (!month) {
      return 0;
    }
    return clamp((this.visibleWindow.top - month.top) / month.height, 0, 1);
  }

  override updateViewportProximities() {
    if (
      this.#updatingViewportProximities ||
      !this.isInitialized ||
      this.visibleWindow.bottom === this.visibleWindow.top
    ) {
      return;
    }
    this.#updatingViewportProximities = true;

    for (const month of this.months) {
      updateTimelineMonthViewportProximity(this, month);
      if (month.isInOrNearViewport && month.isLoaded) {
        for (const day of month.timelineDays) {
          day.updateAssetBoundaries();
        }
      }
    }

    const month = this.months.find((month) => month.isInViewport);
    const viewportTopRatioInMonth = this.#calculateVewportTopRatioInMonth(month);
    const monthBottomViewportRatio = this.#calculateMonthBottomViewportRatio(month);

    this.viewportTopMonthIntersection = {
      month,
      monthBottomViewportRatio,
      viewportTopRatioInMonth,
    };

    this.#updatingViewportProximities = false;
    // A row that could not run on across a month boundary while that part of the timeline was on
    // screen runs on once it has scrolled away (FL-143).
    linkFlows(this);
  }

  clearDeferredLayout(month: TimelineMonth) {
    const hasDeferred = month.timelineDays.some((group) => group.deferredLayout);
    if (hasDeferred) {
      updateGeometry(this, month, { invalidateHeight: true, noDefer: true });
      for (const group of month.timelineDays) {
        group.deferredLayout = false;
      }
    }
  }

  /** FL-30 (S-15): the flat order the assets are laid out in, or undefined for the dated timeline. */
  get ordered() {
    return this.#options.orderedBy;
  }

  async #initializeTimelineMonths() {
    const revision = sessionAccess.revision;
    const timebuckets = await getTimeBuckets({
      ...authManager.params,
      ...this.#options,
    });

    if (revision !== sessionAccess.revision) {
      return;
    }

    if (this.#options.orderedBy) {
      // The same assets, counted by the buckets, paged in the flat order: one synthetic "month" per
      // page, in page order, so loading, layout, selection and the viewer work unchanged.
      const total = timebuckets.reduce((sum, bucket) => sum + bucket.count, 0);
      const pages = Math.ceil(total / ORDERED_PAGE_SIZE);
      this.months = Array.from(
        { length: pages },
        (_, page) =>
          new TimelineMonth(
            this,
            orderedPageYearMonth(page),
            Math.min(ORDERED_PAGE_SIZE, total - page * ORDERED_PAGE_SIZE),
            false,
            this.#options.order,
            this.#options.dateType,
            '',
          ),
      );
      this.albumAssets.clear();
      this.updateViewportGeometry(false);
      return;
    }

    this.months = timebuckets.map((timeBucket) => {
      const date = new SvelteDate(timeBucket.timeBucket);
      return new TimelineMonth(
        this,
        { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 },
        timeBucket.count,
        false,
        this.#options.order,
        this.#options.dateType,
      );
    });
    this.albumAssets.clear();
    this.updateViewportGeometry(false);
  }

  async updateOptions(options: TimelineManagerOptions) {
    if (options.deferInit) {
      return;
    }
    if (this.#options !== TimelineManager.#INIT_OPTIONS && isEqual(this.#options, options)) {
      return;
    }

    this.suspendTransitions = true;
    try {
      await this.initTask.reset();
      await this.#init(options);
      this.updateViewportGeometry(false);
      this.#createScrubberMonths();
    } finally {
      this.suspendTransitions = false;
    }
  }

  async refresh() {
    if (this.#options === TimelineManager.#INIT_OPTIONS || this.#options.deferInit) {
      return;
    }

    this.suspendTransitions = true;
    try {
      await this.initTask.reset();
      await this.#init(this.#options);
      this.updateViewportGeometry(false);
      this.#createScrubberMonths();
    } finally {
      this.suspendTransitions = false;
    }
  }

  async #init(options: TimelineManagerOptions) {
    this.isInitialized = false;
    this.months = [];
    this.albumAssets.clear();
    // The server re-applies its NSFW filter on reload, so drop the locally
    // tracked ids to avoid hiding assets that may since have been marked safe.
    this.#nsfwHiddenAssetIds.clear();
    await this.initTask.execute(async () => {
      this.#options = options;
      await this.#initializeTimelineMonths();
    }, true);
  }

  public override destroy() {
    this.disconnect();
    this.isInitialized = false;

    for (const unsubscribe of this.#unsubscribes) {
      unsubscribe();
    }

    super.destroy();
  }

  async updateViewport(viewport: Viewport) {
    if (viewport.height === 0 && viewport.width === 0) {
      return;
    }

    if (this.viewportHeight === viewport.height && this.viewportWidth === viewport.width) {
      return;
    }

    if (!this.initTask.executed) {
      await (this.initTask.loading ? this.initTask.waitUntilCompletion() : this.#init(this.#options));
    }

    const changedWidth = viewport.width !== this.viewportWidth;
    this.viewportHeight = viewport.height;
    this.viewportWidth = viewport.width;
    this.updateViewportGeometry(changedWidth);
  }

  protected override updateViewportGeometry(changedWidth: boolean) {
    if (!this.isInitialized || this.hasEmptyViewport) {
      return;
    }
    batchFlow(this, () => {
      for (const month of this.months) {
        updateGeometry(this, month, { invalidateHeight: changedWidth });
      }
    });
    this.updateViewportProximities();
    if (changedWidth) {
      this.#createScrubberMonths();
    }
  }

  #createScrubberMonths() {
    // A flat order has no dates to scrub through.
    this.scrubberMonths = (this.ordered ? [] : this.months).map((month) => ({
      assetCount: month.assetsCount,
      year: month.yearMonth.year,
      month: month.yearMonth.month,
      title: month.title,
      height: month.height,
    }));
    this.scrubberTimelineHeight = this.totalViewerHeight;
  }

  async loadTimelineMonth(yearMonth: TimelineYearMonth, options?: { cancelable: boolean }): Promise<void> {
    const cancelable = options?.cancelable ?? true;
    const timelineMonth = getTimelineMonthByDate(this, yearMonth);
    if (!timelineMonth) {
      return;
    }

    if (timelineMonth.loader?.executed) {
      return;
    }

    const executionStatus = await timelineMonth.loader?.execute(async (signal: AbortSignal) => {
      await (this.#options.orderedBy
        ? loadOrderedPage(timelineMonth, this.months.indexOf(timelineMonth), this.#options, signal)
        : loadFromTimeBuckets(this, timelineMonth, this.#options, signal));
    }, cancelable);
    if (executionStatus === 'LOADED') {
      updateGeometry(this, timelineMonth, { invalidateHeight: false });
      this.updateViewportProximities();
    }
  }

  upsertAssets(assets: TimelineAsset[]) {
    const notUpdated = this.#updateAssets(assets);
    // A flat order only learns where a new item belongs from the server, on the next load.
    if (this.ordered) {
      return;
    }
    const notExcluded = notUpdated.filter((asset) => !this.isExcluded(asset));
    this.addAssetsUpsertSegments([...notExcluded]);
  }

  upsertAssetsFromLiveEvent(assets: TimelineAsset[]) {
    const notUpdated = this.#updateAssets(assets);
    if (this.ordered) {
      return;
    }
    const insertable = notUpdated.filter((asset) => this.canInsertAssetFromLiveEvent(asset));
    this.addAssetsUpsertSegments(insertable);
  }

  async findTimelineMonthForAsset(asset: AssetDescriptor | AssetResponseDto) {
    if (!this.isInitialized) {
      await this.initTask.waitUntilExecution();
    }

    const { id } = asset;
    let { timelineMonth } = findTimelineMonthForAssetUtil(this, id) ?? {};
    if (timelineMonth) {
      return timelineMonth;
    }

    const response = isAssetResponseDto(asset)
      ? asset
      : await getAssetInfo({ ...authManager.params, id }).catch(() => null);
    if (!response) {
      return;
    }

    const timelineAsset = toTimelineAsset(response);
    if (this.isExcluded(timelineAsset)) {
      return;
    }

    if (this.ordered) {
      // No date says which page holds it: read the pages in order until it turns up.
      for (const month of this.months) {
        if (month.isLoaded) {
          continue;
        }
        await this.loadTimelineMonth(month.yearMonth, { cancelable: false });
        if (month.findAssetById({ id })) {
          return month;
        }
      }
      return;
    }

    timelineMonth = await this.#loadTimelineMonthAtTime(
      getOrderingDate(timelineAsset, this.#options.dateType || TimeBucketDateType.Taken),
      { cancelable: false },
    );
    if (timelineMonth?.findAssetById({ id })) {
      return timelineMonth;
    }
  }

  async #loadTimelineMonthAtTime(yearMonth: TimelineYearMonth, options?: { cancelable: boolean }) {
    await this.loadTimelineMonth(yearMonth, options);
    return getTimelineMonthByDate(this, yearMonth);
  }

  getTimelineMonthByAssetId(assetId: string) {
    const timelineMonthInfo = findTimelineMonthForAssetUtil(this, assetId);
    return timelineMonthInfo?.timelineMonth;
  }

  // note: the `index` input is expected to be in the range [0, assetCount). This
  // value can be passed to make the method deterministic, which is mainly useful
  // for testing.
  async getRandomAsset(index?: number): Promise<TimelineAsset | undefined> {
    const randomAssetIndex = index ?? Math.floor(Math.random() * this.assetCount);

    let accumulatedCount = 0;

    let randomMonth: TimelineMonth | undefined = undefined;
    for (const month of this.months) {
      if (randomAssetIndex < accumulatedCount + month.assetsCount) {
        randomMonth = month;
        break;
      }

      accumulatedCount += month.assetsCount;
    }
    if (!randomMonth) {
      return;
    }
    await this.loadTimelineMonth(randomMonth.yearMonth, { cancelable: false });

    let randomDay: TimelineDay | undefined = undefined;
    for (const day of randomMonth.timelineDays) {
      if (randomAssetIndex < accumulatedCount + day.viewerAssets.length) {
        randomDay = day;
        break;
      }

      accumulatedCount += day.viewerAssets.length;
    }
    if (!randomDay) {
      return;
    }

    return randomDay.viewerAssets[randomAssetIndex - accumulatedCount].asset;
  }

  /**
   * Executes callback on assets, handling moves between groups and removals due to filter criteria.
   */
  update(ids: string[], callback: (asset: TimelineAsset) => void) {
    return this.#runAssetCallback(new Set(ids), callback);
  }

  removeAssets(ids: string[]) {
    const result = this.#runAssetCallback(new Set(ids), () => ({ remove: true }));
    return [...result.notUpdated];
  }

  /**
   * Whether an item whose lock just changed still belongs in this view (FL-34). A newly locked item
   * stays in the Locked view and in an unlocked session's timeline, which reveals the owner's marks;
   * a newly unlocked item leaves the Locked view only.
   */
  keepsAfterLockChange(locked: boolean): boolean {
    const isLockedView = this.#options.visibility === AssetVisibility.Locked;
    return locked ? isLockedView || revealsLocks(this.#options) : !isLockedView;
  }

  // Marking an item sensitive locks it (FL-34), so every view drops it except the Locked view, which
  // is where it now lives, and an unlocked session's timeline, which reveals the owner's marks: there
  // it stays, badged as sensitive, exactly as the server returns it on the next load.
  #handleMarkNsfw(ids: string[]) {
    if (this.#options.visibility === AssetVisibility.Locked) {
      return;
    }
    if (revealsLocks(this.#options)) {
      this.update(ids, (asset) => {
        asset.visibility = AssetVisibility.Locked;
        asset.lockReason = AssetLockReason.Marked;
      });
      return;
    }
    for (const id of ids) {
      this.#nsfwHiddenAssetIds.add(id);
    }
    this.removeAssets(ids);
  }

  protected upsertSegmentForAsset(asset: TimelineAsset) {
    const dateTime = getOrderingDate(asset, this.#options.dateType || TimeBucketDateType.Taken);
    let month = getTimelineMonthByDate(this, dateTime);

    if (!month) {
      month = new TimelineMonth(this, dateTime, 1, true, this.#options.order, this.#options.dateType);
      this.months.push(month);
    }
    return month;
  }

  /**
   * Adds assets to existing segments, creating new segments as needed.
   *
   * This is an internal method that assumes the provided assets are not already
   * present in the timeline. For updating existing assets, use updateAssetOperation().
   */
  protected addAssetsUpsertSegments(assets: TimelineAsset[]) {
    if (assets.length === 0 || this.ordered) {
      return;
    }
    const context = new GroupInsertionCache();
    const monthCount = this.months.length;
    for (const asset of assets) {
      this.upsertSegmentForAsset(asset).addTimelineAsset(asset, context);
    }
    if (this.months.length !== monthCount) {
      this.postCreateSegments();
    }
    this.postUpsert(context);
  }

  #updateAssets(assets: TimelineAsset[]) {
    const cache = new Map<string, TimelineAsset>(assets.map((asset) => [asset.id, asset]));
    const idsToUpdate = new Set(cache.keys());
    const result = this.#runAssetCallback(idsToUpdate, (asset) => void updateObject(asset, cache.get(asset.id)));
    const notUpdated: TimelineAsset[] = Array.from(result.notUpdated, (assetId) => cache.get(assetId)!);
    return notUpdated;
  }

  #runAssetCallback(ids: Set<string>, callback: (asset: TimelineAsset) => void | { remove?: boolean }) {
    if (ids.size === 0) {
      return { updated: new Set<string>(), notUpdated: ids, changedGeometry: false };
    }
    if (this.#options.orderedBy === 'rating') {
      // Ordered by rating, a new rating moves the item: the pages are read again in the new order.
      let reordered = false;
      const result = this.#runAssetCallbackInPlace(ids, (asset) => {
        const before = asset.rating ?? null;
        const outcome = callback(asset);
        reordered ||= (asset.rating ?? null) !== before;
        return outcome;
      });
      if (reordered) {
        // Read the new order, and stay where the person was rather than jumping to the top.
        const top = this.#scrollableElement?.scrollTop ?? 0;
        void this.refresh().then(() => {
          if (top > 0) {
            this.scrollTo(top);
          }
        });
      }
      return result;
    }
    return this.#runAssetCallbackInPlace(ids, callback);
  }

  #runAssetCallbackInPlace(ids: Set<string>, callback: (asset: TimelineAsset) => void | { remove?: boolean }) {
    const changedTimelineMonths = new Set<TimelineMonth>();
    let notUpdated = new Set(ids);
    const updated = new Set<string>();
    const assetsToMoveSegments: MoveAsset[][] = [];
    for (const month of this.months) {
      if (notUpdated.size === 0) {
        break;
      }
      const result = month.runAssetCallback(notUpdated, callback);
      if (result.moveAssets.length > 0) {
        assetsToMoveSegments.push(result.moveAssets);
      }
      if (result.changedGeometry) {
        changedTimelineMonths.add(month);
      }
      notUpdated = setDifference(notUpdated, result.processedIds);
      for (const id of result.processedIds) {
        updated.add(id);
      }
    }
    const assetsToAdd = [];
    for (const segment of assetsToMoveSegments) {
      for (const moveAsset of segment) {
        assetsToAdd.push(moveAsset.asset);
      }
    }
    this.addAssetsUpsertSegments(assetsToAdd);
    const changedGeometry = changedTimelineMonths.size > 0;
    batchFlow(this, () => {
      for (const month of changedTimelineMonths) {
        updateGeometry(this, month, { invalidateHeight: true });
      }
    });
    if (changedGeometry) {
      this.updateViewportProximities();
    }
    return { updated, notUpdated, changedGeometry };
  }

  override refreshLayout() {
    batchFlow(this, () => {
      for (const month of this.months) {
        updateGeometry(this, month, { invalidateHeight: true });
      }
    });
    this.updateViewportProximities();
  }

  getFirstAsset(): TimelineAsset | undefined {
    return this.months[0]?.getFirstAsset();
  }

  async getLaterAsset(
    assetDescriptor: AssetDescriptor | AssetResponseDto,
    interval: 'asset' | 'day' | 'month' | 'year' = 'asset',
  ): Promise<TimelineAsset | undefined> {
    return await getAssetWithOffset(this, assetDescriptor, interval, 'later');
  }

  async getEarlierAsset(
    assetDescriptor: AssetDescriptor | AssetResponseDto,
    interval: 'asset' | 'day' | 'month' | 'year' = 'asset',
  ): Promise<TimelineAsset | undefined> {
    return await getAssetWithOffset(this, assetDescriptor, interval, 'earlier');
  }

  async getClosestAssetToDate(dateTime: TimelineDateTime) {
    let timelineMonth = findTimelineMonthForDate(this, dateTime);
    if (!timelineMonth) {
      // if exact match not found, find closest
      timelineMonth = findClosestTimelineMonthForDate(this.months, dateTime);
      if (!timelineMonth) {
        return;
      }
    }
    await this.loadTimelineMonth(dateTime, { cancelable: false });
    const asset = timelineMonth.findClosest(dateTime);
    if (asset) {
      return asset;
    }
    for await (const asset of this.assetsIterator({ startTimelineMonth: timelineMonth })) {
      return asset;
    }
  }

  async retrieveRange(start: AssetDescriptor, end: AssetDescriptor) {
    return retrieveRangeUtil(this, start, end, this.ordered ? this.#orderedPositions() : undefined);
  }

  /**
   * Where each item sits in a flat order (page, then place on the page), as one id → index map for a
   * whole range. Pages the range loads on the way are indexed when first asked about, not rescanned.
   */
  #orderedPositions() {
    const positions = new Map<string, number>();
    const indexed = new Set<TimelineMonth>();
    const index = () => {
      for (const [page, month] of this.months.entries()) {
        if (indexed.has(month) || !month.isLoaded) {
          continue;
        }
        indexed.add(month);
        for (const [place, viewerAsset] of (month.timelineDays[0]?.viewerAssets ?? []).entries()) {
          positions.set(viewerAsset.id, page * ORDERED_PAGE_SIZE + place);
        }
      }
    };
    index();
    return (asset: TimelineAsset): number => {
      if (!positions.has(asset.id)) {
        index();
      }
      return positions.get(asset.id) ?? Infinity;
    };
  }

  /**
   * FL-34: an unlocked session reveals the owner's own sensitive marks and detections in the timeline
   * ("Revealed for this session"); the server sends them with visibility `locked` and their reason.
   * Anything else locked never belongs to a timeline view.
   */
  #isVisibilityMismatch(asset: TimelineAsset) {
    const revealed =
      this.#options.visibility === AssetVisibility.Timeline &&
      asset.visibility === AssetVisibility.Locked &&
      (asset.lockReason === AssetLockReason.Marked || asset.lockReason === AssetLockReason.Detected);
    return !revealed && isMismatched(this.#options.visibility, asset.visibility);
  }

  isExcluded(asset: TimelineAsset) {
    return (
      this.#nsfwHiddenAssetIds.has(asset.id) ||
      this.#isVisibilityMismatch(asset) ||
      isMismatched(this.#options.isFavorite, asset.isFavorite) ||
      isMismatched(this.#options.isTrashed, asset.isTrashed) ||
      (this.#options.tagId && asset.tags && !asset.tags.includes(this.#options.tagId)) ||
      (this.#options.assetFilter !== undefined && !this.#options.assetFilter.has(asset.id))
    );
  }

  canInsertAssetFromLiveEvent(asset: TimelineAsset) {
    if (this.isExcluded(asset)) {
      return false;
    }
    if (this.#options.albumId || this.#options.personId || this.#options.timelineAlbumId) {
      return false;
    }
    if (this.#options.userId && !this.#options.withPartners && asset.ownerId !== this.#options.userId) {
      return false;
    }
    return true;
  }

  getAssetOrder() {
    return this.#options.order ?? AssetOrder.Desc;
  }

  getDateType() {
    return this.#options.dateType ?? TimeBucketDateType.Taken;
  }

  protected postCreateSegments(): void {
    this.months.sort((a, b) => {
      return a.yearMonth.year === b.yearMonth.year
        ? b.yearMonth.month - a.yearMonth.month
        : b.yearMonth.year - a.yearMonth.year;
    });
  }

  protected postUpsert(context: GroupInsertionCache): void {
    for (const group of context.existingTimelineDays) {
      group.sortAssets(this.#options.order);
    }

    for (const timelineMonth of context.bucketsWithNewTimelineDays) {
      timelineMonth.sortTimelineDays();
    }

    batchFlow(this, () => {
      for (const month of context.updatedBuckets) {
        month.sortTimelineDays();
        updateGeometry(this, month, { invalidateHeight: true });
      }
    });
    this.updateViewportProximities();
  }
}
