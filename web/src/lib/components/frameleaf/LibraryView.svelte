<script lang="ts">
  import { isForwardKey } from '$lib/frameleaf/reading-direction';
  /**
   * The library page: Timeline, Browse and Work bound to one live session (FL-33).
   *
   * The three layouts are presentations of the same state, not three pages. Switching between them
   * writes `layout` and nothing else, so the structured query, the album or Space scope, the
   * selected ids, the open asset, the playhead and the asset-relative scroll anchor all survive the
   * switch. Timeline precedes Browse and Work, and Browse is the default.
   *
   * The surfaces other stories own are extension points, not reimplementations:
   * the rail and top bar (FL-30) render through `shell`, the selection bar and bulk actions
   * (FL-32) through `selectionBar`, the viewer (FL-35) through `viewer`, and the information panel
   * (FL-36) through `infoPanel`. This component owns the session, the layouts and the key map.
   *
   * September 24 chrome (apple-style.css "#3 materials", "#1 one toolbar"): the page header scrolls
   * away with the photos while the frosted results toolbar sticks (its height is published as
   * `--fl-sticky-offset` for the group headers and the scrubber), the header's large title shrinks
   * as you scroll where the browser supports scroll-driven animation, the library status bar
   * floats as a capsule over the photos, and while anything is selected the selection bar takes
   * its place carrying Compare, Quick edit and Open in Studio ahead of the bulk actions. Both bars
   * centre between the rail and the inspector through `--fl-left` / `--fl-right`.
   *
   * The results toolbar carries the prototype's count, Filter, Slideshow, information-panel toggle,
   * Sort and "More library actions" (`App.jsx` `.results-toolbar`). The library key map acts on the
   * selection, or on the focused tile when nothing is selected (`App.jsx` library keydown), on every
   * page that mounts this view; tiles offer their hover quick actions (`AssetTile.jsx`), and an empty
   * view shows the Frameleaf empty state rather than the legacy upload card.
   */
  import { browser } from '$app/env';
  import { afterNavigate, goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import BulkConfirmDialog from '$lib/components/frameleaf/BulkConfirmDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import LibraryLayoutSwitch, { showLibraryLayout } from '$lib/components/frameleaf/LibraryLayoutSwitch.svelte';
  import LibraryCompare from '$lib/components/frameleaf/LibraryCompare.svelte';
  import LibraryFilterPanel from '$lib/components/frameleaf/LibraryFilterPanel.svelte';
  import LibraryStatusBar from '$lib/components/frameleaf/LibraryStatusBar.svelte';
  import ThumbnailSizeControl from '$lib/components/frameleaf/ThumbnailSizeControl.svelte';
  import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
  import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
  import ResultsToolbar from '$lib/components/frameleaf/ResultsToolbar.svelte';
  import MakeMovieSheet from '$lib/components/frameleaf/MakeMovieSheet.svelte';
  import type { MakeMovieSource } from '$lib/frameleaf/studio/make-movie';
  import SelectionBar from '$lib/components/frameleaf/SelectionBar.svelte';
  import ShortcutsHelp from '$lib/components/frameleaf/ShortcutsHelp.svelte';
  import ShowMore from '$lib/components/frameleaf/ShowMore.svelte';
  import WorkFileNamesToggle from '$lib/components/frameleaf/WorkFileNamesToggle.svelte';
  import {
    activeFilterFields,
    withoutDiscoveryFilter,
    withoutDiscoveryFilters,
    type DiscoveryDestination,
    type DiscoveryFilterSection,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import { namedEntitySegments, withArchiveDetail } from '$lib/frameleaf/archive-name';
  import { preparesArchiveOnServer } from '$lib/frameleaf/archive-operations';
  import type { BulkAsset, BulkActionContext, BulkActionId } from '$lib/frameleaf/bulk-actions';
  import { bulkStateById, type BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { type FilterEntityKind, resolveEntityNames } from '$lib/frameleaf/filter-entity-names';
  import {
    albumOrderSort,
    effectiveAlbumSort,
    readAlbumViewSort,
    writeAlbumViewSort,
  } from '$lib/frameleaf/album-view-sort';
  import type { TileLayout } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { searchQueryForTimeline, timelineQueryOptions } from '$lib/frameleaf/library-query-options';
  import { locale } from '$lib/stores/preferences.store';
  import { librarySession, type LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type {
    LibraryGrouping,
    LibraryLayout,
    LibrarySessionAction,
    LibrarySort,
  } from '$lib/frameleaf/library-session';
  import {
    describeFilterFields,
    filterFieldEntityIds,
    type FilterChipDescription,
  } from '$lib/frameleaf/library-filters';
  import {
    barOffers,
    libraryKeysActive,
    MODAL_SELECTOR,
    planKeyAction,
    type KeyItem,
  } from '$lib/frameleaf/library-key-actions';
  import { isTypingTarget, matchLibraryShortcut, type LibraryShortcut } from '$lib/frameleaf/library-shortcuts';
  import { revealsLocks } from '$lib/frameleaf/session-access.svelte';
  import type { SelectionBarLeadingAction } from '$lib/frameleaf/selection-bar';
  import { FILTER_APPLY_EVENT } from '$lib/frameleaf/search-shortcuts';
  import { tileActionAvailability, type TileQuickActions } from '$lib/frameleaf/tile-actions';
  import { captureTimeOf, type CaptureTime } from '$lib/frameleaf/time-zones';
  import { maxStudioHandoffAssets } from '$lib/frameleaf/studio/handoff';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { Route } from '$lib/route';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset, TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { uploadAssetsStore } from '$lib/stores/upload';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetOrder,
    AssetVisibility,
    AssetOrderBy,
    getAssetInfo,
    TimeBucketDateType,
    TimelineOrderedSort,
    updateAsset,
    type ArchiveOperationResponseDto,
  } from '@frameleaf/sdk';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { Theme as AppTheme, themeManager, toastManager } from '@frameleaf/ui';
  import {
    mdiCalendarRange,
    mdiCompare,
    mdiFilterOffOutline,
    mdiFolderOutline,
    mdiImageMultipleOutline,
    mdiMovieOpenPlayOutline,
    mdiOpenInNew,
    mdiPencilOutline,
    mdiTrayArrowUp,
  } from '@mdi/js';
  import { get } from 'svelte/store';
  import { hasRouterStarted } from '$lib/utils/router-started';
  import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
  import type SelectionBarComponent from '$lib/components/frameleaf/SelectionBar.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** Timeline source options (visibility, album, person, partners). */
    options?: TimelineManagerOptions;
    /** The live session. Defaults to the one every view shares. */
    session?: LibrarySessionStore;
    /** Where the results are already shown, so chips never restate it. */
    destination?: DiscoveryDestination;
    timelineManager?: TimelineManager;
    /** Put the portable view state in the URL, so a link reopens what it describes. */
    syncUrl?: boolean;
    /** Rating override; by default each tile shows the asset's own rating. */
    ratingFor?: (asset: TimelineAsset) => number | null;
    /** Open the existing filter panel at a section. */
    onOpenFilterPanel?: (section: DiscoveryFilterSection) => void;
    /** Load the next page of results. */
    onShowMore?: (page: number) => void;
    /**
     * What the bar's "select all" offer means here. `matching` resolves the session's scope and
     * query on the server, which is only meaningful where the session carries the query that
     * produced the results. A destination whose contents come from timeline options instead —
     * Favorites, Archive, a person, a partner — offers `loaded`, which loads the remaining months
     * and selects everything in the view, exactly as the legacy select bar's Select All did.
     */
    selectAll?: 'matching' | 'loaded';
    /** Shortcuts this component does not act on itself (favorite, edit, tag, delete, ...). */
    onShortcut?: (shortcut: LibraryShortcut) => void;
    loading?: boolean;
    /** Restore the scroll position from the URL's asset and from the session's scroll anchor. */
    enableRouting?: boolean;
    /** FL-30: rail and top bar. */
    shell?: Snippet;
    /**
     * The destination's name (Favorites, Archive, Recently added), drawn as the page's large title on
     * the layout switch's row (prototype `.collection-header`). A page with a header of its own, such
     * as an album or a person, passes that as `children` instead.
     */
    title?: string;
    /** Rendered above the results toolbar, inside the scrolling area. */
    children?: Snippet;
    /**
     * A strip under the header row (the title and the layout switch), above the toolbar band: Best
     * Photos' "Best moments in your videos" (LIB-P3).
     */
    subheader?: Snippet;
    /** Extra results-toolbar controls (sort, grouping, view). */
    toolbar?: Snippet;
    /** A page's own choices at the start of the results toolbar, after the count (Locked's reasons). */
    toolbarStart?: Snippet;
    /** Album, shared-link and trash context for the bulk actions (FL-32). */
    bulkContext?: Omit<BulkActionContext, 'assets' | 'count' | 'currentUserId' | 'snapshot'>;
    /**
     * Base name for a selection download's archive, e.g. the album or collection name. Falls back
     * to the generic default in `downloadArchive` when unset, matching the legacy per-route
     * `DownloadAction` filename.
     */
    downloadFileName?: string;
    /**
     * A gate the page puts in front of an action. Returning `false` stops it. The suppressed
     * destination uses it to require an elevated session before items leave it for an album.
     */
    beforeAction?: (id: BulkActionId) => boolean | Promise<boolean>;
    /** Assets a bulk action removed from the page, for a host that keeps counts of its own. */
    onMutated?: (removedIds: string[]) => void;
    tagOptions?: { id: string; name: string }[];
    /** Replaces the Frameleaf selection bar, for a page that needs its own. */
    selectionBar?: Snippet;
    /**
     * Suppress the selection bar entirely. A picking step (album "add photos", the person feature
     * photo, the geolocation utility) confirms in its own chrome, so the bulk bar has no place.
     */
    noSelectionBar?: boolean;
    /**
     * The page header already offers Slideshow (an album's or a shared space's `AlbumHeader`,
     * CollectionHeader.jsx:1430-1436 and its phone "…" menu), so the results toolbar leaves it out
     * and a collection page has exactly one.
     */
    headerHasSlideshow?: boolean;
    /** Picking mode: a plain click selects instead of opening the viewer. */
    selectionMode?: boolean;
    /** With `selectionMode`, a pick replaces the selection instead of adding to it. */
    singleSelect?: boolean;
    /** Called after a pick in `selectionMode`. */
    onSelect?: (asset: TimelineAsset) => void;
    /** Intercept a plain click on a tile; return `true` when the page handled it. */
    onTileClick?: (asset: TimelineAsset) => boolean;
    /** Extra chrome drawn over every tile. */
    tileOverlay?: Snippet<[TimelineAsset]>;
    /** Opened from the timeline instead of the session's asset; the page owns the route. */
    onOpen?: (asset: TimelineAsset) => void;
    /** FL-35: the viewer, opened from the session's open asset. */
    viewer?: Snippet;
    /**
     * FL-36: the information panel. Work opens it above tablet width only. Without one, Work shows
     * the selected item's information (`LibraryWorkInspector`, FL-33).
     */
    infoPanel?: Snippet;
    /**
     * Another side panel (Activity, the filter panel) is open beside the results. Work's information
     * panel steps aside while it is, as the template's inspector does (`App.jsx`).
     */
    sidePanelOpen?: boolean;
    empty?: Snippet;
    /**
     * A public shared-link page (prototype `PublicViewer.jsx`): header, select bar and grid only. The
     * results toolbar (Timeline/Browse/Work, Filter) and the Work information panel are private-library
     * chrome, so neither is drawn, and the grid keeps the plain Browse look whatever layout this device
     * last used in the library.
     */
    publicView?: boolean;
    /** The library status bar (counts, selection, save state). Off for pages that are not a library view. */
    statusBar?: boolean;
    /**
     * Best Photos (LIB-P3): the page's own order is the quality ranking. Browse, Work and the list
     * offer "Best first" and open on it each visit, as the template's Best Photos does; the Timeline
     * keeps its dated groups.
     */
    ranked?: boolean;
  };

  let {
    options,
    session = librarySession,
    destination,
    timelineManager = $bindable(),
    syncUrl = true,
    ratingFor,
    onOpenFilterPanel,
    onShowMore,
    onShortcut,
    selectAll = 'matching',
    loading = false,
    enableRouting = false,
    bulkContext,
    downloadFileName,
    beforeAction,
    onMutated,
    tagOptions = [],
    shell,
    title,
    children,
    subheader,
    toolbar,
    toolbarStart,
    selectionBar,
    noSelectionBar = false,
    headerHasSlideshow = false,
    selectionMode = false,
    singleSelect = false,
    onSelect,
    onTileClick,
    tileOverlay,
    onOpen,
    viewer,
    infoPanel,
    sidePanelOpen = false,
    empty,
    publicView = false,
    statusBar = true,
    ranked = false,
  }: Props = $props();

  timelineManager = new TimelineManager();
  const manager = untrack(() => timelineManager as TimelineManager);
  onDestroy(() => manager.destroy());

  let helpOpen = $state(false);
  let restored = false;
  let restoredFor: string | undefined;
  let restoredContext: string | undefined;
  let restoredView: string | null = null;
  // FL-40 fix: `fl` this page last wrote via a shallow `replaceState`. `replaceState` updates
  // the address bar (and `location.href`) but never updates the reactive `page.url` store
  // (see @sveltejs/kit client.js), so comparing against `page.url` after our own write is wrong.
  // Track what we wrote separately from `restoredView` so the restore effect below recognizes
  // its own write instead of fighting over `restoredView` and looping forever.
  let writtenView: string | null | undefined;
  // FL-34: mounted by the session privacy gate after the first navigation, the router is ready already
  let routerReady = $state(hasRouterStarted());
  afterNavigate(() => {
    routerReady = true;
  });

  /** The layout the grid is drawn in; a public page has no layout switch and stays on Browse. */
  /**
   * T-20 (`App.jsx` `layoutSwitch`): the Locked collection offers the Timeline only, so a Locked view
   * always draws it; the device's own layout choice is left alone for every other page.
   */
  const lockedView = $derived(!!bulkContext?.locked || options?.visibility === AssetVisibility.Locked);
  // FL-34: the Locked view also lists what the owner's Locked rules hide; those carry no lock, and the
  // prototype badges them Sensitive (`AssetTile.jsx`)
  const isLockedRuleMatch = (asset: TimelineAsset) => asset.visibility !== AssetVisibility.Locked;
  const gridLayout = $derived(publicView ? 'browse' : lockedView ? 'timeline' : session.layout);
  /**
   * The information panel (prototype `inspector`): the results toolbar's toggle and I show or hide it
   * in every layout, and a layout switch opens it for Work and closes it for the others, as the
   * template's layout switch does (`setInspector(layout === "work" && innerWidth > 1000)`).
   */
  // FL-31: Work opens the panel by itself only above 1000px, never on phones or tablets, where the
  // toolbar toggle (or I) still shows it on request.
  let inspectorOpen = $state(untrack(() => gridLayout === 'work' && mediaQueryManager.wideInspector));
  let inspectorLayout: string | undefined;
  $effect(() => {
    const layout = gridLayout;
    if (inspectorLayout !== undefined && layout !== inspectorLayout) {
      inspectorOpen = layout === 'work' && untrack(() => mediaQueryManager.wideInspector);
    }
    inspectorLayout = layout;
  });
  // Only above tablet width; a public page and a picking step have no information panel.
  const canShowInfoPanel = $derived(!publicView && !selectionMode && !mediaQueryManager.maxMd);

  /**
   * LIB-P1: the toolbar's Filter (and its "Choose a filter" menu) opens the template's Filters panel
   * docked beside the photos (`App.jsx` `panel === "filters"`), and the grid follows each choice
   * live. A host with a filter panel of its own still gets the request (`onOpenFilterPanel`).
   */
  let filterPanelOpen = $state(false);
  let filterSection = $state<DiscoveryFilterSection>('people');
  const openFilterPanel = (section: DiscoveryFilterSection) => {
    if (onOpenFilterPanel) {
      onOpenFilterPanel(section);
      return;
    }
    filterSection = section;
    filterPanelOpen = true;
  };
  const closeFilterPanel = () => {
    filterPanelOpen = false;
  };

  /**
   * A choice in the panel narrows the page's photos in place, whatever it is (FL-425): the time
   * buckets take the whole filter (a place, a camera, a date range, several people, an enrichment
   * state) beside the page's own scope, as the template's grid follows every choice.
   */
  const applyFilterPanelQuery = (query: DiscoveryQuery) => {
    session.setQuery(query);
  };
  /** The panel's counts are for the search this page stands for. */
  const filterCountQuery = $derived(
    filterPanelOpen ? (searchQueryForTimeline(session.query, options ?? {}) ?? session.query) : session.query,
  );

  const showInfoPanel = $derived(canShowInfoPanel && inspectorOpen && !sidePanelOpen && !filterPanelOpen);
  const selecting = $derived(session.selection.length > 0);
  // The root names its theme itself: the page area has no themed ancestor to inherit one from.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  /** FL-61: the Compare view (culling) is open over the results, which stay where they were. */
  const comparing = $derived(session.state.view === 'compare');

  /**
   * The session's query as the time buckets apply it (review M3, FL-425): the Filters panel, a "View
   * in library" link from Tags or Folders, or a session restored on this device can carry one. Every
   * filter condition narrows the grid itself, so the count, the empty state and Slideshow describe
   * what is shown; only search text (`unapplied`) stays for the search results page.
   */
  const queryApplied = $derived.by(() =>
    options && !publicView && !selectionMode
      ? timelineQueryOptions(session.query, options)
      : { options, unapplied: [] as string[] },
  );

  // FL-40: applying the album's Filter keeps its sort, layouts and viewer in the same session.
  // Queries beyond the timeline contract continue through the palette's search route.
  $effect(() => {
    const apply = (event: Event) => {
      const query = (event as CustomEvent<DiscoveryQuery>).detail;
      if (
        event.defaultPrevented ||
        publicView ||
        selectionMode ||
        !options?.albumId ||
        query.spaceId ||
        query.queryAssetId ||
        query.view !== 'photos' ||
        timelineQueryOptions(query, {}).options.albumId !== options.albumId ||
        timelineQueryOptions(query, options).unapplied.length > 0
      ) {
        return;
      }
      session.setQuery(query);
      event.preventDefault();
    };
    addEventListener(FILTER_APPLY_EVENT, apply);
    return () => removeEventListener(FILTER_APPLY_EVENT, apply);
  });
  /**
   * Search text, which the buckets cannot run, never stays on a library page (review M3): "View in
   * library" sends such queries to the search results instead, and text restored with the session is
   * dropped here, so every chip, the count and "select all matching" describe exactly what the grid shows.
   */
  $effect(() => {
    const { unapplied } = queryApplied;
    if (unapplied.length === 0) {
      return;
    }
    untrack(() => {
      let query = session.query;
      for (const field of unapplied) {
        query = field === 'text' ? { ...query, text: '' } : withoutDiscoveryFilter(query, field);
      }
      session.setQuery(query);
    });
  });

  /** Filters the grid itself applies. */
  const appliedFilterCount = $derived(
    activeFilterFields(session.query).filter((field) => !queryApplied.unapplied.includes(field)).length,
  );

  /** The List view (S-15): Browse's and Work's rows; the Timeline always keeps its dated rows. */
  const listView = $derived(!publicView && gridLayout !== 'timeline' && session.state.view === 'list');
  const tileLayout = $derived<TileLayout>(listView ? 'list' : gridLayout);

  /**
   * Sort, as the prototype applies it (`App.jsx` `visible.sort(...)`, `TimelineLibrary order`): the
   * Timeline keeps its date groups and only turns newest-first or oldest-first; Browse, Work and the
   * list re-sort the flat results — by upload date through the buckets, and by file name or rating
   * through the flat ordered source (`GET /timeline/ordered`). A page that fixes its own order
   * (Recently added, an album) keeps it and draws no Sort control.
   */
  /**
   * FL-31: an album's display order is shared; the viewer's own sort for it starts from that order
   * and is kept per album on this device (`album-view-sort.ts`), never written back to the album.
   */
  const albumSortId = $derived(options?.albumId && !options.dateType && !publicView ? options.albumId : undefined);
  const albumSortUserId = $derived(
    authManager.authenticated && !authManager.isSharedLink ? authManager.user.id : undefined,
  );
  let albumPersonalSort = $state<LibrarySort | null>(null);
  $effect(() => {
    const id = albumSortId;
    const userId = albumSortUserId;
    albumPersonalSort = id && userId && browser ? untrack(() => readAlbumViewSort(localStorage, userId, id)) : null;
  });
  /** LIB-P3: Best Photos keeps its own sort for the visit, opening on the ranking. */
  let rankedSort = $state<LibrarySort>('quality');
  const activeSort = $derived<LibrarySort>(
    ranked ? rankedSort : albumSortId ? effectiveAlbumSort(albumPersonalSort, options?.order) : session.state.sort,
  );
  const changeAlbumSort = (sort: LibrarySort) => {
    if (ranked) {
      rankedSort = sort;
      return;
    }
    if (albumSortId && albumSortUserId) {
      albumPersonalSort = writeAlbumViewSort(
        browser ? localStorage : undefined,
        albumSortUserId,
        albumSortId,
        sort,
        options?.order,
      );
    }
  };
  const sortable = $derived(
    !!options && !publicView && !selectionMode && (!options.order || !!albumSortId) && !options.dateType,
  );
  const TIMELINE_SORTS: readonly LibrarySort[] = ['captured-desc', 'captured-asc'];
  const FLAT_SORTS: readonly LibrarySort[] = ['captured-desc', 'captured-asc', 'imported-desc', 'filename', 'rating'];
  const RANKED_SORTS: readonly LibrarySort[] = ['quality', ...FLAT_SORTS];
  const sorts = $derived(
    sortable ? (gridLayout === 'timeline' ? TIMELINE_SORTS : ranked ? RANKED_SORTS : FLAT_SORTS) : undefined,
  );
  const shownSort = $derived(
    gridLayout === 'timeline' && !TIMELINE_SORTS.includes(activeSort) ? albumOrderSort(options?.order) : activeSort,
  );
  const sortedOptions = $derived.by(() => {
    const base = queryApplied.options;
    if (!base || !sortable) {
      return base;
    }
    const flat = gridLayout !== 'timeline';
    switch (activeSort) {
      case 'captured-asc': {
        return { ...base, order: AssetOrder.Asc };
      }
      case 'imported-desc': {
        return flat ? { ...base, dateType: TimeBucketDateType.Added, order: AssetOrder.Desc } : base;
      }
      case 'filename': {
        return flat ? { ...base, orderedBy: TimelineOrderedSort.Filename } : base;
      }
      case 'rating': {
        return flat ? { ...base, orderedBy: TimelineOrderedSort.Rating } : base;
      }
      case 'quality': {
        // Best Photos' ranking (`GET /timeline/ordered?sort=quality`); the Timeline stays dated.
        return flat ? { ...base, orderedBy: TimelineOrderedSort.Quality } : base;
      }
      default: {
        // Newest first; on an album that overrides a shared oldest-first order for this viewer only.
        return albumSortId ? { ...base, order: AssetOrder.Desc } : base;
      }
    }
  });

  $effect(() => {
    if (sortedOptions) {
      void manager.updateOptions(sortedOptions);
    }
  });

  $effect(() => {
    session.destination = destination;
  });

  /**
   * Whose stored library view this page reads and writes. A public share (FL-56) is nobody's library:
   * a signed-in visitor's own view never shapes it, and nothing from the share is kept in theirs.
   */
  const storageUserId = $derived(
    publicView || authManager.isSharedLink || !authManager.authenticated ? undefined : authManager.user.id,
  );
  // The same portable view can be shown through different routes or timeline options (including
  // Locked). Sort direction changes presentation, not the resource context of selection and drafts.
  const storageContext = $derived(
    JSON.stringify({ route: page.route?.id, options: options && { ...options, order: undefined } }),
  );

  // Restore for each account, context or explicit URL view, including Back within a mounted page.
  $effect(() => {
    const urlView = page.url.searchParams.get('fl');
    if (!browser) {
      return;
    }
    if (
      restored &&
      restoredFor === storageUserId &&
      restoredContext === storageContext &&
      (restoredView === urlView || writtenView === urlView)
    ) {
      if (writtenView === urlView) {
        // `page.url` has caught up with a write we made via replaceState; adopt it as restored so a
        // later link to a different view (e.g. Back to an older history entry) is recognized as new.
        restoredView = urlView;
        writtenView = undefined;
      }
      return;
    }
    restored = true;
    restoredFor = storageUserId;
    restoredContext = storageContext;
    restoredView = urlView;
    writtenView = undefined;
    session.restore(new URL(page.url.href), storageUserId, storageContext);
    // FL-48: a link this version cannot read is refused out loud and left in the address bar, rather
    // than being quietly replaced by the stored view.
    if (session.refusedView) {
      toastManager.warning(
        $t(
          session.refusedView === 'unsupported-version'
            ? 'frameleaf_library_bridge_link_newer'
            : 'frameleaf_library_bridge_link_damaged',
        ),
      );
    }
  });

  /** Whether this device kept the view (the status bar's "Saved on this device"). */
  let savedOnDevice = $state(true);

  // Persist the device-local part of the session, and keep the link in step with the view state.
  $effect(() => {
    // Read both so the effect re-runs when either changes.
    const state = JSON.stringify(session.state);
    const layout = session.layout;
    const context = storageContext;
    if (!browser || !restored || !state || !layout || !context) {
      return;
    }
    savedOnDevice = session.persist(storageUserId);
    if (syncUrl && routerReady) {
      // Compare against the actual address bar, not `page.url`: a shallow `replaceState` never
      // updates `page.url` synchronously, so comparing `next` to `page.url` here looped forever.
      const current = new URL(location.href);
      const next = session.viewUrl(current);
      if (next.href !== current.href) {
        // A URL we just wrote is the current session, not a new link to restore from.
        writtenView = next.searchParams.get('fl');
        replaceState(next, page.state).catch((error) => handleError(error, $t('error')));
      }
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Bulk actions (FL-32), bound to this session                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Everything the selection bar runs goes through one controller, and every session change it
   * makes comes back through here — including `mutated`, which is also what tells the timeline to
   * drop the assets that just left the page.
   */
  const dispatch = (action: LibrarySessionAction) => {
    if (action.type === 'mutated' && action.removedIds.length > 0) {
      manager.removeAssets(action.removedIds);
      onMutated?.(action.removedIds);
    }
    session.dispatch(action);
  };

  /**
   * Whatever takes an item out of the timeline — a trash or delete on another device, a lock, a
   * bulk action — takes it out of the selection and the open item too (FL-33), so the bar never
   * counts or acts on something that is no longer here. `mutated` is idempotent, so the bulk path
   * reaching this again is harmless.
   */
  $effect(() => manager.onRemoved((removedIds) => session.mutated(removedIds)));

  /**
   * A durable job's finished items leave the timeline as the job finishes them — through the same
   * `mutated` path as a small delete, so the session and the timeline drop them together, without
   * a reload (owner decision, September 22, 2026). Until then each tile shows its own loader.
   */
  $effect(() =>
    durableBulkTracker.onRemoved((removedIds) => {
      const shown = removedIds.filter((id) => !!findAsset(id));
      if (shown.length > 0) {
        dispatch({ type: 'mutated', removedIds: shown });
      }
    }),
  );

  const currentUserId = $derived(authManager.authenticated ? authManager.user.id : undefined);

  /**
   * An immediate action shows on the page at once, as the prototype's `bulkChange` does: a favorite
   * gains its badge, and an item the change takes out of this view (archived from the library,
   * unarchived from Archive, unfavorited from Favorites) leaves it. The server sends no live event
   * for these edits, so without this the page would only catch up on a reload.
   */
  const ASSET_PATCHES: Partial<Record<BulkActionId, (asset: TimelineAsset) => void>> = {
    favorite: (asset) => void (asset.isFavorite = true),
    unfavorite: (asset) => void (asset.isFavorite = false),
    archive: (asset) => void (asset.visibility = AssetVisibility.Archive),
    unarchive: (asset) => void (asset.visibility = AssetVisibility.Timeline),
  };

  const applyBulk = (action: BulkActionId, ids: string[]) => {
    const patch = ASSET_PATCHES[action];
    if (!patch) {
      return;
    }
    // Decide what leaves before updating: update() already splices excluded items out of the page,
    // so they could not be found afterwards (FL-529).
    const left = ids.filter((id) => {
      const asset = findAsset(id);
      if (!asset) {
        return false;
      }
      const changed = { ...asset };
      patch(changed);
      return manager.isExcluded(changed);
    });
    manager.update(ids, patch);
    if (left.length > 0) {
      dispatch({ type: 'mutated', removedIds: left });
    }
  };

  const bulk = new BulkController({
    dispatch,
    applied: applyBulk,
    context: () => ({
      view: {
        isLocked: options?.visibility === AssetVisibility.Locked,
        revealsLocks: !!options && revealsLocks(options),
        visibility: options?.visibility,
      },
      currentUserId: authManager.authenticated ? authManager.user.id : undefined,
      ownerById: Object.fromEntries(
        [...session.selection, ...actionTargets]
          .map((id) => [id, findAsset(id)?.ownerId])
          .filter(([, owner]) => !!owner) as [string, string][],
      ),
      stateById: bulkStateById([...session.selection, ...actionTargets], findAsset),
    }),
  });

  /** Items a shortcut or tile action runs on without selecting them, so the owner guard knows them. */
  let actionTargets: string[] = [];

  const toBulk = (asset: TimelineAsset): BulkAsset => ({
    id: asset.id,
    ownerId: asset.ownerId,
    isVideo: asset.isVideo,
    isFavorite: asset.isFavorite,
    isArchived: asset.visibility === AssetVisibility.Archive,
    isTrashed: asset.isTrashed,
    isLivePhoto: !!asset.livePhotoVideoId,
    isLocked: asset.visibility === AssetVisibility.Locked,
    stackId: asset.stack?.id ?? null,
    // In an Added-date view the bucket's dates are upload times, never offered as capture times.
    ...(!addedDateSource && { localDateTime: plainDateTime(asset), utcOffsetMinutes: utcOffsetMinutes(asset) }),
  });

  /** The time buckets date this view by upload (Recently added, "Added — newest"), not by capture. */
  const addedDateSource = $derived(
    sortedOptions?.dateType === TimeBucketDateType.Added || sortedOptions?.orderBy === AssetOrderBy.CreatedAt,
  );

  /** At most this many items have their capture times read one by one for Change date. */
  const CAPTURE_TIME_LIMIT = 200;

  /**
   * The selection's real capture times and zones, read from each item's details (FL-32 review
   * N1/N3). Null when there are too many to read or a read fails; the dialog then falls back.
   */
  const resolveCaptureTimes = async (ids: string[]): Promise<Record<string, CaptureTime> | null> => {
    if (ids.length === 0 || ids.length > CAPTURE_TIME_LIMIT) {
      return null;
    }
    try {
      const result: Record<string, CaptureTime> = {};
      for (let index = 0; index < ids.length; index += 10) {
        const infos = await Promise.all(
          ids.slice(index, index + 10).map((id) => getAssetInfo({ ...authManager.params, id })),
        );
        for (const info of infos) {
          const capture = captureTimeOf(info);
          if (!capture) {
            return null;
          }
          result[info.id] = capture;
        }
      }
      return result;
    } catch {
      return null;
    }
  };

  /** Minutes east of UTC: the bucket's local wall time less its UTC instant. */
  const utcOffsetMinutes = ({ localDateTime: local, fileCreatedAt: utc }: TimelineAsset) =>
    Math.round(
      (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
        Date.UTC(utc.year, utc.month - 1, utc.day, utc.hour, utc.minute, utc.second)) /
        60_000,
    );

  /** `yyyy-MM-ddTHH:mm` on the item's own clock, read straight from the bucket's fields. */
  const plainDateTime = ({ localDateTime: at }: TimelineAsset) => {
    const pad = (value: number, length = 2) => String(value).padStart(length, '0');
    return `${pad(at.year, 4)}-${pad(at.month)}-${pad(at.day)}T${pad(at.hour)}:${pad(at.minute)}`;
  };

  // A snapshot selection covers items that are not loaded, so the bar is told what it may offer.
  const snapshot = $derived(session.session.selectionSnapshot);
  const selectedAssets = $derived(
    snapshot
      ? []
      : session.selection
          .map((id) => findAsset(id))
          .filter((asset): asset is TimelineAsset => !!asset)
          .map((asset) => toBulk(asset)),
  );

  const runBulk = (id: BulkActionId, payload?: BulkPayload) => {
    if (!beforeAction) {
      dispatchBulk(id, payload);
      return;
    }
    // The page's gate decides one microtask after the event that asked, never inside it, and a gate
    // that throws is reported like one that rejects.
    const gated = async () => {
      await Promise.resolve();
      if (await beforeAction(id)) {
        dispatchBulk(id, payload);
      }
    };
    gated().catch((error) => handleError(error, $t('error')));
  };

  /** The id-list filter fields a person/pet/tag's real name can be resolved for (FL-45 owner decision). */
  const ENTITY_FILTER_FIELDS: Partial<Record<string, FilterEntityKind>> = {
    personIds: 'person',
    // FL-58: a pet-filtered download is named after the pet(s), never a hidden or unnamed one
    petIds: 'pet',
    tagIds: 'tag',
  };

  /**
   * One filter chip's contribution to the download name: a person/pet/tag chip resolves to the actual
   * name(s) behind it wherever it can (owner decision, September 22, 2026), falling back to the
   * chip's translated field label ("People"/"Tags") exactly as before when nothing can be named —
   * every id unresolvable, hidden, unnamed, or the lookup itself failed. A negated condition
   * ("not these people") is left on the generic label on purpose: the download is everything
   * *except* those people, so naming it after them would say the opposite.
   */
  const filterChipDetail = async (chip: FilterChipDescription): Promise<string[]> => {
    const kind = ENTITY_FILTER_FIELDS[chip.field];
    if (kind && !chip.negated) {
      const ids = filterFieldEntityIds(session.query, chip.field);
      if (ids && ids.length > 0) {
        const names = await resolveEntityNames(kind, ids);
        const segments = namedEntitySegments(names, ids.length, (remaining) =>
          $t('frameleaf_archive_name_and_n_more', { values: { count: remaining } }),
        );
        if (segments.length > 0) {
          return segments;
        }
      }
    }
    return [
      chip.detailText
        ? $t(chip.detailText.key, { values: chip.detailText.values })
        : (chip.detail ?? $t(chip.labelKey)),
    ];
  };

  /**
   * FL-45: an active structured filter (a folder path, a city, a date range, a person or tag, ...)
   * makes a download more specific than the destination's own name alone — most usefully for
   * Photos, which a person/tag/folder "view in library" link narrows without a route of its own to
   * name the download after. Reuses the same `describeFilterFields`/`chipFields` the results
   * toolbar draws its chips from, so a download is distinguished by exactly the filters the user
   * can see are active. Async only because a person/tag chip may need a name lookup
   * (`filterChipDetail`); every other chip resolves synchronously and this still awaits nothing
   * over the network for it.
   */
  const effectiveDownloadName = async (): Promise<string | undefined> => {
    if (!downloadFileName) {
      return undefined;
    }
    const chips = describeFilterFields(session.query, session.chipFields);
    const detailSegments = (await Promise.all(chips.map((chip) => filterChipDetail(chip)))).flat();
    return withArchiveDetail(downloadFileName, ...detailSegments);
  };

  const dispatchBulk = (id: BulkActionId, payload?: BulkPayload) => {
    if (id === 'download' && !payload?.fileName) {
      // The only action whose payload needs an async name lookup; every other action stays
      // synchronous below exactly as before.
      void effectiveDownloadName().then((fileName) => runDispatch(id, { ...payload, fileName }));
      return;
    }
    runDispatch(id, payload);
  };

  /**
   * FL-32: the view is the owner's own normal Timeline (the Photos page), the one scope whose
   * "select everything matching" the server can count and freeze for an archive by itself.
   */
  const ownTimeline = $derived(
    destination?.kind === 'library' &&
      options?.visibility === AssetVisibility.Timeline &&
      Object.keys(options).every((key) => ['visibility', 'withStacked'].includes(key)),
  );

  /** A matching archive the server has counted and frozen, waiting for the person to confirm it. */
  let archiveConfirm = $state<ArchiveOperationResponseDto | null>(null);
  let archiveConfirmOpen = $state(false);

  const prepareMatchingArchive = async () => {
    const prepared = await bulk.prepareArchive();
    if (!prepared) {
      return;
    }
    if (prepared.count === 0) {
      toastManager.primary($t('frameleaf_bulk_archive_nothing'));
      return;
    }
    archiveConfirm = prepared;
    archiveConfirmOpen = true;
  };

  const confirmMatchingArchive = async () => {
    const prepared = archiveConfirm;
    archiveConfirm = null;
    archiveConfirmOpen = false;
    if (prepared && (await bulk.confirmArchive(prepared))) {
      session.clearSelection();
    }
  };

  $effect(() => {
    if (!archiveConfirmOpen && archiveConfirm) {
      archiveConfirm = null;
    }
  });

  // The server keeps the latest archive's Undo; a reload offers it again (FL-32).
  onMount(() => {
    if (!publicView && !noSelectionBar && authManager.authenticated && !authManager.isSharedLink) {
      void bulk.restoreArchiveUndo();
    }
  });

  const runDispatch = (id: BulkActionId, payload?: BulkPayload) => {
    if (snapshot && id === 'archive' && ownTimeline && preparesArchiveOnServer(snapshot)) {
      // Counted and frozen by the server first; nothing changes until that exact count is confirmed.
      void prepareMatchingArchive();
      return;
    }
    if (snapshot) {
      // Frozen at submit: editing the filter afterwards cannot change what the operation touches.
      void bulk.runMatching(id, snapshot, { payload, submittedTotal: session.total });
      session.clearSelection();
      return;
    }
    void bulk.run(id, [...session.selection], payload);
  };

  /**
   * Select everything in the view, loading the months that have not been loaded yet. The legacy
   * Select All worked this way, and it is the honest offer where the session holds no query that
   * the server could resolve.
   */
  const selectAllLoaded = async () => {
    for (const month of manager.months) {
      if (!month.isLoaded) {
        await manager.loadTimelineMonth(month.yearMonth);
      }
    }
    session.dispatch({ type: 'selection', ids: loadedIds() });
  };

  const selectAllMatching = async () => {
    const revision = session.revision;
    const total = await bulk.count(session.state);
    if (revision !== session.revision) {
      return;
    }
    session.dispatch({ type: 'selection', ids: loadedIds(), allMatching: true });
    if (total !== null) {
      session.applyTotal(total, session.revision);
    }
  };

  const focusedId = () => session.session.scrollAnchor ?? session.selection.at(-1) ?? null;

  /** The item Work's panel describes: the last one selected, or the one in focus. */
  const inspectedAsset = $derived.by(() => {
    const id = session.selection.at(-1) ?? session.session.scrollAnchor;
    return id ? findAsset(id) : null;
  });

  const loadedIds = () =>
    manager.months.flatMap((month) =>
      month.timelineDays.flatMap((day) => day.viewerAssets.map((viewerAsset) => viewerAsset.id)),
    );

  /**
   * Every loaded asset by id, rebuilt when a month loads or changes. The selection is resolved
   * through it id by id (the multi-select mirror, the selection bar's assets, Studio and Locked
   * filters), so a whole-library selection costs one pass over the library instead of one pass
   * per selected id, which kept the "All" checkbox busy for tens of seconds on a large library.
   */
  const loadedAssets = $derived.by(() => {
    const index = new Map<string, TimelineAsset>();
    for (const month of manager.months) {
      for (const day of month.timelineDays) {
        for (const viewerAsset of day.viewerAssets) {
          if (viewerAsset.asset && !index.has(viewerAsset.id)) {
            index.set(viewerAsset.id, viewerAsset.asset);
          }
        }
      }
    }
    return index;
  });

  const findAsset = (id: string): TimelineAsset | null => loadedAssets.get(id) ?? null;

  /**
   * The session owns the selection; the multi-select manager is kept in step with it so the
   * existing bulk actions (FL-32, FL-36) keep acting on the same items. Assets that are not loaded cannot be
   * mirrored, so a "select everything matching" selection still has to be resolved by its owner.
   */
  $effect(() => {
    const multiSelect = assetMultiSelectManager;
    const ids = new Set(session.selection);
    for (const asset of multiSelect.assets) {
      if (!ids.has(asset.id)) {
        multiSelect.removeAssetFromMultiselectGroup(asset.id);
      }
    }
    for (const id of ids) {
      if (multiSelect.hasSelectedAsset(id)) {
        continue;
      }
      const asset = findAsset(id);
      if (asset) {
        multiSelect.selectAsset(asset);
      }
    }
  });

  let root = $state<HTMLElement>();
  let main = $state<HTMLElement>();
  let toolbarStrip = $state<HTMLElement>();

  /**
   * LIB-P4: the library is the page itself (Photos, Favorites, Archive ...), not a column inside a
   * page that pads its own. It then gives back the page area's inset (see `.fl-library` below) and
   * keeps the page gutter inside the timeline's scroll area instead, so the frosted toolbar band
   * runs from the rail to the window edge as in the template, and the header, the photos and the
   * scrubber keep 24px (8px on phones) from them.
   */
  const pageLevel = $derived(!!root?.parentElement?.classList.contains('fl-scope'));
  const gutter = $derived(pageLevel ? (mediaQueryManager.maxMd ? 8 : 24) : 0);

  /**
   * The capsules centre over the photos, between the rail and the inspector (apple-style.css
   * `--fl-left` / `--fl-right`), and the group headers and scrubber stick below the frosted
   * toolbar whatever its height (App.jsx publishes `--fl-sticky-offset` the same way).
   */
  $effect(() => {
    const host = root;
    const area = main;
    if (!host || !area || typeof ResizeObserver !== 'function') {
      return;
    }
    const measure = () => {
      const box = area.getBoundingClientRect();
      host.style.setProperty('--fl-left', `${Math.max(0, Math.round(box.left))}px`);
      host.style.setProperty('--fl-right', `${Math.max(0, Math.round(innerWidth - box.right))}px`);
      // The transfer dock (root layout) keeps clear of the information panel through this.
      document.documentElement.style.setProperty(
        '--fl-dock-right',
        `${showInfoPanel ? Math.max(0, Math.round(innerWidth - box.right)) : 0}px`,
      );
      const strip = toolbarStrip;
      if (!strip) {
        return;
      }
      // As in the template only the results toolbar stays (`.media-scroll > .results-toolbar`); the
      // header above it and the Timeline grouping row below it scroll away.
      host.style.setProperty('--fl-sticky-offset', `${Math.round(strip.offsetHeight)}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    if (toolbarStrip) {
      observer.observe(toolbarStrip);
    }
    // The window and the rail change the photo area's own size, so observing it covers both.
    observer.observe(document.documentElement);
    measure();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--fl-dock-right');
    };
  });

  /* ---------------------------------------------------------------------- */
  /* One toolbar while selecting (FL-32, September 24 second pass #1)         */
  /* ---------------------------------------------------------------------- */

  /** Quick edit works on the item the selection ends with, as the prototype's `selected` does. */
  const quickEditTarget = $derived.by(() => {
    const id = session.selection.at(-1);
    return id ? findAsset(id) : null;
  });
  const canQuickEdit = $derived(
    !!viewer &&
      !snapshot &&
      !!quickEditTarget &&
      quickEditTarget.ownerId === currentUserId &&
      !quickEditTarget.isTrashed,
  );

  const openQuickEdit = () => {
    const asset = quickEditTarget;
    if (!asset || !canQuickEdit) {
      return;
    }
    editAsset(asset);
  };

  /** Open an item in the viewer, as a tile click does. */
  const openAsset = (asset: TimelineAsset) => {
    session.open(asset.id);
    session.setScrollAnchor(asset.id);
    onOpen?.(asset);
  };

  /**
   * The session's open item follows the page's viewer, including its own previous/next, so Work's
   * panel, the scroll anchor and the playhead describe what is actually shown (prototype
   * `onNavigateAsset` → `open`). Closing the viewer leaves the item open: reopening it resumes it.
   */
  $effect(() => {
    const id = assetViewerManager.isViewing ? assetViewerManager.asset?.id : undefined;
    if (!id) {
      return;
    }
    untrack(() => {
      if (id !== session.openAssetId) {
        session.open(id);
      }
      session.setScrollAnchor(id);
    });
  });

  /** The viewer opens straight into the quick editor, which edits this one item. */
  const editAsset = (asset: TimelineAsset) => {
    if (!viewer || asset.ownerId !== currentUserId || asset.isTrashed) {
      return;
    }
    assetViewerManager.openEditor();
    openAsset(asset);
  };

  /**
   * What Studio may receive: the selection in order through its handoff link (FL-88), capped as
   * Studio caps it. Locked items never cross into Studio (`studio/assets.ts`), so from the Locked
   * view — or a view revealing locked items — nothing is offered, and a locked item selected
   * elsewhere is left out rather than written into the address.
   */
  const studioIds = $derived.by(() => {
    if (snapshot || !options || options.visibility === AssetVisibility.Locked || revealsLocks(options)) {
      return [];
    }
    return session.selection.filter((id) => findAsset(id)?.visibility !== AssetVisibility.Locked);
  });

  const openInStudio = () => {
    if (studioIds.length === 0) {
      return;
    }
    void goto(Route.studio({ assetIds: studioIds.slice(0, maxStudioHandoffAssets) }));
  };

  /** Make a movie (FL-561) from the selection: what Studio may receive, as many as a movie takes. */
  let movieOpen = $state(false);
  const movieIds = $derived(studioIds.slice(0, 2000));
  /** The selection as it was when the sheet opened, so another version uses the same items. */
  let movieSource = $state<MakeMovieSource>({
    kind: 'selection',
    assetIds: [],
    name: '',
    photoCount: 0,
    videoCount: 0,
  });
  const makeMovie = () => {
    const ids = [...movieIds];
    movieSource = {
      kind: 'selection',
      assetIds: ids,
      name: $t('frameleaf_movie_source_items', { values: { count: ids.length } }),
      photoCount: ids.filter((id) => !findAsset(id)?.isVideo).length,
      videoCount: ids.filter((id) => findAsset(id)?.isVideo).length,
      previewIds: ids.slice(0, 3),
    };
    movieOpen = true;
  };

  const leadingActions = $derived<SelectionBarLeadingAction[]>([
    {
      id: 'compare',
      label: $t('frameleaf_compare_title'),
      icon: mdiCompare,
      disabled: session.selection.length < 2 || !!snapshot,
      disabledReason: snapshot
        ? $t('frameleaf_selection_needs_picked_items')
        : session.selection.length < 2
          ? $t('frameleaf_selection_compare_needs_two')
          : undefined,
      onClick: () => session.patchView({ view: 'compare' }),
    },
    ...(viewer
      ? [
          {
            id: 'quick-edit',
            label: $t('frameleaf_selection_quick_edit'),
            icon: mdiPencilOutline,
            disabled: !canQuickEdit,
            disabledReason: snapshot ? $t('frameleaf_selection_needs_picked_items') : undefined,
            onClick: openQuickEdit,
          },
        ]
      : []),
    {
      id: 'movie',
      label: $t('frameleaf_movie_make'),
      icon: mdiMovieOpenPlayOutline,
      disabled: movieIds.length === 0,
      onClick: makeMovie,
    },
    {
      id: 'studio',
      label: $t('frameleaf_selection_open_in_studio'),
      icon: mdiOpenInNew,
      // The capsule's one accent button, as in the prototype (App.jsx `primary: true`).
      primary: true,
      disabled: studioIds.length === 0,
      onClick: openInStudio,
    },
  ]);

  const showStatusBar = $derived(statusBar && !publicView && !selectionMode && !noSelectionBar);
  const thumbnailControl = $derived(!!destination && !['person', 'pet'].includes(destination.kind) && !options?.userId);

  /*
   * The status bar's "X of Y items" (App.jsx footer: `visible.length of collectionAssets.length`).
   * Y is the whole scope, which the timeline's buckets count up front. X is what the active filter
   * leaves, counted by the server for the session's scope and query (`POST /search/statistics`);
   * with no filter the two are the same.
   */
  const scopeTotal = $derived(manager.isInitialized ? manager.assetCount : null);
  /** One count per result set, even when the server cannot count it (a smart search). */
  let countedRevision = -1;
  $effect(() => {
    const revision = session.revision;
    if (!showStatusBar || !session.filterActive || session.total !== null || countedRevision === revision) {
      return;
    }
    countedRevision = revision;
    const state = session.state;
    void untrack(() => bulk.count(state)).then((total) => session.applyTotal(total, revision));
  });
  /**
   * What the grid shows: the toolbar's count, the empty state and Slideshow all read it. It is also
   * the selection bar's "Select all N" before the server has counted the matches (T-14): a library
   * page applies every condition it keeps to its buckets, so the grid's count is the matching count.
   */
  const resultCount = $derived(scopeTotal);
  /**
   * The status bar's Y while the grid applies a filter: the scope without it, counted by the server
   * once per result set. Without an applied filter the grid's own count is the scope.
   */
  let unfilteredTotal = $state<number | null>(null);
  let unfilteredRevision = -1;
  $effect(() => {
    const revision = session.revision;
    if (!showStatusBar || appliedFilterCount === 0 || unfilteredRevision === revision) {
      return;
    }
    unfilteredRevision = revision;
    unfilteredTotal = null;
    const state = { ...session.state, query: { ...session.query, text: '', filter: {} } };
    void untrack(() => bulk.count(state)).then((total) => {
      if (unfilteredRevision === revision) {
        unfilteredTotal = total;
      }
    });
  });
  const statusTotal = $derived(appliedFilterCount > 0 ? unfilteredTotal : scopeTotal);
  /**
   * A brand-new library: nothing in it and nothing narrowing it. It gets the first-run state with
   * Upload, and the chrome that only makes sense with photos (layout switch, results toolbar,
   * grouping, status capsule) stays away until there is something to arrange.
   */
  const uploadStats = uploadAssetsStore.stats;
  // Only the owner's own Photos timeline: an empty Best Photos, Locked or map area is not a new library.
  const firstRun = $derived(!publicView && !selectionMode && ownTimeline && !session.filterActive && resultCount === 0);
  /** Selected items this view does not show (chosen elsewhere with the same session), App.jsx's "outside". */
  const selectedOutside = $derived(snapshot ? 0 : session.selection.filter((id) => !findAsset(id)).length);

  const showTimeline = (grouping: LibraryGrouping) => {
    session.setLayout('timeline');
    if (session.state.grouping !== grouping) {
      session.patchView({ grouping });
    }
  };

  /**
   * Arrow keys move focus between tiles in visual order (prototype `App.jsx` `moveFocus`). Left and
   * right step through the order; up and down take the nearest tile in the row above or below,
   * because justified rows do not share columns. The focused tile is scrolled only as far as it
   * needs to be, and focusing it makes it the session's scroll anchor.
   */
  const moveTileFocus = (id: string) => {
    const tiles = [...(root?.querySelectorAll<HTMLElement>('[data-asset-id]') ?? [])];
    if (tiles.length === 0) {
      return;
    }
    const active = document.activeElement;
    let index = tiles.findIndex((tile) => tile.contains(active));
    if (index === -1) {
      const anchor = session.session.scrollAnchor;
      index = anchor ? tiles.findIndex((tile) => tile.dataset.assetId === anchor) : -1;
    }
    let next: HTMLElement | undefined;
    if (index === -1) {
      next = tiles[0];
    } else if (id === 'navigate-previous' || id === 'navigate-next') {
      // ← and → move by reading order: the grid runs right to left in an RTL page
      const step = isForwardKey(id === 'navigate-next' ? 'ArrowRight' : 'ArrowLeft') ? 1 : -1;
      next = tiles[Math.min(tiles.length - 1, Math.max(0, index + step))];
    } else {
      const current = tiles[index].getBoundingClientRect();
      const down = id === 'focus-down';
      const centre = current.left + current.width / 2;
      let bestRow: number | undefined;
      let bestDistance = Infinity;
      for (const tile of tiles) {
        const box = tile.getBoundingClientRect();
        const inRow = down ? box.top >= current.bottom - 1 : box.bottom <= current.top + 1;
        if (!inRow) {
          continue;
        }
        const rowDistance = down ? box.top - current.bottom : current.top - box.bottom;
        const distance = Math.abs(box.left + box.width / 2 - centre);
        if (bestRow === undefined || rowDistance < bestRow - 1) {
          bestRow = rowDistance;
          bestDistance = distance;
          next = tile;
        } else if (Math.abs(rowDistance - bestRow) <= 1 && distance < bestDistance) {
          bestDistance = distance;
          next = tile;
        }
      }
    }
    const button = next?.querySelector<HTMLElement>('button');
    if (!next || !button) {
      return;
    }
    button.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
  };

  /* ---------------------------------------------------------------------- */
  /* Toolbar, tile and keyboard actions (FL-30, FL-33)                        */
  /* ---------------------------------------------------------------------- */

  let selectionBarRef = $state<SelectionBarComponent>();
  let moreActionsOpen = $state(false);

  /** A library page with its own chrome: not public, not a picking step. */
  const libraryChrome = $derived(!publicView && !selectionMode);

  /**
   * The page's bulk context as the bar sees it. The Locked view is Locked whether or not the page
   * said so, so the bar's Locked rules (no favorite, stack, archive; permanent delete) always apply.
   */
  const keyContext = $derived({
    ...bulkContext,
    currentUserId,
    locked: !!bulkContext?.locked || options?.visibility === AssetVisibility.Locked,
  });

  const toKeyItem = (asset: TimelineAsset): KeyItem => ({ ...toBulk(asset), isImage: asset.isImage });

  /** Items a bar action selected on its own; put back to nothing if that action is cancelled. */
  let barSelectedIds: string[] | null = null;

  /** Run an action through the bar, on the selection or, with none, on these items selected first. */
  const performOnBar = async (id: BulkActionId, ids: string[]) => {
    if (!selectionBarRef || selectionBar || noSelectionBar || ids.length === 0) {
      return;
    }
    if (session.selection.length === 0) {
      session.dispatch({ type: 'selection', ids });
      barSelectedIds = ids;
      await tick();
    }
    selectionBarRef.performAction(id);
  };

  /** The bar's dialog closed: a cancelled action started from a key or a tile leaves nothing selected. */
  const onBarDialogSettled = (submitted: boolean) => {
    const selected = barSelectedIds;
    barSelectedIds = null;
    if (!submitted && selected && session.selection.every((id) => selected.includes(id))) {
      session.clearSelection();
    }
  };

  /**
   * Run an action on items without selecting them (a tile's heart, the F key on a focused tile), and
   * only where the bar itself would offer it for them (`bulkActions`).
   */
  const runOn = (id: BulkActionId, ids: string[], payload?: BulkPayload) => {
    const items = ids
      .map((assetId) => findAsset(assetId))
      .filter((asset): asset is TimelineAsset => !!asset)
      .map((asset) => toKeyItem(asset));
    if (!barOffers(id, items, keyContext)) {
      return;
    }
    actionTargets = ids;
    if (id === 'download') {
      void effectiveDownloadName().then((fileName) => void bulk.run(id, ids, { ...payload, fileName }));
      return;
    }
    void bulk.run(id, ids, payload);
  };

  /** A tile's hover quick actions (prototype `AssetTile.jsx` `.at-actions`). */
  const quickActionsFor = (asset: TimelineAsset): TileQuickActions | null => {
    if (!libraryChrome) {
      return null;
    }
    const available = tileActionAvailability(asset, {
      currentUserId,
      canEdit: !!viewer,
      canShare: !selectionBar && !noSelectionBar,
      canOpen: !!viewer,
      trash: !!bulkContext?.trash,
      locked: keyContext.locked,
    });
    return {
      onFavorite: available.favorite
        ? () => runOn(asset.isFavorite ? 'unfavorite' : 'favorite', [asset.id])
        : undefined,
      onEdit: available.edit ? () => editAsset(asset) : undefined,
      onShare: available.share ? () => void performOnBar('create-shared-link', [asset.id]) : undefined,
      // Prototype `onMore={(id) => openViewer(id)}`: the viewer holds every other action.
      onMore: available.more ? () => openAsset(asset) : undefined,
      onContextMenu: selectionBar || noSelectionBar ? undefined : (event) => void openTileMenu(asset, event),
    };
  };

  /** Right-click a tile: as in Finder it becomes the selection unless already in it, then the bar's actions open at the pointer. */
  const openTileMenu = async (asset: TimelineAsset, event: MouseEvent) => {
    if (!session.selection.includes(asset.id)) {
      session.dispatch({ type: 'selection', ids: [asset.id] });
      await tick();
    }
    selectionBarRef?.openContextMenu(event.clientX, event.clientY);
  };

  /** The first item in view order that is loaded. */
  const firstLoaded = () => {
    for (const month of manager.months) {
      for (const day of month.timelineDays) {
        const asset = day.viewerAssets.find((viewerAsset) => viewerAsset.asset)?.asset;
        if (asset) {
          return asset;
        }
      }
    }
    return null;
  };

  /**
   * The toolbar's Slideshow (prototype `openViewer(selected ?? visible[0], "collection", true)`):
   * the existing slideshow starts from the item in focus, or the first, or a random one when the
   * slideshow shuffles, exactly as an album's Slideshow does.
   */
  const startSlideshow = async () => {
    const { slideshowNavigation, slideshowState } = slideshowStore;
    const focused = focusedId();
    const asset =
      get(slideshowNavigation) === SlideshowNavigation.Shuffle
        ? await manager.getRandomAsset()
        : ((focused ? findAsset(focused) : null) ?? firstLoaded());
    if (!asset) {
      return;
    }
    openAsset(asset);
    slideshowState.set(SlideshowState.PlaySlideshow);
  };

  const canSlideshow = $derived(libraryChrome && !!viewer && !headerHasSlideshow);
  const canSelectAllMatching = $derived(!selectionBar && !noSelectionBar);
  /**
   * Grid or List in the toolbar, in every layout as in the template (LIB-P7). The Timeline is drawn
   * as a grid of dated rows, so Grid reads as chosen there. A public page has neither, and nor has
   * Locked, which offers the Timeline only.
   */
  const toolbarView = $derived(publicView || lockedView ? undefined : listView ? ('list' as const) : ('grid' as const));

  /**
   * The toolbar's Grid or List. The list is Browse's and Work's rows (S-15), so choosing List in the
   * Timeline shows the photos as a list in Browse, the default layout, and the switch above says so.
   */
  const changeView = (view: 'grid' | 'list') => {
    if (view === 'list' && gridLayout === 'timeline') {
      showLibraryLayout(session, 'browse');
    }
    session.patchView({ view });
  };

  /** The tile that holds keyboard focus, if any. The scroll anchor is not a focus. */
  const focusedTileAsset = () => {
    const active = document.activeElement;
    const tile = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-asset-id]') : null;
    const id = tile && root?.contains(tile) ? tile.dataset.assetId : null;
    return id ? findAsset(id) : null;
  };

  /** Prototype `setRating(current, value)`: the owner rates one item; 0 clears the rating. */
  const rateAsset = async (asset: TimelineAsset, value: number) => {
    const rating = value === 0 ? null : value;
    try {
      await updateAsset({ id: asset.id, updateAssetDto: { rating } });
      manager.update([asset.id], (item) => void (item.rating = rating));
    } catch (error) {
      handleError(error, $t('errors.unable_to_set_rating'));
    }
  };

  /** Prototype `beginFaceTagging`: the viewer opens with the face tagger on. */
  const tagPeople = (asset: TimelineAsset) => {
    if (!assetViewerManager.isFaceEditMode) {
      assetViewerManager.toggleFaceEditMode();
    }
    openAsset(asset);
  };

  /**
   * The action half of the library key map (prototype `App.jsx` library keydown, `shortcuts.mjs`
   * "actions"), planned by `planKeyAction` so a key only does what the bar would offer. Returns
   * true when the key was used.
   */
  const runActionShortcut = (shortcut: LibraryShortcut): boolean => {
    if (!libraryChrome) {
      return false;
    }
    const focused = focusedTileAsset();
    const plan = planKeyAction(shortcut, {
      selection: session.selection
        .map((id) => findAsset(id))
        .filter((asset): asset is TimelineAsset => !!asset)
        .map((asset) => toKeyItem(asset)),
      snapshot: !!snapshot,
      focused: focused ? toKeyItem(focused) : null,
      context: keyContext,
      ratingsEnabled: authManager.authenticated && authManager.preferences.ratings.enabled,
      hasViewer: !!viewer,
    });
    const assetOf = (id: string) => findAsset(id);
    switch (plan.kind) {
      case 'none': {
        return false;
      }
      case 'run': {
        runOn(plan.action, plan.ids, plan.payload);
        return true;
      }
      case 'bar': {
        void performOnBar(plan.action, plan.ids);
        return true;
      }
      case 'rate': {
        const asset = assetOf(plan.id);
        if (asset) {
          void rateAsset(asset, plan.value);
        }
        return true;
      }
      case 'edit': {
        const asset = assetOf(plan.id);
        if (asset) {
          editAsset(asset);
        }
        return true;
      }
      case 'tag-people': {
        const asset = assetOf(plan.id);
        if (asset) {
          tagPeople(asset);
        }
        return true;
      }
      case 'select-hint': {
        if (plan.id && !session.selection.includes(plan.id)) {
          session.select(plan.id);
        }
        toastManager.primary($t(plan.hint));
        return true;
      }
      case 'toast': {
        toastManager.primary($t(plan.message));
        return true;
      }
    }
  };

  /**
   * One key map serves the timeline and the viewer. The entries this page can act on itself are
   * handled here; the rest are handed to the owner of that action.
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    if (document.querySelector(MODAL_SELECTOR)) {
      return;
    }
    // While the viewer is open the keys belong to it. The session's open item outlives the viewer
    // (reopening it resumes it), so it is the viewer itself that decides.
    const surface = assetViewerManager.isViewing ? 'viewer' : 'timeline';
    const shortcut = matchLibraryShortcut(event, { surface });
    if (!shortcut) {
      return;
    }
    // FL-61: while Compare is open only Escape (back to the results) reaches the library; selecting,
    // grouping or acting on the selection underneath would change what is being compared
    if (comparing && shortcut.id !== 'close') {
      return;
    }
    switch (shortcut.id) {
      case 'help': {
        event.preventDefault();
        helpOpen = true;
        return;
      }
      case 'info': {
        // I shows or hides the information panel (prototype `case "info"`); in the viewer the key is the viewer's.
        if (surface !== 'timeline' || !canShowInfoPanel) {
          break;
        }
        event.preventDefault();
        inspectorOpen = !inspectorOpen;
        return;
      }
      case 'select-all': {
        event.preventDefault();
        session.selectAll(loadedIds());
        return;
      }
      case 'clear-selection': {
        event.preventDefault();
        session.clearSelection();
        return;
      }
      case 'select': {
        const id = focusedId();
        if (id) {
          event.preventDefault();
          session.select(id);
        }
        return;
      }
      case 'close': {
        if (comparing) {
          event.preventDefault();
          session.patchView({ view: 'grid' });
          return;
        }
        // The docked Filters panel closes first, as the template's Escape closes `panel`.
        if (filterPanelOpen && surface === 'timeline') {
          event.preventDefault();
          filterPanelOpen = false;
          return;
        }
        if (surface === 'viewer') {
          // The viewer closes itself; the item stays open so reopening it resumes it.
          return;
        }
        if (selecting) {
          event.preventDefault();
          session.clearSelection();
          return;
        }
        break;
      }
      case 'navigate-previous':
      case 'navigate-next':
      case 'focus-up':
      case 'focus-down': {
        // A control that already used the key (the date scrubber, a menu) keeps it.
        if (surface !== 'timeline' || event.defaultPrevented) {
          break;
        }
        event.preventDefault();
        moveTileFocus(shortcut.id);
        return;
      }
      case 'group-days':
      case 'group-months':
      case 'group-years': {
        // As in the prototype (`App.jsx` `jump`), D, M and Y show the Timeline layout grouped by
        // that unit. Grouping is page state: it travels in a link and survives a layout switch.
        event.preventDefault();
        showTimeline(shortcut.id.replace('group-', '') as LibraryGrouping);
        return;
      }
      case 'layout-timeline':
      case 'layout-browse':
      case 'layout-work': {
        // LIB-01: the tabs scroll away with the header, so the keys switch from anywhere in the
        // library and keep the place as the tabs do. Locked offers the Timeline only.
        if (surface !== 'timeline' || publicView || firstRun || lockedView) {
          break;
        }
        event.preventDefault();
        showLibraryLayout(session, shortcut.id.replace('layout-', '') as LibraryLayout);
        return;
      }
      case 'go-to-date': {
        if (surface !== 'timeline') {
          break;
        }
        // The prototype's "Go to a date": the Timeline layout, then the date scrubber takes focus so
        // the arrow, Page and Home/End keys move through the months.
        event.preventDefault();
        showTimeline(session.state.grouping === 'all' ? 'days' : session.state.grouping);
        void tick().then(() => root?.querySelector<HTMLElement>('[role="slider"]')?.focus());
        return;
      }
      default: {
        // Actions belong to the viewer while it is open, and a dialog keeps its keys.
        if (
          surface === 'timeline' &&
          libraryKeysActive({
            viewing: assetViewerManager.isViewing,
            defaultPrevented: event.defaultPrevented,
            typing: isTypingTarget(event.target),
          }) &&
          runActionShortcut(shortcut)
        ) {
          event.preventDefault();
          return;
        }
        break;
      }
    }
    onShortcut?.(shortcut);
  };
</script>

<svelte:window onkeydown={handleKeyDown} />

<div
  class="frameleaf fl-library"
  class:has-sticky-toolbar={!publicView}
  data-theme={appTheme}
  data-testid="frameleaf-library"
  data-layout={gridLayout}
  bind:this={root}
>
  {@render shell?.()}

  <div class="fl-library-body" class:has-panel={showInfoPanel}>
    <div class="fl-library-main" bind:this={main}>
      <!-- LIB-09: the year scrubber and the stuck toolbar stack above Compare's overlay, so the
           timeline is hidden (and out of the tab order) while Compare is open. It stays mounted,
           so the scroll position survives Done. -->
      <div class="fl-behind-compare" inert={comparing}>
        <LibraryTimeline
          timelineManager={manager}
          {session}
          {ratingFor}
          sensitiveFor={lockedView ? isLockedRuleMatch : undefined}
          {tileLayout}
          thumbnailSize={libraryGridPreferences.thumbnailSize}
          showFileNames={libraryGridPreferences.showFileNames}
          onThumbnailSizeChange={publicView ? undefined : (size) => (libraryGridPreferences.thumbnailSize = size)}
          showDayHeaders={gridLayout === 'timeline'}
          grouping={gridLayout === 'timeline' ? session.state.grouping : 'days'}
          onGroupingChange={gridLayout === 'timeline' && !firstRun
            ? (grouping) => session.patchView({ grouping })
            : undefined}
          {enableRouting}
          {selectionMode}
          {singleSelect}
          {onSelect}
          {onTileClick}
          {tileOverlay}
          {onOpen}
          quickActions={quickActionsFor}
          timelineCaptions={gridLayout === 'timeline'}
          empty={emptyState}
          {gutter}
        >
          {#snippet header()}
            <!-- Prototype `.collection-header`: the page's own header and the layout switch beside it. -->
            <div class="fl-library-header" class:has-title={!!title} class:has-toolbar={!publicView && !firstRun}>
              <div class="fl-library-header-content">
                {#if title}
                  <h1 class="fl-library-title">{title}</h1>
                {/if}
                {@render children?.()}
              </div>
              <!-- LIB-P5: phones too show Timeline, Browse and Work beside the title, as the template does. -->
              {#if !publicView && !firstRun}
                <LibraryLayoutSwitch {session} layouts={lockedView ? ['timeline'] : undefined} />
              {/if}
            </div>
            {#if subheader}
              <div class="fl-library-subheader">{@render subheader()}</div>
            {/if}
            {#if !publicView && !firstRun}
              <div class="fl-library-toolbar" bind:this={toolbarStrip}>
                <!-- Compare, Quick edit and Open in Studio live on the selection bar (September 24). -->
                <ResultsToolbar
                  {session}
                  onOpenFilterPanel={openFilterPanel}
                  {filterPanelOpen}
                  onCloseFilterPanel={closeFilterPanel}
                  count={resultCount}
                  onSlideshow={canSlideshow ? () => void startSlideshow() : undefined}
                  inspectorOpen={canShowInfoPanel ? inspectorOpen : undefined}
                  onToggleInspector={() => (inspectorOpen = !inspectorOpen)}
                  {sorts}
                  sort={shownSort}
                  onSortChange={albumSortId || ranked ? changeAlbumSort : undefined}
                  unappliedFields={queryApplied.unapplied}
                  view={toolbarView}
                  onViewChange={changeView}
                  onMoreActions={libraryChrome ? () => (moreActionsOpen = true) : undefined}
                  leading={toolbarStart}
                >
                  {@render toolbar?.()}
                  <!-- FL-33: Work's file-name toggle lives in the sticky toolbar, in Work only. -->
                  {#if gridLayout === 'work' && !listView}
                    <WorkFileNamesToggle />
                  {/if}
                </ResultsToolbar>
              </div>
            {/if}
          {/snippet}
        </LibraryTimeline>

        {#if onShowMore}
          <ShowMore {session} {onShowMore} {loading} />
        {/if}
      </div>

      {#if comparing}
        <div class="fl-library-compare">
          <LibraryCompare selection={session.selection} onDone={() => session.patchView({ view: 'grid' })} />
        </div>
      {/if}
    </div>

    {#if filterPanelOpen && libraryChrome}
      <LibraryFilterPanel
        query={session.query}
        countQuery={filterCountQuery}
        section={filterSection}
        matchingLabel={resultCount === null
          ? undefined
          : $t('frameleaf_search_matching_for', { values: { label: resultCount.toLocaleString($locale) } })}
        scopeLabel={title}
        count={resultCount}
        onChange={applyFilterPanelQuery}
        onClose={closeFilterPanel}
      />
    {/if}

    {#if showInfoPanel && !publicView}
      <aside class="fl-library-panel" aria-label={$t('frameleaf_work_inspector_title')}>
        {#if infoPanel}
          {@render infoPanel()}
        {:else}
          <LibraryWorkInspector
            asset={inspectedAsset}
            selectedCount={session.selection.length}
            onChooseColor={(color) => {
              applyFilterPanelQuery({ ...session.query, filter: { ...session.query.filter, color } });
              openFilterPanel('media');
            }}
            onOpen={(asset) => {
              session.open(asset.id);
              session.setScrollAnchor(asset.id);
              onOpen?.(asset);
            }}
            onClose={() => (inspectorOpen = false)}
          />
        {/if}
      </aside>
    {/if}
  </div>

  <!-- A picking step confirms in its own chrome, so it asks for no bar at all. -->
  {#if !noSelectionBar}
    {#if selectionBar}
      {#if selecting}
        {@render selectionBar()}
      {/if}
    {:else}
      <!-- FL-32's bar, bound to this session: one selection, one place an action is run. -->
      <SelectionBar
        bind:this={selectionBarRef}
        onDialogSettled={(_id, submitted) => onBarDialogSettled(submitted)}
        {resolveCaptureTimes}
        count={session.selection.length}
        total={selectAll === 'loaded' ? (manager.assetCount ?? null) : (session.total ?? resultCount)}
        assets={selectedAssets}
        selectedIds={session.selection}
        context={{ ...bulkContext, currentUserId, snapshot: !!snapshot }}
        {tagOptions}
        operations={session.session.operations}
        undoLabel={bulk.undo?.label}
        onAction={runBulk}
        onUndo={() => void bulk.undo?.run()}
        onClear={() => session.clearSelection()}
        onSelectAllMatching={() => void (selectAll === 'loaded' ? selectAllLoaded() : selectAllMatching())}
        onCancelOperation={(requestId) => bulk.cancel(requestId)}
        onRetryOperation={(operation) => void bulk.retry(operation)}
        onDismissOperation={(requestId) => bulk.dismiss(requestId)}
        leading={selectionMode || publicView ? [] : leadingActions}
      />
      {#if !selectionMode && !publicView}
        <MakeMovieSheet bind:open={movieOpen} source={movieSource} />
      {/if}
    {/if}
  {/if}
  {#if showStatusBar && !firstRun}
    <!-- App.jsx footer (LIB-P6): the count, the selection, "Saved on this device" and Thumbnail size. -->
    {#if thumbnailControl}
      <LibraryStatusBar
        count={resultCount}
        total={statusTotal}
        selected={session.selection.length}
        outside={selectedOutside}
        saved={savedOnDevice}
        hidden={selecting}
      >
        {#snippet controls()}
          <!-- App.jsx: Thumbnail size on the library's own screen, not a person's or partner's. -->
          <ThumbnailSizeControl animateWithin={() => main} />
        {/snippet}
      </LibraryStatusBar>
    {:else}
      <LibraryStatusBar
        count={resultCount}
        total={statusTotal}
        selected={session.selection.length}
        outside={selectedOutside}
        saved={savedOnDevice}
        hidden={selecting}
      />
    {/if}
  {/if}
  <!-- The viewer decides for itself when it is open; it is the owner of that surface (FL-35). -->
  {@render viewer?.()}
</div>

{#if archiveConfirm}
  <BulkConfirmDialog
    count={archiveConfirm.count}
    bind:open={archiveConfirmOpen}
    labelKey="frameleaf_bulk_archive"
    messageKey="frameleaf_bulk_archive_matching_confirm"
    danger={false}
    onConfirm={() => void confirmMatchingArchive()}
  />
{/if}

{#snippet emptyState()}
  <!-- FL-33 (T-10): the Frameleaf empty state. A filter that leaves nothing says so and offers to clear it. -->
  {#if appliedFilterCount > 0}
    <LibraryEmptyState
      icon={mdiFilterOffOutline}
      title={$t('frameleaf_library_empty_filtered_title')}
      message={$t('frameleaf_library_empty_filtered_message')}
      action={{
        label: $t('frameleaf_library_empty_filtered_clear'),
        onClick: () => session.setQuery({ ...withoutDiscoveryFilters(session.query), text: '' }),
      }}
    />
  {:else if empty}
    {@render empty()}
  {:else if firstRun && $uploadStats.success > 0}
    <!-- Uploads finished, but a photo joins the grid only once its thumbnails exist (on_upload_success). -->
    <LibraryEmptyState
      icon={mdiImageMultipleOutline}
      title={$t('frameleaf_library_first_run_preparing_title')}
      message={$t('frameleaf_library_first_run_preparing_message')}
    />
  {:else if firstRun}
    <!-- A new library leads somewhere: the same pickers as the top bar's Upload menu. -->
    <LibraryEmptyState
      icon={mdiTrayArrowUp}
      title={$t('frameleaf_library_first_run_title')}
      message={$t('frameleaf_library_first_run_message')}
      primary
      action={{
        label: $t('frameleaf_library_first_run_upload'),
        icon: mdiImageMultipleOutline,
        onClick: () => void openFileUploadDialog(),
      }}
      secondaryAction={{
        label: $t('frameleaf_transfer_upload_folder'),
        icon: mdiFolderOutline,
        onClick: () => void openFileUploadDialog({ directory: true }),
      }}
      hint={mediaQueryManager.pointerCoarse ? undefined : $t('frameleaf_library_first_run_hint')}
    />
  {:else}
    <LibraryEmptyState icon={mdiCalendarRange} message={$t('frameleaf_library_empty')} />
  {/if}
{/snippet}

{#if moreActionsOpen}
  <!-- Prototype `panel === "actions"`: the view's actions in one sheet. Compare is on the selection bar only. -->
  <Dialog bind:open={moreActionsOpen} title={$t('frameleaf_library_view_actions_title')} closeLabel={$t('close')}>
    <div class="fl-action-list">
      {#if canSelectAllMatching}
        <Button
          disabled={resultCount === 0}
          onclick={() => {
            moreActionsOpen = false;
            void (selectAll === 'loaded' ? selectAllLoaded() : selectAllMatching());
          }}
        >
          {resultCount === null
            ? $t('frameleaf_library_select_all_matching')
            : $t('frameleaf_library_select_all_matching_count', { values: { count: resultCount } })}
        </Button>
      {/if}
      {#if canShowInfoPanel}
        <Button
          onclick={() => {
            inspectorOpen = !inspectorOpen;
            moreActionsOpen = false;
          }}
        >
          {$t(inspectorOpen ? 'frameleaf_work_inspector_hide' : 'frameleaf_work_inspector_show')}
        </Button>
      {/if}
    </div>
  </Dialog>
{/if}

{#if helpOpen}
  <ShortcutsHelp surface={assetViewerManager.isViewing ? 'viewer' : 'timeline'} onClose={() => (helpOpen = false)} />
{/if}

<style>
  .fl-library {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  /*
   * LIB-P4: the library as the page itself (Photos, Favorites, Archive ...) gives back the page area's
   * 8px inset (UserPageLayout `p-2`) at the top and both sides, so its scroll area, and with it the
   * frosted toolbar band, reaches the top bar, the rail and the window edge. The page gutter is kept
   * inside the scroll area (`gutter`). A page that wraps it (an album, a tag, a person) pads its own
   * column, and the band then spans that column.
   */
  :global(.fl-scope) > .fl-library {
    margin: -0.5rem -0.5rem 0;
    height: calc(100% + 0.5rem);
  }
  .fl-library-body {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .fl-library-main {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }
  /*
   * apple-style.css "#3 materials": the header scrolls away and the frosted toolbar stays. The
   * timeline's header block spans the whole scroll height (LibraryTimeline), and the Years and
   * Months cards draw it in their own scroller, so the toolbar can stick by itself in either while
   * the header above it and the grouping row below it scroll away as in the template.
   */
  .fl-library-header {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
  }
  /* Template `.collection-header` border: one hairline across the page, over the toolbar band. */
  .fl-library-header.has-toolbar::after {
    content: '';
    position: absolute;
    bottom: 0;
    inset-inline: calc(-1 * var(--fl-library-gutter-start, 0px)) calc(-1 * var(--fl-library-gutter-end, 0px));
    border-bottom: 1px solid var(--fl-border);
    pointer-events: none;
  }
  .fl-library-header-content {
    flex: 1 1 auto;
    min-width: 0;
  }
  /*
   * Under a page's own header (an album, a person, a tag) the tabs take a row of their own and end
   * on the photos' edge, as the prototype draws them. Beside a title, or alone, they stay where they are.
   */
  .fl-library-header:not(.has-title) > .fl-library-header-content:has(> :global(*)) {
    flex-basis: 100%;
  }
  .fl-library-header > :global(.fl-layouts) {
    margin-block: 8px 0;
    margin-inline-start: auto;
  }
  /* The tabs' underline stays clear of the toolbar band (prototype `.collection-header.compact`, 8px). */
  .fl-library-header:has(> :global(.fl-layouts)) {
    padding-bottom: var(--fl-space-2);
  }
  /* Without tabs (phones), a page's own header keeps the room a row of controls above another gets. */
  .fl-library-header:not(:has(> :global(.fl-layouts))):has(> .fl-library-header-content > :global(*)) {
    padding-bottom: var(--fl-space-3);
  }
  /*
   * A named destination (styles.css `.collection-header`, apple-style.css:220-225): the large title
   * and the layout switch share one row, their feet on one line, above the toolbar.
   */
  .fl-library-header.has-title {
    min-height: 77px;
    /* The title starts on the line of the toolbar's count and the photos' edge (template 24px). */
    padding: 0 0 var(--fl-space-3);
  }
  .fl-library-title {
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .fl-library-toolbar {
    position: relative;
  }
  /* Under the header's hairline, clear of it and of the toolbar band (24px between sections). */
  .fl-library-subheader {
    padding-top: var(--fl-space-6);
  }
  /*
   * Phones: the photos keep the page area's 8px edge; the header and the toolbar's text and controls
   * sit at the 16px page gutter.
   */
  @media (max-width: 767px) {
    .fl-library-header,
    .fl-library-header.has-title,
    .fl-library-subheader,
    .fl-library-toolbar {
      padding-inline: var(--fl-space-2);
    }
  }
  .fl-library.has-sticky-toolbar .fl-library-toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
  }
  .fl-library-toolbar::before {
    /* LIB-P4: the frosted band spans the scroll area edge to edge, over the gutters and the scrubber's column. */
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline: calc(-1 * var(--fl-library-gutter-start, 0px)) calc(-1 * var(--fl-library-gutter-end, 0px));
    z-index: -1;
    border-bottom: 1px solid var(--fl-material-edge);
    background: var(--fl-material);
    -webkit-backdrop-filter: var(--fl-material-blur);
    backdrop-filter: var(--fl-material-blur);
  }
  /* Large title that shrinks as you scroll (Chrome, Safari 26+); a fade only under Reduce Motion. */
  .fl-library-header :global(h1) {
    transform-origin: left bottom;
  }
  @supports (animation-timeline: scroll()) {
    /* The Years and Months cards scroll in their own scroller (TimelineCards), the header with them. */
    .fl-library.has-sticky-toolbar :global(:is(.fl-timeline-scroll, .fl-tl-cards-scroll)) {
      scroll-timeline: --fl-library block;
    }
    .has-sticky-toolbar .fl-library-header :global(h1) {
      animation: fl-title-shrink linear both;
      animation-timeline: --fl-library;
      animation-range: 0 90px;
    }
    @media (prefers-reduced-motion: reduce) {
      .has-sticky-toolbar .fl-library-header :global(h1) {
        animation-name: fl-title-fade;
      }
    }
  }
  @keyframes fl-title-shrink {
    to {
      scale: 0.62;
      opacity: 0.2;
    }
  }
  @keyframes fl-title-fade {
    to {
      opacity: 0.2;
    }
  }
  .fl-behind-compare {
    display: contents;
  }
  .fl-behind-compare[inert] {
    visibility: hidden;
  }
  .fl-library-compare {
    position: absolute;
    inset: 0;
    z-index: 3;
    overflow-y: auto;
    background: var(--fl-canvas);
  }
  /* Prototype `.action-list`. */
  .fl-action-list {
    display: grid;
    gap: 8px;
  }
  .fl-action-list :global(button) {
    justify-content: flex-start;
  }
  .fl-library-panel {
    flex: 0 0 320px;
    overflow-y: auto;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
</style>
