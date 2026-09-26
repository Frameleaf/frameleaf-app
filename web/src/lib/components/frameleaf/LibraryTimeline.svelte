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
  import LibraryGroupHeader from '$lib/components/frameleaf/LibraryGroupHeader.svelte';
  import TimelineCards from '$lib/components/frameleaf/TimelineCards.svelte';
  import { bindGridZoom } from '$lib/frameleaf/grid-zoom';
  import {
    cellGridOptions,
    stepThumbnailSize,
    THUMBNAIL_SIZE_DEFAULT,
    timelineRowHeight,
    type TileLayout,
    WORK_CAPTION_HEIGHT,
  } from '$lib/frameleaf/library-grid';
  import type { TileQuickActions } from '$lib/frameleaf/tile-actions';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { captureLibraryAnchor, restoreLibraryAnchor, type LibraryAnchor } from '$lib/frameleaf/library-layout';
  import { groupSelectionState } from '$lib/frameleaf/library-session';
  import { selectGroupAfterLoading, type GroupLoadOutcome } from '$lib/frameleaf/timeline-group-load';
  import { isMacPlatform } from '$lib/frameleaf/library-shortcuts';
  import { animateFlip } from '$lib/frameleaf/motion';
  import type { TimelineCardTarget } from '$lib/frameleaf/timeline-cards';
  import YearScrubber from '$lib/components/frameleaf/YearScrubber.svelte';
  import Skeleton from '$lib/elements/Skeleton.svelte';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { isIntersecting } from '$lib/managers/timeline-manager/internal/intersection-support.svelte';
  import type { TimelineDay } from '$lib/managers/timeline-manager/timeline-day.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineMonth } from '$lib/managers/timeline-manager/timeline-month.svelte';
  import type { TimelineAsset, TimelineGrouping, ViewportTopMonth } from '$lib/managers/timeline-manager/types';
  import { filterIsInOrNearViewport } from '$lib/managers/timeline-manager/utils.svelte';
  import type { ViewerAsset } from '$lib/managers/timeline-manager/viewer-asset.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { isAssetViewerRoute } from '$lib/utils/navigation';
  import { hasRouterStarted } from '$lib/utils/router-started';
  import { fromTimelinePlainYearMonth, type ScrubberListener } from '$lib/utils/timeline-util';
  import { onMount, tick, untrack, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { locale, t, type Translations } from 'svelte-i18n';

  type Props = {
    timelineManager: TimelineManager;
    session: LibrarySessionStore;
    /** Rating override for an asset; by default each tile shows the asset's own rating. */
    ratingFor?: (asset: TimelineAsset) => number | null;
    /** Only the Timeline layout draws the sticky day headers; the Browse and Work grids have none. */
    showDayHeaders?: boolean;
    /**
     * The tile layout (FL-33): Timeline's justified rows, Browse's square grid or Work's 3:2 grid with
     * captions. Browse and Work are cell grids, still laid out and mounted a month at a time.
     */
    tileLayout?: TileLayout;
    /** The per-device Thumbnail size (140–290) the grids and Timeline rows scale with. */
    thumbnailSize?: number;
    /** Work: show file names in the captions. */
    showFileNames?: boolean;
    /**
     * Called with a new Thumbnail size when a pinch, Ctrl-scroll or + / − zooms the Browse or Work
     * grid. Without it the grids do not zoom.
     */
    onThumbnailSizeChange?: (size: number) => void;
    /**
     * Group by day, month, year or everything (prototype `TimelineLibrary.jsx`). Applies where group
     * headers show; Browse, which has none, keeps its day flow.
     */
    grouping?: TimelineGrouping;
    /** Show the grouping control and accept ⌘/Ctrl+wheel and pinch; called with the new grouping. */
    onGroupingChange?: (grouping: TimelineGrouping) => void;
    /** Restore the scroll position from the URL's asset and from the session's scroll anchor. */
    enableRouting?: boolean;
    onOpen?: (asset: TimelineAsset) => void;
    /**
     * Picking mode: a plain click selects instead of opening the viewer. The album "add photos"
     * step, the person feature-photo picker and the geolocation utility all work this way.
     */
    selectionMode?: boolean;
    /** With `selectionMode`, a pick replaces the selection instead of adding to it. */
    singleSelect?: boolean;
    /** Called after a pick in `selectionMode`, with the asset that was picked. */
    onSelect?: (asset: TimelineAsset) => void;
    /**
     * Intercept a plain click on a tile. Return `true` when the page handled it, and the timeline
     * does nothing further; the geolocation utility reads an item's coordinates this way.
     */
    onTileClick?: (asset: TimelineAsset) => boolean;
    /** Extra chrome drawn over every tile by the page that mounts the timeline. */
    tileOverlay?: Snippet<[TimelineAsset]>;
    /** The hover quick actions each tile may offer (prototype `AssetTile.jsx` `.at-actions`). */
    quickActions?: (asset: TimelineAsset) => TileQuickActions | null;
    /**
     * Timeline captions (prototype `TimelineLibrary.jsx` `showCaptions`, on in every layout but
     * Browse). Work's cell grid reserves its own caption row.
     */
    timelineCaptions?: boolean;
    /** Rendered above the timeline; the results toolbar and any page header go here. */
    header?: Snippet;
    empty?: Snippet;
  };

  let {
    timelineManager,
    session,
    ratingFor,
    showDayHeaders = true,
    tileLayout = 'timeline',
    thumbnailSize = THUMBNAIL_SIZE_DEFAULT,
    showFileNames = false,
    onThumbnailSizeChange,
    grouping = 'days',
    onGroupingChange,
    enableRouting = false,
    onOpen,
    selectionMode = false,
    singleSelect = false,
    onSelect,
    onTileClick,
    tileOverlay,
    quickActions,
    timelineCaptions = false,
    header,
    empty,
  }: Props = $props();

  let scrollable = $state<HTMLElement>();
  let root = $state<HTMLElement>();
  let scrubberWidth = $state(0);
  /** While the scrubber is dragged, tiles drawn meanwhile wait for their thumbnails (`AssetTile`). */
  let scrubbing = $state(false);
  let viewportTopMonth: ViewportTopMonth = $state(undefined);
  let viewportTopMonthScrollPercent = $state(0);
  let timelineScrollPercent = $state(0);
  let rangePending = $state(false);

  const maxMd = $derived(mediaQueryManager.maxMd);
  const coarsePointer = $derived(mediaQueryManager.pointerCoarse);
  const isEmpty = $derived(timelineManager.isInitialized && timelineManager.months.length === 0);
  const selection = $derived(session.selection);
  // In picking mode the tiles show their checkboxes from the start, as the legacy grid did.
  const selecting = $derived(selection.length > 0 || (selectionMode && !singleSelect));

  /**
   * Timeline captions sit under each justified row (template timeline-library.css: the photo keeps
   * `--tl-h` and `.at-caption` follows it), so the manager adds the caption to the row pitch.
   */
  const rowCaptionHeight = $derived(tileLayout === 'timeline' && timelineCaptions ? WORK_CAPTION_HEIGHT : 0);

  /** Browse and Work lay each month out as a cell grid; `null` keeps Timeline's justified rows. */
  const cells = $derived(
    tileLayout === 'timeline' ? null : cellGridOptions(tileLayout, thumbnailSize, libraryGridPreferences.phone),
  );

  $effect(() => {
    if (cells) {
      // One gutter between months, so the grid reads as one surface (apple-style.css `gap: 2px`).
      timelineManager.setLayoutOptions({ headerHeight: cells.gap, gap: cells.gap, fillRowWidth: true, cells });
      return;
    }
    // The filling justified layout is what makes a short day group span the timeline. The space the
    // manager reserves above each day's rows is exactly what the day group draws there: its header
    // in the Timeline, a plain gap where there is none.
    // Thumbnail size scales the row height too; the default size keeps the default height.
    timelineManager.setLayoutOptions(
      maxMd
        ? {
            rowHeight: timelineRowHeight(100, thumbnailSize),
            headerHeight: showDayHeaders ? 32 : 8,
            gap: 8,
            fillRowWidth: true,
            captionHeight: rowCaptionHeight,
          }
        : {
            rowHeight: timelineRowHeight(235, thumbnailSize),
            headerHeight: showDayHeaders ? 48 : 12,
            gap: 12,
            fillRowWidth: true,
            captionHeight: rowCaptionHeight,
          },
    );
  });

  /*
   * A Thumbnail size change reflows every row, so the asset in view is held at the same height on
   * screen (template `App.jsx` restores its scroll anchor whenever `size` changes). The anchor is
   * read before the layout options change and put back once the months have been laid out again,
   * which happens synchronously: the width does not change, so nothing has to be measured.
   */
  let lastThumbnailSize = untrack(() => thumbnailSize);
  let sizeAnchor: LibraryAnchor | undefined;
  $effect.pre(() => {
    if (thumbnailSize === lastThumbnailSize) {
      return;
    }
    sizeAnchor = untrack(
      () =>
        captureLibraryAnchor(timelineManager, session.session.scrollAnchor) ?? captureLibraryAnchor(timelineManager),
    );
  });
  $effect(() => {
    const size = thumbnailSize;
    if (size === lastThumbnailSize) {
      return;
    }
    lastThumbnailSize = size;
    const anchor = sizeAnchor;
    sizeAnchor = undefined;
    untrack(() => restoreLibraryAnchor(timelineManager, anchor));
  });

  /**
   * Grid zoom (template `App.jsx` `zoomGrid`, `interactions.js` `animateGridChange`): one step of
   * the Thumbnail size, with the visible tiles sliding from their old boxes to their new ones.
   * Under Reduce Motion the change is instant (`animateFlip`).
   */
  const zoomGrid = (direction: 1 | -1) => {
    const next = stepThumbnailSize(thumbnailSize, direction);
    if (next === thumbnailSize || !onThumbnailSizeChange) {
      return;
    }
    animateFlip(scrollable, () => onThumbnailSizeChange(next));
  };

  // Browse and Work zoom with pinch, Ctrl-scroll and + / −; the Timeline keeps them for grouping.
  $effect(() => {
    const element = root;
    if (!element || tileLayout === 'timeline' || tileLayout === 'list' || !onThumbnailSizeChange) {
      return;
    }
    return bindGridZoom(element, {
      onZoom: zoomGrid,
      enabled: () => !session.openAssetId && !assetViewerManager.isViewing,
    });
  });

  $effect(() => {
    timelineManager.scrollableElement = scrollable;
    // A scroll area mounted anew (back from the Years or Months cards) starts at the top: the
    // manager's window must follow it, or it keeps the old offset and mounts no month at all.
    if (scrollable) {
      timelineManager.updateSlidingWindow();
    }
  });

  /**
   * The page hides this subtree (`display: none`) while the viewer is open, and a hidden element
   * measures 0 × 0. Handing those zeros to the manager would lay the library out for no width and
   * drop the header's height, so coming back from the viewer would land somewhere else. Only a
   * visible measurement is passed on.
   */
  let measuredHeight = $state(0);
  let measuredWidth = $state(0);
  let measuredTop = $state(0);
  let topElement = $state<HTMLElement>();
  let topEnd = $state<HTMLElement>();
  /** The header content's height: where its end marker sits, re-read whenever a part resizes. */
  $effect(() => {
    const element = topElement;
    const end = topEnd;
    if (!element || !end || typeof ResizeObserver !== 'function') {
      return;
    }
    const measure = () => {
      // Hidden (e.g. under the viewer) reads 0; keep the last real height.
      if (!end.offsetParent) {
        return;
      }
      measuredTop = end.offsetTop;
    };
    const resize = new ResizeObserver(measure);
    const observeChildren = () => {
      resize.disconnect();
      for (const child of element.children) {
        resize.observe(child);
      }
      measure();
    };
    const mutations = new MutationObserver(observeChildren);
    mutations.observe(element, { childList: true });
    observeChildren();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  });
  $effect(() => {
    if (measuredWidth === 0 || measuredHeight === 0) {
      return;
    }
    if (timelineManager.viewportWidth !== measuredWidth) {
      timelineManager.viewportWidth = measuredWidth;
    }
    if (timelineManager.viewportHeight !== measuredHeight) {
      timelineManager.viewportHeight = measuredHeight;
    }
    timelineManager.topSectionHeight = measuredTop;
  });

  /* ------------------------------------------------------------------ */
  /* Grouping                                                            */
  /* ------------------------------------------------------------------ */

  // Coarse to fine, as the prototype's MODES: ⌘/Ctrl+wheel and pinch step through this list.
  const MODES: TimelineGrouping[] = ['all', 'years', 'months', 'days'];
  const CONTROL_ORDER: TimelineGrouping[] = ['years', 'months', 'days', 'all'];
  const MODE_LABELS: Record<TimelineGrouping, Translations> = {
    years: 'frameleaf_library_grouping_years',
    months: 'frameleaf_library_grouping_months',
    days: 'frameleaf_library_grouping_days',
    all: 'frameleaf_library_grouping_all',
  };
  const ANNOUNCEMENTS: Record<TimelineGrouping, Translations> = {
    years: 'frameleaf_library_grouped_by_years',
    months: 'frameleaf_library_grouped_by_months',
    days: 'frameleaf_library_grouped_by_days',
    all: 'frameleaf_library_grouped_by_all',
  };
  const WHEEL_STEP = 60;
  const PINCH_STEP = 56;

  let announcement = $state('');

  /**
   * Years and Months are curated cards (September 24; template `TimelineLibrary.jsx` `curated`), not
   * tile flows: the manager keeps its day layout underneath, ready for a card that opens Days.
   */
  const curated = $derived(showDayHeaders && (grouping === 'years' || grouping === 'months'));
  const effectiveGrouping = $derived<TimelineGrouping>(showDayHeaders && !curated ? grouping : 'days');
  $effect(() => {
    timelineManager.grouping = effectiveGrouping;
  });

  const changeGrouping = (value: TimelineGrouping) => {
    if (!onGroupingChange || value === grouping) {
      return;
    }
    announcement = $t(ANNOUNCEMENTS[value]);
    onGroupingChange(value);
  };

  const stepGrouping = (delta: number) => {
    const index = MODES.indexOf(grouping);
    changeGrouping(MODES[Math.min(MODES.length - 1, Math.max(0, index + delta))]);
  };

  /** The year a Years card opened, whose months the Months cards bring to the top. */
  let focusYear = $state<number | null>(null);
  /** The month a Months card opened, which Days scrolls to once it is laid out. */
  let pendingMonth = $state<{ year: number; month: number } | null>(null);

  /** Template `openCard`: a card steps one level finer and scrolls to its period. */
  const openCard = (target: TimelineCardTarget) => {
    if (target.grouping === 'months') {
      focusYear = target.year;
    } else {
      pendingMonth = { year: target.year, month: target.month };
    }
    changeGrouping(target.grouping);
  };

  /*
   * Leaving the tile flow for the cards unmounts it, and coming back would start at the top. The
   * asset in view is remembered on the way out (read before the flow unmounts) and put back at the
   * same height on screen on the way in, unless a month card chose where Days opens.
   */
  let wasCurated = untrack(() => curated);
  let flowAnchor: LibraryAnchor | undefined;
  let flowScrollTop = 0;
  $effect.pre(() => {
    const now = curated;
    if (now && !wasCurated) {
      untrack(() => {
        flowAnchor =
          captureLibraryAnchor(timelineManager, session.session.scrollAnchor) ?? captureLibraryAnchor(timelineManager);
        flowScrollTop = scrollable?.scrollTop ?? 0;
      });
    }
  });
  $effect(() => {
    if (curated) {
      wasCurated = true;
      return;
    }
    // The flow mounts (and binds its scroll area) after the switch; wait for it before settling.
    if (!wasCurated || !scrollable) {
      return;
    }
    wasCurated = false;
    const anchor = flowAnchor;
    const top = flowScrollTop;
    flowAnchor = undefined;
    if (untrack(() => pendingMonth)) {
      return;
    }
    void tick()
      .then(nextFrame)
      .then(nextFrame)
      .then(() => {
        if (!restoreLibraryAnchor(timelineManager, anchor) && top > 0) {
          timelineManager.scrollTo(top);
        }
      });
  });

  /** The card at the top of the Years or Months view, as the scrubber's current month. */
  let cardTopMonth = $state<ViewportTopMonth>(undefined);
  let cards = $state<{ jumpTo: (month: { year: number; month: number }) => boolean }>();

  const onCardPeriod = (period: { year: number; month?: number } | undefined) => {
    if (!period) {
      cardTopMonth = undefined;
      return;
    }
    // A year card stands for the first of its months in display order.
    const month =
      period.month ?? timelineManager.months.find(({ yearMonth }) => yearMonth.year === period.year)?.yearMonth.month;
    cardTopMonth = month === undefined ? undefined : { year: period.year, month };
  };

  /** The scrubber over the cards: a month goes to its month card, or its year's (template `jumpTo`). */
  const onCardScrub: ScrubberListener = ({ scrubberMonth }) => {
    if (scrubberMonth && typeof scrubberMonth === 'object') {
      cards?.jumpTo(scrubberMonth);
    }
  };
  const onCardJump = (month: { year: number; month: number }) => {
    if (cards?.jumpTo(month)) {
      cardTopMonth = month;
    }
  };

  $effect(() => {
    const month = pendingMonth;
    if (!month || curated || !scrollable) {
      return;
    }
    pendingMonth = null;
    // The day layout mounts, is measured and laid out over the next frames; then the month's first
    // row goes to the top, as the scrubber's month jump does.
    void tick()
      .then(nextFrame)
      .then(nextFrame)
      .then(() => onJump(month));
  });

  // ⌘/Ctrl + wheel (also a trackpad pinch) and a two-finger pinch step the grouping.
  $effect(() => {
    const element = root;
    if (!element || !onGroupingChange || !showDayHeaders) {
      return;
    }
    let wheelTotal = 0;
    let cooldown = 0;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }
      event.preventDefault();
      const now = Date.now();
      if (now < cooldown) {
        return;
      }
      wheelTotal += event.deltaY;
      if (Math.abs(wheelTotal) < WHEEL_STEP) {
        return;
      }
      stepGrouping(wheelTotal > 0 ? -1 : 1);
      wheelTotal = 0;
      cooldown = now + 300;
    };
    const touches = new Map<number, { x: number; y: number }>();
    let pinchStart = 0;
    const distance = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') {
        return;
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        pinchStart = distance();
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) {
        return;
      }
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size !== 2 || !pinchStart) {
        return;
      }
      const delta = distance() - pinchStart;
      if (Math.abs(delta) < PINCH_STEP) {
        return;
      }
      stepGrouping(delta > 0 ? 1 : -1);
      pinchStart = distance();
    };
    const onPointerEnd = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) {
        pinchStart = 0;
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', onPointerEnd);
    element.addEventListener('pointercancel', onPointerEnd);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerEnd);
      element.removeEventListener('pointercancel', onPointerEnd);
    };
  });

  /**
   * The earlier months' tiles a month lays out at the start of its rows (FL-143: All, Years when not
   * shown as cards, and the Browse and Work grids), gathered by the day that owns them.
   */
  const carriedDays = (month: TimelineMonth) => {
    const days: { key: string; day: TimelineDay; tiles: ViewerAsset[] }[] = [];
    for (const { viewerAsset, day } of month.flowCarried) {
      const current = days.at(-1);
      if (current?.day === day) {
        current.tiles.push(viewerAsset);
      } else {
        days.push({ key: `${day.timelineMonth.viewId}-${day.day}`, day, tiles: [viewerAsset] });
      }
    }
    return days;
  };

  const monthIds = (month: TimelineMonth) =>
    month.timelineDays.flatMap((day) => day.viewerAssets.map((viewerAsset) => viewerAsset.id));

  /**
   * A month, year or "all" group: the months it covers, in display order. Prototype
   * `explore-timeline.mjs` `timelineGroups` keys a group by the capture month, year or "all"; the
   * manager lays the group out as one flow that runs on across its months (FL-143) and reserves the
   * header's space above the group's first month (`TimelineMonth.startsGroup`).
   */
  type DisplayGroup = { key: string; title: string; months: TimelineMonth[] };

  /** Prototype `monthTitle`: the full month name and the year, e.g. "December 2024". */
  const monthTitle = (month: TimelineMonth) =>
    fromTimelinePlainYearMonth(month.yearMonth).toLocaleString(
      { month: 'long', year: 'numeric' },
      { locale: $locale ?? undefined },
    );

  const displayGroups = $derived.by<DisplayGroup[]>(() => {
    if (effectiveGrouping === 'days') {
      return [];
    }
    const groups: DisplayGroup[] = [];
    for (const month of timelineManager.months) {
      const { year } = month.yearMonth;
      const key =
        effectiveGrouping === 'all'
          ? 'all'
          : effectiveGrouping === 'years'
            ? String(year)
            : `${year}-${month.yearMonth.month}`;
      const current = groups.at(-1);
      if (current?.key === key) {
        current.months.push(month);
        continue;
      }
      groups.push({
        key,
        title:
          effectiveGrouping === 'all'
            ? $t('frameleaf_library_group_all')
            : effectiveGrouping === 'years'
              ? String(year)
              : monthTitle(month),
        months: [month],
      });
    }
    return groups;
  });

  const groupHeadingId = (group: DisplayGroup) => `fl-group-${group.key}`;

  /** Each month's display group, for the months loop. */
  const groupOf = $derived(
    new Map(displayGroups.flatMap((group) => group.months.map((month) => [month.viewId, group] as const))),
  );

  /**
   * The loaded month that carries the group's region: one region per group, named by its heading,
   * so a year does not show up as a dozen regions of the same name.
   */
  const regionHosts = $derived.by(() => {
    const hosts = new Map<string, string>();
    for (const group of displayGroups) {
      const host = group.months.find((month) => month.isLoaded && month.isInOrNearViewport);
      if (host) {
        hosts.set(group.key, host.viewId);
      }
    }
    return hosts;
  });

  /** The month each group's header is drawn before: the group's first month within reach. */
  const bandHosts = $derived.by(() => {
    const hosts = new Map<string, string>();
    for (const group of displayGroups) {
      const host = group.months.find((month) => month.isInOrNearViewport);
      if (host) {
        hosts.set(group.key, host.viewId);
      }
    }
    return hosts;
  });

  const groupIds = (group: DisplayGroup) => group.months.flatMap((month) => monthIds(month));

  /** Months not loaded yet hold ids the timeline has not seen, so such a group is never "all" selected. */
  const displayGroupState = (group: DisplayGroup) => {
    const state = groupSelectionState(groupIds(group), selection);
    return state === 'all' && group.months.some((month) => !month.isLoaded) ? 'some' : state;
  };

  /**
   * The newest pending request of each group whose months are loading. A group has at most one:
   * a newer click on the same group supersedes it, and a click on another group leaves it alone.
   */
  const groupRequests = new SvelteMap<string, number>();
  let nextGroupRequest = 0;
  /** A group checkbox is loading months; drives `aria-busy` and the loading status with ranges. */
  const groupPending = $derived(groupRequests.size > 0);

  /**
   * The prototype's group checkbox selects every item in the group. A year or "all" group can reach
   * months that are not loaded yet: they are loaded one at a time, cancellably, and the result is
   * dropped when the view moved on meanwhile (`selectGroupAfterLoading`). "All" takes the same path
   * rather than select-all-matching: the timeline also serves albums, archive, favorites and the
   * pickers, where no server-side matching selection exists, and the tiles and group checkboxes
   * show a selection only through concrete ids.
   *
   * Resolves `false` when the click did not take effect (a month did not load, or the view changed),
   * so the header puts its checkbox back; a click superseded by a newer one on the same group
   * resolves `true`, since the newer click owns the checkbox now.
   */
  const selectDisplayGroup = async (group: DisplayGroup, checked: boolean): Promise<boolean> => {
    const request = ++nextGroupRequest;
    const loading = checked && group.months.some((month) => !month.isLoaded);
    if (loading) {
      groupRequests.set(group.key, request);
    } else {
      // Unchecking, or checking a fully loaded group, supersedes a load still running for it.
      groupRequests.delete(group.key);
    }
    let outcome: GroupLoadOutcome;
    try {
      outcome = await selectGroupAfterLoading(session, {
        months: group.months,
        checked,
        isLoaded: (month) => month.isLoaded,
        load: (month) => timelineManager.loadTimelineMonth(month.yearMonth),
        idsOf: () => groupIds(group),
        isLatest: () => !loading || groupRequests.get(group.key) === request,
      });
    } catch {
      outcome = 'incomplete';
    }
    const superseded = loading && groupRequests.get(group.key) !== request;
    if (!superseded) {
      groupRequests.delete(group.key);
    }
    if (outcome === 'done' || superseded) {
      return true;
    }
    announcement = $t('frameleaf_library_group_select_failed', { values: { title: group.title } });
    return false;
  };

  /**
   * The header moves to another month as the group scrolls (`bandHosts`), which draws it anew. A
   * group checkbox that had keyboard focus keeps it: the new header's checkbox takes it back.
   */
  let focusedGroupKey = $state<string | null>(null);
  $effect(() => {
    const hosts = bandHosts;
    const key = untrack(() => focusedGroupKey);
    if (!key) {
      return;
    }
    // The group scrolled away entirely: its header is gone, so the claim ends rather than pulling
    // focus back when the group returns much later.
    if (!hosts.has(key)) {
      focusedGroupKey = null;
      return;
    }
    void tick().then(() => {
      // Only focus that was lost with the old header is given back, never focus taken elsewhere.
      const active = document.activeElement;
      if (active && active !== document.body) {
        return;
      }
      root
        ?.querySelector<HTMLInputElement>(`[data-group-key="${CSS.escape(key)}"] input[type="checkbox"]`)
        ?.focus({ preventScroll: true });
    });
  });

  // A press anywhere outside the group headers ends the claim, even on something not focusable.
  $effect(() => {
    const release = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest('.fl-group-band'))) {
        focusedGroupKey = null;
      }
    };
    document.addEventListener('pointerdown', release, { capture: true });
    return () => document.removeEventListener('pointerdown', release, { capture: true });
  });

  /** The group under the pointer shows its checkbox, as the prototype's `.tl-group:hover`. */
  let hoveredMonth = $state<string | null>(null);

  /* ------------------------------------------------------------------ */
  /* Scroll restoration                                                  */
  /* ------------------------------------------------------------------ */

  // Ported from the upstream timeline so the Frameleaf layouts keep the same behaviour: coming
  // back from the viewer, or following a link that names an asset, lands on that asset rather than
  // at the top. The layout sets `display: none` on this subtree while the viewer is open and
  // browsers drop the scroll offset of a hidden element, hence the remembered offset.
  let lastVisibleScrollTop = 0;

  /**
   * The edge the last scroll-to-asset aligned the asset with. While the layout is still settling
   * the asset is kept on that same edge, rather than on whichever edge happens to be nearer after
   * the months around it moved.
   */
  let alignedEdge: 'top' | 'bottom' | null = null;

  /** Height of the sticky toolbar strip LibraryView publishes as `--fl-sticky-offset`, or 0. */
  const stickyOffset = () => {
    if (!scrollable) {
      return 0;
    }
    // Published as whole pixels ("64px"); unset reads as an empty string, which is 0.
    const value = Number(getComputedStyle(scrollable).getPropertyValue('--fl-sticky-offset').trim().replace(/px$/, ''));
    return Number.isFinite(value) ? value : 0;
  };

  const scrollToAssetPosition = (assetId: string, month: TimelineMonth, keepEdge = false) => {
    const position = month.findAssetAbsolutePosition(assetId);
    if (!position) {
      return;
    }
    // <Portal> may have gone from invisible to visible, so the window positions are stale.
    timelineManager.updateSlidingWindow();
    const assetTop = position.top;
    const assetBottom = position.top + position.height;
    // The frosted results toolbar sticks over the top of the scroller (LibraryView publishes its
    // height), so the part it covers is not "on screen" and a top alignment lands just below it.
    const covered = stickyOffset();
    const visibleTop = timelineManager.visibleWindow.top + covered;
    const visibleBottom = timelineManager.visibleWindow.bottom;
    const viewportHeight = visibleBottom - visibleTop;
    const alignTop = assetTop - covered;
    const alignBottom = assetBottom - viewportHeight - covered;
    const scrollTop = visibleTop - covered;
    if (keepEdge && alignedEdge) {
      const target = alignedEdge === 'top' ? alignTop : alignBottom;
      if (Math.abs(target - scrollTop) > 1) {
        timelineManager.scrollTo(target);
      }
      return;
    }
    if (isIntersecting(assetTop, assetBottom, visibleTop, visibleBottom)) {
      alignedEdge = null;
      return;
    }
    const currentTop = scrollable?.scrollTop ?? 0;
    // Whichever alignment moves the least.
    alignedEdge = Math.abs(alignTop - currentTop) < Math.abs(alignBottom - currentTop) ? 'top' : 'bottom';
    timelineManager.scrollTo(alignedEdge === 'top' ? alignTop : alignBottom);
  };

  const scrollToAssetId = async (assetId: string, load = true, keepEdge = false) => {
    const known = timelineManager.getTimelineMonthByAssetId(assetId);
    if (known) {
      scrollToAssetPosition(assetId, known, keepEdge);
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

  /** Put keyboard focus on an asset's tile, so the arrow keys continue from the asset that was linked. */
  const focusTile = (assetId: string) => {
    const tile = scrollable?.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(assetId)}"] button`);
    tile?.focus({ preventScroll: true });
  };

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  const scrollAfterNavigate = async () => {
    // Opening the viewer hides the grid; there is nothing to place until it shows again.
    if (assetViewerManager.isViewing) {
      return;
    }
    if (timelineManager.viewportHeight === 0 || timelineManager.viewportWidth === 0) {
      const rect = scrollable?.getBoundingClientRect();
      if (rect) {
        timelineManager.viewportHeight = rect.height;
        timelineManager.viewportWidth = rect.width;
      }
    }
    // Coming back from the viewer the grid was hidden and lost its offset: put it back first, so the
    // asset below is only scrolled to when it is no longer where the grid was left.
    if (lastVisibleScrollTop > 0 && (scrollable?.scrollTop ?? 0) === 0) {
      timelineManager.scrollTo(lastVisibleScrollTop);
    }
    // The URL's asset wins; otherwise the session's own scroll anchor decides where we land.
    const target = assetViewerManager.gridScrollTarget?.at ?? session.session.scrollAnchor;
    const scrolled = target ? await scrollToAssetId(target) : false;
    if (scrolled && target) {
      // Months measured as the grid shows again can still move the asset for a few frames: keep it
      // in view until the height stops changing. The months around it load in waves, and in a flow
      // that runs on across months (FL-143) each one that loads lays the rows out again, so keep it
      // there until those months have loaded too, not only while the height changes frame to frame.
      const monthsLoading = () => timelineManager.months.some((month) => month.isInOrNearViewport && !month.isLoaded);
      let lastHeight = -1;
      for (
        let attempt = 0;
        attempt < 30 && (timelineManager.totalViewerHeight !== lastHeight || monthsLoading());
        attempt++
      ) {
        lastHeight = timelineManager.totalViewerHeight;
        await nextFrame();
        await nextFrame();
        await scrollToAssetId(target, false, true);
      }
    }
    if (scrolled && assetViewerManager.gridScrollTarget?.at) {
      await tick();
      focusTile(assetViewerManager.gridScrollTarget.at);
    } else if (!scrolled && lastVisibleScrollTop > 0) {
      timelineManager.scrollTo(lastVisibleScrollTop);
    }
  };

  beforeNavigate(({ from, to }) => {
    if (!enableRouting) {
      return;
    }
    timelineManager.suspendTransitions = true;
    if (isAssetViewerRoute(to) && !isAssetViewerRoute(from) && scrollable?.clientHeight) {
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

  // FL-34: the session privacy gate can mount this after the router's first navigation completed;
  // place the grid now rather than waiting for the next navigation
  onMount(() => {
    if (enableRouting && hasRouterStarted()) {
      void scrollAfterNavigate();
    }
  });

  // A layout switch changes the geometry but not the session: come back to the same asset, at the
  // same height on screen (FL-33). The anchor is read before the new layout options are applied —
  // a pre-effect runs ahead of the effect that sets them — so it describes what was on screen.
  let lastLayout = session.layout;
  let layoutAnchor: LibraryAnchor | undefined;
  $effect.pre(() => {
    const layout = session.layout;
    if (layout === lastLayout) {
      return;
    }
    layoutAnchor = untrack(() => captureLibraryAnchor(timelineManager, session.session.scrollAnchor));
  });
  $effect(() => {
    const layout = session.layout;
    if (layout === lastLayout) {
      return;
    }
    lastLayout = layout;
    const anchor = layoutAnchor;
    layoutAnchor = undefined;
    const anchorId = untrack(() => session.session.scrollAnchor);
    if (!anchor && !anchorId) {
      return;
    }
    // Work narrows the timeline for its panel and adds captions: the new width is measured and
    // the months laid out again over the next frames, so the asset is found after that settles.
    void tick()
      .then(nextFrame)
      .then(nextFrame)
      .then(() => {
        if (!restoreLibraryAnchor(timelineManager, anchor) && anchorId) {
          void scrollToAssetId(anchorId, false);
        }
      });
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

  /** The keyboard's month jump: the month's first row at the top of the timeline. */
  const onJump = ({ year, month }: { year: number; month: number }) => {
    const target = timelineManager.months.find(({ yearMonth }) => yearMonth.year === year && yearMonth.month === month);
    if (target) {
      timelineManager.scrollTo(Math.min(target.top, timelineManager.maxScroll));
    }
  };

  // note: don't throttle or debounce - it causes flicker
  const handleScroll = () => {
    // A hidden grid (the viewer is open) reports a scroll to 0. Acting on it would load and lay out
    // the months at the top as if they were on screen and forget where the grid was.
    if (!scrollable || scrollable.clientHeight === 0) {
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
   * manager retrieves it — the component never walks the library itself. As in the prototype
   * (`App.jsx` toggleSelect), the range leaves the anchor where it was, so a chain of shift-clicks
   * all range from the same original anchor.
   */
  const selectRange = async (asset: TimelineAsset) => {
    const start = anchorAsset();
    if (!start) {
      // No anchor: a plain toggle, which sets one. An anchor that is no longer in the timeline adds
      // just the clicked item and stays the anchor (prototype `selectRange` outside visible order).
      session.select(asset.id, { range: true, orderedIds: [asset.id] });
      return;
    }
    rangePending = true;
    // A range retrieved for another scope, query or sort must not land in this view's selection.
    const revision = session.revision;
    try {
      const range = await timelineManager.retrieveRange(start, asset);
      if (session.revision !== revision) {
        return;
      }
      const ids = range.map((item) => item.id);
      session.dispatch({ type: 'selection', ids: [...new Set([...session.selection, ...ids])] });
    } finally {
      rangePending = false;
    }
  };

  /** A pick in single-select mode is the whole selection, so the previous one is replaced. */
  const pick = (asset: TimelineAsset) => {
    if (singleSelect) {
      session.dispatch({ type: 'selection', ids: [asset.id] });
    } else {
      session.select(asset.id);
    }
    session.setScrollAnchor(asset.id);
    onSelect?.(asset);
  };

  const onToggleSelect = (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => {
    if (!singleSelect && 'shiftKey' in event && event.shiftKey) {
      void selectRange(asset);
      return;
    }
    if (singleSelect) {
      pick(asset);
      return;
    }
    session.select(asset.id);
  };

  const handleOpen = (asset: TimelineAsset) => {
    // The page may claim a plain click for itself before anything else happens.
    if (onTileClick?.(asset)) {
      session.setScrollAnchor(asset.id);
      return;
    }
    // While picking, a plain click selects rather than opening the viewer.
    if (selectionMode) {
      pick(asset);
      return;
    }
    // Opening an item is not selecting it; the viewer (FL-35) reads the session's open asset.
    session.open(asset.id);
    session.setScrollAnchor(asset.id);
    onOpen?.(asset);
  };
</script>

{#snippet top()}
  {@render header?.()}
  {#if onGroupingChange && showDayHeaders}
    <div class="fl-grouping">
      <span class="fl-grouping-hint">
        {$t(isMacPlatform() ? 'frameleaf_library_grouping_hint_mac' : 'frameleaf_library_grouping_hint')}
      </span>
      <div class="fl-grouping-modes" role="group" aria-label={$t('frameleaf_library_grouping')}>
        {#each CONTROL_ORDER as value (value)}
          <button type="button" aria-pressed={grouping === value} onclick={() => changeGrouping(value)}>
            {$t(MODE_LABELS[value])}
          </button>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

<div
  class="fl-timeline"
  class:is-groupable={onGroupingChange && showDayHeaders}
  class:is-zoomable={tileLayout !== 'timeline' && tileLayout !== 'list' && !!onThumbnailSizeChange}
  data-testid="frameleaf-timeline"
  bind:this={root}
>
  {#if curated && (grouping === 'years' || grouping === 'months')}
    <div
      class="fl-timeline-cards"
      bind:clientHeight={measuredHeight}
      bind:clientWidth={measuredWidth}
      style:margin-inline-end="{coarsePointer ? 0 : scrubberWidth}px"
    >
      <TimelineCards
        bind:this={cards}
        {timelineManager}
        {grouping}
        {focusYear}
        onOpen={openCard}
        onCurrentPeriod={onCardPeriod}
        header={top}
        {empty}
      />
    </div>
    <!-- Template TimelineLibrary.jsx:460: the scrubber stays beside the cards. -->
    <!-- A flat order (filename, rating) has no dates to scrub through. -->
    {#if timelineManager.months.length > 0 && !timelineManager.ordered}
      <YearScrubber
        {timelineManager}
        height={measuredHeight}
        viewportTopMonth={cardTopMonth}
        onScrub={onCardScrub}
        onJump={onCardJump}
        bind:scrubberWidth
      />
    {/if}
  {:else}
    <section
      class="fl-timeline-scroll"
      tabindex="-1"
      bind:this={scrollable}
      bind:clientHeight={measuredHeight}
      bind:clientWidth={measuredWidth}
      style:margin-inline-end="{coarsePointer ? 0 : scrubberWidth}px"
      onscroll={handleScroll}
      aria-busy={rangePending || groupPending}
    >
      <div class="fl-timeline-body" style:height="{timelineManager.totalViewerHeight}px">
        <!--
          The header block spans the whole scroll height so a host's toolbar inside it can stick for
          the length of the library (apple-style.css "#3 materials"); the rows paint over it. Its
          measured height is where its content ends, marked by the last element.
        -->
        <div class="fl-timeline-top" bind:this={topElement}>
          {@render top()}
          {#if isEmpty}
            {@render empty?.()}
          {/if}
          <div class="fl-timeline-top-end" bind:this={topEnd}></div>
        </div>

        {#each timelineManager.months as month (month.viewId)}
          {@const group = groupOf.get(month.viewId)}
          <!--
          A month, year or "all" group's header comes first in the document, before its tiles, as
          the prototype's header opens its <section>. The band spans every month of the group so the
          header sticks through all of them; only the header takes the pointer.
        -->
          {#if group && bandHosts.get(group.key) === month.viewId}
            {@const first = group.months[0]}
            {@const last = group.months.at(-1)!}
            <div
              class="fl-group-band"
              data-testid="frameleaf-group"
              data-group-key={group.key}
              onfocusin={() => (focusedGroupKey = group.key)}
              onfocusout={(event) => {
                // Focus moving to another element ends the claim; the header being drawn anew does not.
                if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
                  focusedGroupKey = null;
                }
              }}
              style:top="{first.top}px"
              style:height="{last.top + last.height - first.top}px"
            >
              <LibraryGroupHeader
                id={groupHeadingId(group)}
                title={group.title}
                count={group.months.reduce((total, groupMonth) => total + groupMonth.assetsCount, 0)}
                state={displayGroupState(group)}
                {selecting}
                hovered={group.months.some((groupMonth) => groupMonth.viewId === hoveredMonth)}
                width={timelineManager.viewportWidth}
                height={first.groupHeaderHeight}
                onSelect={(checked) => selectDisplayGroup(group, checked)}
              />
            </div>
          {/if}
          {#if !month.isLoaded}
            <div class="fl-month" style:height="{month.height}px" style:transform={`translate3d(0,${month.top}px,0)`}>
              <Skeleton height={month.height} title={month.title} />
            </div>
          {:else if month.isInOrNearViewport}
            <div
              class="fl-month"
              role={group && regionHosts.get(group.key) === month.viewId ? 'region' : undefined}
              aria-labelledby={group && regionHosts.get(group.key) === month.viewId ? groupHeadingId(group) : undefined}
              style:height="{month.height}px"
              style:transform={`translate3d(0,${month.top}px,0)`}
              onpointerenter={() => (hoveredMonth = month.viewId)}
              onpointerleave={() => {
                if (hoveredMonth === month.viewId) {
                  hoveredMonth = null;
                }
              }}
            >
              <!--
                All (and Years when not shown as cards), and the Browse and Work grids (FL-143): a row
                that runs on from the months before this one starts with their tiles; this month lays
                them out and draws them, ahead of its own in reading order.
              -->
              {#each carriedDays(month) as carried (carried.key)}
                <LibraryDayGroup
                  timelineDay={carried.day}
                  hosted={carried.tiles}
                  hostedWidth={month.flowContentWidth}
                  hostedHeight={month.flowContentHeight}
                  {selection}
                  {selecting}
                  {ratingFor}
                  layout={tileLayout}
                  captionHeight={cells ? cells.captionHeight : rowCaptionHeight}
                  captionBelow={!cells}
                  {showFileNames}
                  showHeader={false}
                  grouped
                  headerHeight={month.groupHeaderHeight}
                  onOpen={handleOpen}
                  {onToggleSelect}
                  onFocusAsset={(asset) => session.setScrollAnchor(asset.id)}
                  {tileOverlay}
                  {quickActions}
                  deferImages={scrubbing}
                />
              {/each}
              {#each filterIsInOrNearViewport(month.timelineDays) as timelineDay (timelineDay.day)}
                <LibraryDayGroup
                  {timelineDay}
                  {selection}
                  {selecting}
                  {ratingFor}
                  layout={tileLayout}
                  captionHeight={cells ? cells.captionHeight : rowCaptionHeight}
                  captionBelow={!cells}
                  {showFileNames}
                  showHeader={showDayHeaders}
                  grouped={effectiveGrouping !== 'days' || !!cells}
                  headerHeight={month.groupHeaderHeight}
                  onOpen={handleOpen}
                  {onToggleSelect}
                  onSelectGroup={(ids, checked) => session.selectGroup(ids, checked)}
                  onFocusAsset={(asset) => session.setScrollAnchor(asset.id)}
                  {tileOverlay}
                  {quickActions}
                  deferImages={scrubbing}
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

    <!-- A flat order (filename, rating) has no dates to scrub through. -->
    {#if timelineManager.months.length > 0 && !timelineManager.ordered}
      <YearScrubber
        {timelineManager}
        height={timelineManager.viewportHeight}
        {viewportTopMonth}
        {viewportTopMonthScrollPercent}
        {timelineScrollPercent}
        {onScrub}
        {onJump}
        bind:scrubberWidth
        bind:dragging={scrubbing}
      />
    {/if}
  {/if}
</div>

<span class="fl-sr" role="status" aria-live="polite">
  {#if rangePending || groupPending}{$t('loading')}{/if}
</span>
<!-- Prototype `.tl-live`: the grouping announcement has a live region of its own. -->
<span class="fl-sr" role="status" aria-live="polite" data-testid="frameleaf-grouping-status">{announcement}</span>

<style>
  .fl-timeline {
    container: fl-timeline / inline-size;
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
    /* Keyboard focus and scrollIntoView stop below the sticky results toolbar. */
    scroll-padding-top: var(--fl-sticky-offset, 0px);
  }
  .fl-timeline-body {
    position: relative;
  }
  .fl-timeline-cards {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
  }
  .fl-timeline-top,
  .fl-timeline-bottom {
    position: absolute;
    inset-inline: 0;
  }
  .fl-timeline-top {
    top: 0;
    bottom: 0;
    pointer-events: none;
  }
  .fl-timeline-top > :global(*) {
    pointer-events: auto;
  }
  /* Months and the bottom spacer are placed by their transform alone, from the body's top; the
     full-height header block is absolutely positioned and doesn't push them down. */
  .fl-timeline-bottom {
    top: 0;
  }
  .fl-timeline.is-groupable,
  .fl-timeline.is-zoomable {
    /* Prototype `.timeline-library`: a two-finger pinch reaches the grouping (or the grid zoom), not the page zoom. */
    touch-action: pan-y;
  }
  .fl-group-band {
    position: absolute;
    inset-inline: 0;
    z-index: 3;
    pointer-events: none;
  }
  .fl-month {
    position: absolute;
    top: 0;
    inset-inline: 0;
    contain: layout size paint;
    backface-visibility: hidden;
  }
  /* Prototype `timeline-library.css` .tl-toolbar / .tl-hint / .tl-segmented. */
  .fl-grouping {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 12px;
  }
  .fl-grouping-hint {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro, 11px);
  }
  .fl-grouping-modes {
    display: flex;
    padding: 2px;
    border-radius: var(--fl-radius-control, 6px);
    background: var(--fl-panel);
    box-shadow: inset 0 0 0 1px var(--fl-border);
  }
  .fl-grouping-modes button {
    min-height: 30px;
    padding: 0 12px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small, 12px);
    cursor: pointer;
  }
  .fl-grouping-modes button:hover {
    color: var(--fl-text);
  }
  .fl-grouping-modes button[aria-pressed='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
    box-shadow: 0 0 0 1px var(--fl-border);
  }
  /* Prototype `timeline-library.css` `@container (max-width: 600px)`. */
  @container fl-timeline (max-width: 600px) {
    .fl-grouping {
      justify-content: flex-end;
    }
    .fl-grouping-hint {
      display: none;
    }
    .fl-grouping-modes button {
      min-height: 36px;
    }
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
