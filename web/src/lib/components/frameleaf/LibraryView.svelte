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
   */
  import { browser } from '$app/environment';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LibraryCompare from '$lib/components/frameleaf/LibraryCompare.svelte';
  import LibraryTimeline from '$lib/components/frameleaf/LibraryTimeline.svelte';
  import ResultsToolbar from '$lib/components/frameleaf/ResultsToolbar.svelte';
  import SelectionBar from '$lib/components/frameleaf/SelectionBar.svelte';
  import ShortcutsHelp from '$lib/components/frameleaf/ShortcutsHelp.svelte';
  import ShowMore from '$lib/components/frameleaf/ShowMore.svelte';
  import type { DiscoveryDestination, DiscoveryFilterSection } from '$lib/components/discovery/query';
  import { namedEntitySegments, withArchiveDetail } from '$lib/frameleaf/archive-name';
  import type { BulkAsset, BulkActionContext, BulkActionId } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { type FilterEntityKind, resolveEntityNames } from '$lib/frameleaf/filter-entity-names';
  import { librarySession, type LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibraryGrouping, LibrarySessionAction } from '$lib/frameleaf/library-session';
  import {
    describeFilterFields,
    filterFieldEntityIds,
    type FilterChipDescription,
  } from '$lib/frameleaf/library-filters';
  import { matchLibraryShortcut, type LibraryShortcut } from '$lib/frameleaf/library-shortcuts';
  import { revealsLocks } from '$lib/frameleaf/session-access.svelte';
  import {
    assetMultiSelectManager,
    type AssetMultiSelectManager,
  } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset, TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { AssetVisibility } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { onDestroy, type Snippet } from 'svelte';
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
    ratingFor?: (asset: TimelineAsset) => number | null;
    captionFor?: (asset: TimelineAsset) => string | null;
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
    /**
     * Mirror the session's selection into the existing multi-select manager, so the bulk actions
     * (FL-32, FL-36) act on exactly what the library shows as selected. One selection, two readers.
     */
    multiSelect?: AssetMultiSelectManager | null;
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
    /** FL-36: the information panel. Work opens it above tablet width only. */
    infoPanel?: Snippet;
    empty?: Snippet;
  };

  let {
    options,
    session = librarySession,
    destination,
    timelineManager = $bindable(),
    syncUrl = true,
    ratingFor,
    captionFor,
    onOpenFilterPanel,
    onShowMore,
    onShortcut,
    selectAll = 'matching',
    loading = false,
    enableRouting = false,
    multiSelect = assetMultiSelectManager,
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
    empty,
  }: Props = $props();

  timelineManager = new TimelineManager();
  onDestroy(() => timelineManager?.destroy());

  let helpOpen = $state(false);
  let restored = false;

  const manager = $derived(timelineManager as TimelineManager);
  // Work opens the information panel only above tablet width; on phones it never auto-opens.
  const showInfoPanel = $derived(session.layout === 'work' && !mediaQueryManager.maxMd);
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

  // Persist the device-local part of the session, and keep the link in step with the view state.
  $effect(() => {
    // Read both so the effect re-runs when either changes.
    const state = JSON.stringify(session.state);
    const layout = session.layout;
    if (!browser || !restored || !state || !layout) {
      return;
    }
    session.persist(authManager.authenticated ? authManager.user.id : undefined);
    if (syncUrl) {
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

  const bulk = new BulkController({
    dispatch,
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
          .map(toBulk),
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

  const runDispatch = (id: BulkActionId, payload?: BulkPayload) => {
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
   * existing bulk actions keep acting on the same items. Assets that are not loaded cannot be
   * mirrored, so a "select everything matching" selection still has to be resolved by its owner.
   */
  $effect(() => {
    const ids = new Set(session.selection);
    if (!multiSelect) {
      return;
    }
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
      case 'group-days':
      case 'group-months':
      case 'group-years': {
        // Grouping is page state: it travels in a link, survives a layout switch and is what the
        // query bridge reads. The timeline itself always draws day groups inside month buckets,
        // which is what the manager loads; coarser groupings need bucket support it does not have.
        event.preventDefault();
        session.patchView({ grouping: shortcut.id.replace('group-', '') as LibraryGrouping });
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

<div class="frameleaf fl-library" data-testid="frameleaf-library" data-layout={session.layout}>
  {@render shell?.()}

  <div class="fl-library-body" class:has-panel={showInfoPanel}>
    <div class="fl-library-main">
      <LibraryTimeline
        timelineManager={manager}
        {session}
        {ratingFor}
        captionFor={session.layout === 'work' ? captionFor : undefined}
        showDayHeaders={session.layout !== 'browse'}
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
          {@render children?.()}
          <ResultsToolbar {session} {onOpenFilterPanel}>
            {@render toolbar?.()}
            {#if session.selection.length >= 2 && !snapshot && !selectionMode}
              <Button onclick={() => session.patchView({ view: 'compare' })}>{$t('frameleaf_compare_title')}</Button>
            {/if}
          </ResultsToolbar>
        {/snippet}
      </LibraryTimeline>

      <ShowMore {session} {onShowMore} {loading} />

      {#if comparing}
        <div class="fl-library-compare">
          <LibraryCompare selection={session.selection} onDone={() => session.patchView({ view: 'grid' })} />
        </div>
      {/if}
    </div>

    {#if showInfoPanel}
      <aside class="fl-library-panel">{@render infoPanel?.()}</aside>
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
      />
    {/if}
  {/if}
  <!-- The viewer decides for itself when it is open; it is the owner of that surface (FL-35). -->
  {@render viewer?.()}
</div>

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
