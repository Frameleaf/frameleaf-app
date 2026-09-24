<script lang="ts">
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
   */
  import { browser } from '$app/environment';
  import { afterNavigate, goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import BulkConfirmDialog from '$lib/components/frameleaf/BulkConfirmDialog.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import LibraryCompare from '$lib/components/frameleaf/LibraryCompare.svelte';
  import LibraryStatusBar from '$lib/components/frameleaf/LibraryStatusBar.svelte';
  import ThumbnailSizeControl from '$lib/components/frameleaf/ThumbnailSizeControl.svelte';
  import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
  import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
  import ResultsToolbar from '$lib/components/frameleaf/ResultsToolbar.svelte';
  import SelectionBar from '$lib/components/frameleaf/SelectionBar.svelte';
  import ShortcutsHelp from '$lib/components/frameleaf/ShortcutsHelp.svelte';
  import ShowMore from '$lib/components/frameleaf/ShowMore.svelte';
  import WorkFileNamesToggle from '$lib/components/frameleaf/WorkFileNamesToggle.svelte';
  import type { DiscoveryDestination, DiscoveryFilterSection } from '$lib/components/discovery/query';
  import { namedEntitySegments, withArchiveDetail } from '$lib/frameleaf/archive-name';
  import { preparesArchiveOnServer } from '$lib/frameleaf/archive-operations';
  import type { BulkAsset, BulkActionContext, BulkActionId } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { type FilterEntityKind, resolveEntityNames } from '$lib/frameleaf/filter-entity-names';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { librarySession, type LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibraryGrouping, LibrarySessionAction } from '$lib/frameleaf/library-session';
  import {
    describeFilterFields,
    filterFieldEntityIds,
    type FilterChipDescription,
  } from '$lib/frameleaf/library-filters';
  import { matchLibraryShortcut, type LibraryShortcut } from '$lib/frameleaf/library-shortcuts';
  import type { SelectionBarLeadingAction } from '$lib/frameleaf/selection-bar';
  import { revealsLocks } from '$lib/frameleaf/session-access.svelte';
  import { maxStudioHandoffAssets } from '$lib/frameleaf/studio/handoff';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { Route } from '$lib/route';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset, TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { AssetVisibility, type ArchiveOperationResponseDto } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiCompare, mdiOpenInNew, mdiPencilOutline, mdiTuneVariant } from '@mdi/js';
  import { hasRouterStarted } from '$lib/utils/router-started';
  import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
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
    /** Rendered above the results toolbar, inside the scrolling area. */
    children?: Snippet;
    /** Extra results-toolbar controls (sort, grouping, view). */
    toolbar?: Snippet;
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
    children,
    toolbar,
    selectionBar,
    noSelectionBar = false,
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
  }: Props = $props();

  timelineManager = new TimelineManager();
  onDestroy(() => timelineManager?.destroy());

  let helpOpen = $state(false);
  let restored = false;
  // FL-34: mounted by the session privacy gate after the first navigation, the router is ready already
  let routerReady = $state(hasRouterStarted());
  afterNavigate(() => {
    routerReady = true;
  });

  const manager = $derived(timelineManager as TimelineManager);
  /** The layout the grid is drawn in; a public page has no layout switch and stays on Browse. */
  const gridLayout = $derived(publicView ? 'browse' : session.layout);
  /**
   * Work's information panel can be closed and opened again (prototype `inspector`); switching to
   * Work opens it again, as the template's layout switch does.
   */
  let inspectorOpen = $state(true);
  let inspectorLayout: string | undefined;
  $effect(() => {
    const layout = gridLayout;
    if (inspectorLayout !== undefined && layout !== inspectorLayout && layout === 'work') {
      inspectorOpen = true;
    }
    inspectorLayout = layout;
  });
  // Work opens the information panel only above tablet width; on phones it never auto-opens.
  const canShowInfoPanel = $derived(gridLayout === 'work' && !mediaQueryManager.maxMd);
  const showInfoPanel = $derived(canShowInfoPanel && inspectorOpen && !sidePanelOpen);
  const selecting = $derived(session.selection.length > 0);
  /** FL-61: the Compare view (culling) is open over the results, which stay where they were. */
  const comparing = $derived(session.state.view === 'compare');

  $effect(() => {
    if (options) {
      void manager.updateOptions(options);
    }
  });

  $effect(() => {
    session.destination = destination;
  });

  // Restore once per mount: the URL's portable state wins over the stored view, and layout comes
  // from storage because it is device-local.
  $effect(() => {
    if (restored || !browser) {
      return;
    }
    restored = true;
    session.restore(page.url, authManager.authenticated ? authManager.user.id : undefined);
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
    if (!browser || !restored || !state || !layout) {
      return;
    }
    savedOnDevice = session.persist(authManager.authenticated ? authManager.user.id : undefined);
    if (syncUrl && routerReady) {
      const next = session.viewUrl(page.url);
      if (next.href !== page.url.href) {
        replaceState(next, page.state);
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
    manager.update(ids, patch);
    const left = ids.filter((id) => {
      const asset = findAsset(id);
      return !!asset && manager.isExcluded(asset);
    });
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
      },
      currentUserId: authManager.authenticated ? authManager.user.id : undefined,
      ownerById: Object.fromEntries(
        session.selection.map((id) => [id, findAsset(id)?.ownerId]).filter(([, owner]) => !!owner) as [
          string,
          string,
        ][],
      ),
    }),
  });

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
  });

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
    if (beforeAction) {
      void Promise.resolve(beforeAction(id)).then((allowed) => (allowed ? dispatchBulk(id, payload) : undefined));
      return;
    }
    dispatchBulk(id, payload);
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
    return [chip.detail ?? $t(chip.labelKey)];
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
      Object.keys(options).every((key) => ['visibility', 'withStacked', 'withPartners'].includes(key)),
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
    const total = await bulk.count(session.state);
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

  const findAsset = (id: string): TimelineAsset | null => {
    for (const month of manager.months) {
      for (const day of month.timelineDays) {
        const match = day.viewerAssets.find((viewerAsset) => viewerAsset.id === id);
        if (match?.asset) {
          return match.asset;
        }
      }
    }
    return null;
  };

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
  /** Where scroll-driven animation exists, the grouping row fades away under the toolbar. */
  const groupingScrollsAway = typeof CSS !== 'undefined' && !!CSS.supports?.('animation-timeline: scroll()');

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
      const strip = toolbarStrip;
      if (!strip) {
        return;
      }
      // As in the template only the results toolbar stays; the Timeline grouping row below it
      // scrolls away (timeline-library.css `.tl-toolbar` is not sticky). Timeline rows pin the whole
      // header block, so the grouping row is faded out by scroll where the browser can; elsewhere it
      // stays pinned inside the frosted strip. Years and Months cards pin the toolbar alone.
      const top = strip.closest<HTMLElement>('.fl-timeline-top');
      const offsetTop = top ? strip.offsetTop : 0;
      host.style.setProperty('--fl-toolbar-top', `${offsetTop}px`);
      host.style.setProperty(
        '--fl-sticky-offset',
        `${Math.round(top && !groupingScrollsAway ? top.offsetHeight - offsetTop : strip.offsetHeight)}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    if (toolbarStrip) {
      observer.observe(toolbarStrip);
      const top = toolbarStrip.closest('.fl-timeline-top');
      if (top) {
        observer.observe(top);
      }
    }
    // The window and the rail change the photo area's own size, so observing it covers both.
    observer.observe(document.documentElement);
    measure();
    return () => observer.disconnect();
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
    // The viewer opens straight into the quick editor, which edits this one item.
    assetViewerManager.openEditor();
    session.open(asset.id);
    session.setScrollAnchor(asset.id);
    onOpen?.(asset);
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

  const leadingActions = $derived<SelectionBarLeadingAction[]>([
    {
      id: 'compare',
      label: $t('frameleaf_compare_title'),
      icon: mdiCompare,
      disabled: session.selection.length < 2 || !!snapshot,
      onClick: () => session.patchView({ view: 'compare' }),
    },
    ...(viewer
      ? [
          {
            id: 'quick-edit',
            label: $t('frameleaf_selection_quick_edit'),
            icon: mdiPencilOutline,
            disabled: !canQuickEdit,
            onClick: openQuickEdit,
          },
        ]
      : []),
    {
      id: 'studio',
      label: $t('frameleaf_selection_open_in_studio'),
      icon: mdiOpenInNew,
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
  const resultCount = $derived(session.filterActive ? session.total : scopeTotal);
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
      next = tiles[Math.min(tiles.length - 1, Math.max(0, index + (id === 'navigate-next' ? 1 : -1)))];
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

  /**
   * One key map serves the timeline and the viewer. The entries this page can act on itself are
   * handled here; the rest are handed to the owner of that action.
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    // While the viewer is open the keys belong to it.
    const surface = session.openAssetId ? 'viewer' : 'timeline';
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
        // I shows or hides Work's panel (prototype `case "info"`); in the viewer the key is the viewer's.
        if (surface !== 'timeline' || !canShowInfoPanel || publicView) {
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
        if (session.openAssetId) {
          event.preventDefault();
          session.close();
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
  data-testid="frameleaf-library"
  data-layout={gridLayout}
  bind:this={root}
>
  {@render shell?.()}

  <div class="fl-library-body" class:has-panel={showInfoPanel}>
    <div class="fl-library-main" bind:this={main}>
      <LibraryTimeline
        timelineManager={manager}
        {session}
        {ratingFor}
        tileLayout={gridLayout}
        thumbnailSize={libraryGridPreferences.thumbnailSize}
        showFileNames={libraryGridPreferences.showFileNames}
        onThumbnailSizeChange={publicView ? undefined : (size) => (libraryGridPreferences.thumbnailSize = size)}
        showDayHeaders={gridLayout === 'timeline'}
        grouping={gridLayout === 'timeline' ? session.state.grouping : 'days'}
        onGroupingChange={gridLayout === 'timeline' ? (grouping) => session.patchView({ grouping }) : undefined}
        {enableRouting}
        {selectionMode}
        {singleSelect}
        {onSelect}
        {onTileClick}
        {tileOverlay}
        {onOpen}
        {empty}
      >
        {#snippet header()}
          <div class="fl-library-header">{@render children?.()}</div>
          {#if !publicView}
            <div class="fl-library-toolbar" bind:this={toolbarStrip}>
              <ResultsToolbar {session} {onOpenFilterPanel}>
                {@render toolbar?.()}
                <!-- FL-33: Work's file-name toggle lives in the sticky toolbar, in Work only. -->
                {#if gridLayout === 'work'}
                  <WorkFileNamesToggle />
                {/if}
                {#if canShowInfoPanel}
                  <IconButton
                    label={$t(inspectorOpen ? 'frameleaf_work_inspector_hide' : 'frameleaf_work_inspector_show')}
                    pressed={inspectorOpen}
                    onclick={() => (inspectorOpen = !inspectorOpen)}
                  >
                    <Icon icon={mdiTuneVariant} size="18" aria-hidden />
                  </IconButton>
                {/if}
                <!-- Compare, Quick edit and Open in Studio live on the selection bar (September 24). -->
              </ResultsToolbar>
            </div>
          {/if}
        {/snippet}
      </LibraryTimeline>

      {#if onShowMore}
        <ShowMore {session} {onShowMore} {loading} />
      {/if}

      {#if comparing}
        <div class="fl-library-compare">
          <LibraryCompare selection={session.selection} onDone={() => session.patchView({ view: 'grid' })} />
        </div>
      {/if}
    </div>

    {#if showInfoPanel && !publicView}
      <aside class="fl-library-panel" aria-label={$t('frameleaf_work_inspector_title')}>
        {#if infoPanel}
          {@render infoPanel()}
        {:else}
          <LibraryWorkInspector
            asset={inspectedAsset}
            selectedCount={session.selection.length}
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
        count={session.selection.length}
        total={selectAll === 'loaded' ? (manager.assetCount ?? null) : session.total}
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
    {/if}
  {/if}
  {#if showStatusBar}
    <LibraryStatusBar
      count={resultCount}
      total={scopeTotal}
      outside={selectedOutside}
      selected={session.selection.length}
      saved={savedOnDevice}
      hidden={selecting}
    >
      {#snippet controls()}
        <!-- App.jsx: Thumbnail size on the library's own screen, not a person's or partner's. -->
        {#if thumbnailControl}
          <ThumbnailSizeControl />
        {/if}
      {/snippet}
    </LibraryStatusBar>
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

{#if helpOpen}
  <ShortcutsHelp surface={session.openAssetId ? 'viewer' : 'timeline'} onClose={() => (helpOpen = false)} />
{/if}

<style>
  .fl-library {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .fl-library-body {
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
   * timeline draws its header block (`.fl-timeline-top`) above the rows; it sticks with a negative
   * top equal to the toolbar's offset, so everything above the toolbar scrolls out of view.
   */
  /* Only where the toolbar exists: a public shared-link page's header simply scrolls away. */
  .fl-library.has-sticky-toolbar :global(.fl-timeline-body > .fl-timeline-top) {
    position: sticky;
    top: calc(-1 * var(--fl-toolbar-top, 0px));
    z-index: 4;
  }
  .fl-library-toolbar {
    position: relative;
  }
  /* Years and Months cards scroll in their own container: the toolbar sticks there by itself. */
  .has-sticky-toolbar :global(.fl-tl-cards-scroll > .fl-library-toolbar) {
    position: sticky;
    top: 0;
    z-index: 4;
  }
  .fl-library-toolbar::before {
    /* The frosted strip spans the scroller's width under the toolbar (and, without scroll-driven
       animation, the pinned grouping row below it). */
    content: '';
    position: absolute;
    inset: 0 -8px auto;
    height: var(--fl-sticky-offset, 100%);
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
    .fl-library.has-sticky-toolbar :global(.fl-timeline-scroll) {
      scroll-timeline: --fl-library block;
    }
    .has-sticky-toolbar .fl-library-header :global(h1) {
      animation: fl-title-shrink linear both;
      animation-timeline: --fl-library;
      animation-range: 0 90px;
    }
    /* The grouping row goes as the rows reach the toolbar, like the template's scrolling .tl-toolbar. */
    .has-sticky-toolbar :global(.fl-timeline-top > .fl-grouping) {
      animation: fl-grouping-away linear both;
      animation-timeline: --fl-library;
      animation-range: var(--fl-toolbar-top, 0px) calc(var(--fl-toolbar-top, 0px) + 40px);
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
  @keyframes fl-grouping-away {
    to {
      opacity: 0;
      visibility: hidden;
    }
  }
  @keyframes fl-title-fade {
    to {
      opacity: 0.2;
    }
  }
  .fl-library-compare {
    position: absolute;
    inset: 0;
    z-index: 3;
    overflow-y: auto;
    background: var(--fl-canvas);
  }
  .fl-library-panel {
    flex: 0 0 320px;
    overflow-y: auto;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
</style>
