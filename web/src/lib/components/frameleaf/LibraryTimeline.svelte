<script lang="ts">
  /**
   * The Frameleaf timeline: justified rows that respect each item's aspect, sticky day headers with
   * a day select-all, and a draggable year and month scrubber.
   *
   * Ported for FL-33 from `design/frameleaf/template/src/TimelineLibrary.jsx`. The prototype holds
   * the whole library in memory and lays all of it out; production does not. This component drives
   * the existing `TimelineManager`, so months are loaded, laid out and mounted a bucket at a time,
   * and the justified layout runs inside the manager (`fillRowWidth`) rather than over a list of
   * assets here.
   *
   * Selection, the open item and the page state come from the one live library session, so the
   * Browse and Work layouts show the same state without rebuilding it.
   */
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import LibraryDayGroup from '$lib/components/frameleaf/LibraryDayGroup.svelte';
  import YearScrubber from '$lib/components/frameleaf/YearScrubber.svelte';
  import { focusAsset } from '$lib/components/timeline/actions/focus-actions';
  import Skeleton from '$lib/elements/Skeleton.svelte';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { isIntersecting } from '$lib/managers/timeline-manager/internal/intersection-support.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineMonth } from '$lib/managers/timeline-manager/timeline-month.svelte';
  import type { TimelineAsset, ViewportTopMonth } from '$lib/managers/timeline-manager/types';
  import { filterIsInOrNearViewport } from '$lib/managers/timeline-manager/utils.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { isAssetViewerRoute } from '$lib/utils/navigation';
  import type { ScrubberListener } from '$lib/utils/timeline-util';
  import { tick, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    timelineManager: TimelineManager;
    session: LibrarySessionStore;
    /** Rating for an asset, supplied by the host; the timeline model does not carry one. */
    ratingFor?: (asset: TimelineAsset) => number | null;
    /** Browse hides the sticky day headers; Timeline and Work keep them. */
    showDayHeaders?: boolean;
    captionFor?: (asset: TimelineAsset) => string | null;
    /** Restore the scroll position from the URL's asset and from the session's scroll anchor. */
    enableRouting?: boolean;
    onOpen?: (asset: TimelineAsset) => void;
    /** Rendered above the timeline; the results toolbar and any page header go here. */
    header?: Snippet;
    empty?: Snippet;
  };

  let {
    timelineManager,
    session,
    ratingFor,
    showDayHeaders = true,
    captionFor,
    enableRouting = false,
    onOpen,
    header,
    empty,
  }: Props = $props();

  let scrollable = $state<HTMLElement>();
  let scrubberWidth = $state(0);
  let viewportTopMonth: ViewportTopMonth = $state(undefined);
  let viewportTopMonthScrollPercent = $state(0);
  let timelineScrollPercent = $state(0);
  let rangePending = $state(false);

  const maxMd = $derived(mediaQueryManager.maxMd);
  const coarsePointer = $derived(mediaQueryManager.pointerCoarse);
  const isEmpty = $derived(timelineManager.isInitialized && timelineManager.months.length === 0);
  const selection = $derived(session.selection);
  const selecting = $derived(selection.length > 0);

  $effect(() => {
    // The filling justified layout is what makes a short day group span the timeline.
    timelineManager.setLayoutOptions(
      maxMd
        ? { rowHeight: 100, headerHeight: 32, gap: 8, fillRowWidth: true }
        : { rowHeight: 235, headerHeight: 48, gap: 12, fillRowWidth: true },
    );
  });

  $effect(() => {
    timelineManager.scrollableElement = scrollable;
  });

  /* ------------------------------------------------------------------ */
  /* Scroll restoration                                                  */
  /* ------------------------------------------------------------------ */

  // Ported from the upstream timeline so the Frameleaf layouts keep the same behaviour: coming
  // back from the viewer, or following a link that names an asset, lands on that asset rather than
  // at the top. The layout sets `display: none` on this subtree while the viewer is open and
  // browsers drop the scroll offset of a hidden element, hence the remembered offset.
  let lastVisibleScrollTop = 0;

  const scrollToAssetPosition = (assetId: string, month: TimelineMonth) => {
    const position = month.findAssetAbsolutePosition(assetId);
    if (!position) {
      return;
    }
    // <Portal> may have gone from invisible to visible, so the window positions are stale.
    timelineManager.updateSlidingWindow();
    const assetTop = position.top;
    const assetBottom = position.top + position.height;
    const visibleTop = timelineManager.visibleWindow.top;
    const visibleBottom = timelineManager.visibleWindow.bottom;
    if (isIntersecting(assetTop, assetBottom, visibleTop, visibleBottom)) {
      return;
    }
    const currentTop = scrollable?.scrollTop ?? 0;
    const viewportHeight = visibleBottom - visibleTop;
    const alignTop = assetTop;
    const alignBottom = assetBottom - viewportHeight;
    // Whichever alignment moves the least.
    timelineManager.scrollTo(
      Math.abs(alignTop - currentTop) < Math.abs(alignBottom - currentTop) ? alignTop : alignBottom,
    );
  };

  const scrollToAssetId = async (assetId: string, load = true) => {
    const known = timelineManager.getTimelineMonthByAssetId(assetId);
    if (known) {
      scrollToAssetPosition(assetId, known);
      return true;
    }
    if (!load) {
      return false;
    }
    try {
      // Disabling layout deferral keeps the scroll height in step with the position we compute.
      timelineManager.isScrollingOnLoad = true;
      const month = await timelineManager.findTimelineMonthForAsset({ id: assetId });
      if (!month) {
        return false;
      }
      scrollToAssetPosition(assetId, month);
      return true;
    } finally {
      timelineManager.isScrollingOnLoad = false;
    }
  };

  const scrollAfterNavigate = async () => {
    if (timelineManager.viewportHeight === 0 || timelineManager.viewportWidth === 0) {
      const rect = scrollable?.getBoundingClientRect();
      if (rect) {
        timelineManager.viewportHeight = rect.height;
        timelineManager.viewportWidth = rect.width;
      }
    }
    // The URL's asset wins; otherwise the session's own scroll anchor decides where we land.
    const target = assetViewerManager.gridScrollTarget?.at ?? session.session.scrollAnchor;
    const scrolled = target ? await scrollToAssetId(target) : false;
    if (scrolled && assetViewerManager.gridScrollTarget?.at) {
      await tick();
      focusAsset(assetViewerManager.gridScrollTarget.at);
    } else if (!scrolled && lastVisibleScrollTop > 0) {
      timelineManager.scrollTo(lastVisibleScrollTop);
    }
  };

  beforeNavigate(({ from, to }) => {
    if (!enableRouting) {
      return;
    }
    timelineManager.suspendTransitions = true;
    if (isAssetViewerRoute(to) !== isAssetViewerRoute(from)) {
      // Going into or out of the viewer: remember where the grid was so we can come back to it.
      lastVisibleScrollTop = scrollable?.scrollTop ?? lastVisibleScrollTop;
    }
  });

  afterNavigate(({ complete }) => {
    if (!enableRouting) {
      return;
    }
    void complete.finally(() => void scrollAfterNavigate());
  });

  // A layout switch changes the geometry but not the session: come back to the same asset.
  let lastLayout = session.layout;
  $effect(() => {
    const layout = session.layout;
    if (layout === lastLayout) {
      return;
    }
    lastLayout = layout;
    const anchor = session.session.scrollAnchor;
    if (anchor) {
      void tick().then(() => scrollToAssetId(anchor, false));
    }
  });

  const scrollToSegmentPercentage = (segmentTop: number, segmentHeight: number, percent: number) => {
    const maxScrollPercent = timelineManager.maxScrollPercent;
    timelineManager.scrollTo((segmentTop + segmentHeight * percent) * maxScrollPercent);
  };

  /**
   * Scrubber positions map onto the manager's own segments. Shared with the upstream timeline so
   * there is one scroll implementation, not two.
   */
  const onScrub: ScrubberListener = ({ scrubberMonth, overallScrollPercent, scrubberMonthScrollPercent }) => {
    if (!scrubberMonth || timelineManager.limitedScroll) {
      const offset = timelineManager.maxScrollPercent * overallScrollPercent * timelineManager.totalViewerHeight;
      timelineManager.scrollTo(offset);
      return;
    }
    if (scrubberMonth === 'lead-in') {
      scrollToSegmentPercentage(0, timelineManager.topSectionHeight, scrubberMonthScrollPercent);
      return;
    }
    if (scrubberMonth === 'lead-out') {
      scrollToSegmentPercentage(
        timelineManager.topSectionHeight + timelineManager.bodySectionHeight,
        timelineManager.bottomSectionHeight,
        scrubberMonthScrollPercent,
      );
      return;
    }
    const month = timelineManager.months.find(
      ({ yearMonth }) => yearMonth.year === scrubberMonth.year && yearMonth.month === scrubberMonth.month,
    );
    if (month) {
      scrollToSegmentPercentage(month.top, month.height, scrubberMonthScrollPercent);
    }
  };

  // note: don't throttle or debounce - it causes flicker
  const handleScroll = () => {
    if (!scrollable) {
      return;
    }
    timelineManager.updateSlidingWindow();
    timelineManager.scrolling = true;
    if (!assetViewerManager.isViewing) {
      lastVisibleScrollTop = scrollable.scrollTop;
    }

    if (timelineManager.limitedScroll) {
      timelineScrollPercent = Math.min(1, scrollable.scrollTop / Math.max(1, timelineManager.maxScroll));
      viewportTopMonth = undefined;
      viewportTopMonthScrollPercent = 0;
      return;
    }
    timelineScrollPercent = 0;
    let top = scrollable.scrollTop;
    const maxScrollPercent = timelineManager.maxScrollPercent;
    const months = timelineManager.months;
    for (let index = -1; index <= months.length; index++) {
      const segment: ViewportTopMonth =
        index === -1 ? 'lead-in' : index === months.length ? 'lead-out' : months[index].yearMonth;
      const segmentHeight =
        index === -1
          ? timelineManager.topSectionHeight
          : index === months.length
            ? timelineManager.bottomSectionHeight
            : months[index].height;
      const next = top - segmentHeight * maxScrollPercent;
      // a little wiggle room for subpixel resolution
      if (next < -1) {
        viewportTopMonth = segment;
        viewportTopMonthScrollPercent = Math.max(0, top / Math.max(1, segmentHeight * maxScrollPercent));
        break;
      }
      top = next;
    }
  };

  /** Every id currently loaded, in visible order: the order a shift-click range is taken against. */
  const orderedIds = () =>
    timelineManager.months.flatMap((month) =>
      month.timelineDays.flatMap((day) => day.viewerAssets.map((viewerAsset) => viewerAsset.id)),
    );

  const anchorAsset = () => {
    const anchorId = session.session.anchorId;
    if (!anchorId) {
      return null;
    }
    for (const month of timelineManager.months) {
      for (const day of month.timelineDays) {
        const match = day.viewerAssets.find((viewerAsset) => viewerAsset.id === anchorId);
        if (match?.asset) {
          return match.asset;
        }
      }
    }
    return null;
  };

  /**
   * Shift-click selects a range. The range may reach across months that are not loaded, so the
   * manager retrieves it — the component never walks the library itself.
   */
  const selectRange = async (asset: TimelineAsset) => {
    const start = anchorAsset();
    if (!start) {
      session.select(asset.id);
      return;
    }
    rangePending = true;
    try {
      const range = await timelineManager.retrieveRange(start, asset);
      const ids = range.map((item) => item.id);
      session.dispatch({ type: 'selection', ids: [...new Set([...session.selection, ...ids])] });
    } finally {
      rangePending = false;
    }
  };

  const onToggleSelect = (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => {
    if ('shiftKey' in event && event.shiftKey) {
      void selectRange(asset);
      return;
    }
    session.select(asset.id);
  };

  const handleOpen = (asset: TimelineAsset) => {
    // Opening an item is not selecting it; the viewer (FL-35) reads the session's open asset.
    session.open(asset.id);
    session.setScrollAnchor(asset.id);
    onOpen?.(asset);
  };
</script>

<div class="fl-timeline" data-testid="frameleaf-timeline">
  <section
    class="fl-timeline-scroll"
    tabindex="-1"
    bind:this={scrollable}
    bind:clientHeight={timelineManager.viewportHeight}
    bind:clientWidth={timelineManager.viewportWidth}
    style:margin-inline-end="{coarsePointer ? 0 : scrubberWidth}px"
    onscroll={handleScroll}
    aria-busy={rangePending}
  >
    <div class="fl-timeline-body" style:height="{timelineManager.totalViewerHeight}px">
      <div class="fl-timeline-top" bind:clientHeight={timelineManager.topSectionHeight}>
        {@render header?.()}
        {#if isEmpty}
          {@render empty?.()}
        {/if}
      </div>

      {#each timelineManager.months as month (month.viewId)}
        {#if !month.isLoaded}
          <div
            class="fl-month"
            style:height="{month.height}px"
            style:transform={`translate3d(0,${month.top}px,0)`}
          >
            <Skeleton height={month.height} title={month.title} />
          </div>
        {:else if month.isInOrNearViewport}
          <div
            class="fl-month"
            style:height="{month.height}px"
            style:transform={`translate3d(0,${month.top}px,0)`}
          >
            {#each filterIsInOrNearViewport(month.timelineDays) as timelineDay (timelineDay.day)}
              <LibraryDayGroup
                {timelineDay}
                {selection}
                {selecting}
                {ratingFor}
                {captionFor}
                showHeader={showDayHeaders}
                onOpen={handleOpen}
                {onToggleSelect}
                onSelectGroup={(ids, checked) => session.selectGroup(ids, checked)}
                onFocusAsset={(asset) => session.setScrollAnchor(asset.id)}
              />
            {/each}
          </div>
        {/if}
      {/each}

      <div
        class="fl-timeline-bottom"
        style:height="{timelineManager.bottomSectionHeight}px"
        style:transform={`translate3d(0,${timelineManager.topSectionHeight + timelineManager.bodySectionHeight}px,0)`}
      ></div>
    </div>
  </section>

  {#if timelineManager.months.length > 0}
    <YearScrubber
      {timelineManager}
      height={timelineManager.viewportHeight}
      {viewportTopMonth}
      {viewportTopMonthScrollPercent}
      {timelineScrollPercent}
      {onScrub}
      bind:scrubberWidth
    />
  {/if}
</div>

<span class="fl-sr" role="status" aria-live="polite">
  {#if rangePending}{$t('loading')}{/if}
</span>

<style>
  .fl-timeline {
    position: relative;
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .fl-timeline-scroll {
    flex: 1 1 auto;
    height: 100%;
    overflow-y: auto;
    outline: none;
    contain: strict;
    scrollbar-width: none;
  }
  .fl-timeline-body {
    position: relative;
  }
  .fl-timeline-top,
  .fl-timeline-bottom {
    position: absolute;
    inset-inline: 0;
  }
  .fl-month {
    position: absolute;
    inset-inline: 0;
    contain: layout size paint;
    backface-visibility: hidden;
  }
  .fl-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
