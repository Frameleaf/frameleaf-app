<script lang="ts">
  /**
   * The flat-results counterpart of `LibraryView` (FL-33 cleanup).
   *
   * `LibraryView` binds the Frameleaf timeline, the results toolbar and the selection bar to one
   * library session. Search results, the Best Photos ranking and a collection's photos are a paged
   * list rather than a timeline, so this component does the same job for that shape: it owns the
   * session, mounts `AssetGrid`, and mounts FL-32's selection bar bound to one `BulkController`,
   * so a bulk action on a result page behaves exactly as it does in the library.
   *
   * Together they retire the legacy shared gallery grid and the legacy asset select bar.
   */
  import AssetGrid from '$lib/components/frameleaf/AssetGrid.svelte';
  import SelectionBar from '$lib/components/frameleaf/SelectionBar.svelte';
  import type { BulkActionContext, BulkActionId, BulkAsset } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { librarySession, type LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibrarySessionAction } from '$lib/frameleaf/library-session';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { CellGridOptions } from '$lib/frameleaf/library-grid';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { AssetVisibility } from '@immich/sdk';
  import type { Snippet } from 'svelte';

  type Props = {
    /** The results, in the order the page loaded them. */
    assets: TimelineAsset[];
    session?: LibrarySessionStore;
    /** Ask for the next page. */
    onEndReached?: () => void;
    /** Open an item. */
    onOpen?: (asset: TimelineAsset) => void;
    /** Drop assets a bulk action removed from this page's own list. */
    onRemoved?: (ids: string[]) => void;
    /** Select every result the page currently holds. Used by `selectAllMode: 'loaded'` (the default). */
    onSelectAll?: () => void;
    /**
     * What "select all" means here (FL-55 follow-up). `loaded` (default) calls `onSelectAll`, as
     * before: every page but a shared space's own timeline uses this, selecting only what has
     * paged in so far. `matching` is for a destination with a real structured scope the server can
     * resolve on its own, the same way `LibraryView`'s `selectAll="matching"` works for a space
     * viewed through the album route: it counts and selects a frozen snapshot of `session.state`
     * (`bulk.count` / `session.dispatch({ ..., allMatching: true })`), and a bulk action run while
     * that snapshot is active goes through `bulk.runMatching` instead of the explicit-ids `bulk.run`.
     */
    selectAllMode?: 'matching' | 'loaded';
    /** Album, shared-link and trash context for the bulk actions. */
    bulkContext?: Omit<BulkActionContext, 'assets' | 'count' | 'currentUserId' | 'snapshot'>;
    /**
     * Base name for a selection download's archive, e.g. the collection name. Falls back to the
     * generic default in `downloadArchive` when unset, matching the legacy per-route
     * `DownloadAction` filename.
     */
    downloadFileName?: string;
    tagOptions?: { id: string; name: string }[];
    /** Suppress the selection bar, for a page whose own chrome acts on the selection. */
    noSelectionBar?: boolean;
    selectionMode?: boolean;
    singleSelect?: boolean;
    onSelect?: (asset: TimelineAsset) => void;
    tileOverlay?: Snippet<[TimelineAsset]>;
    /** A fixed square cell grid with a caption under each tile (`AssetGrid`; the Folders files). */
    cellOptions?: CellGridOptions;
    caption?: Snippet<[TimelineAsset]>;
    offlineFor?: (asset: TimelineAsset) => boolean;
    /** Rendered above the grid. */
    header?: Snippet;
    empty?: Snippet;
  };

  let {
    assets,
    session = librarySession,
    onEndReached,
    onOpen,
    onRemoved,
    onSelectAll,
    selectAllMode = 'loaded',
    bulkContext,
    downloadFileName,
    tagOptions = [],
    noSelectionBar = false,
    selectionMode = false,
    singleSelect = false,
    onSelect,
    tileOverlay,
    cellOptions,
    caption,
    offlineFor,
    header,
    empty,
  }: Props = $props();

  const currentUserId = $derived(authManager.authenticated ? authManager.user.id : undefined);
  const byId = $derived(new Map(assets.map((asset) => [asset.id, asset])));

  /** The one place a session action is applied here, so the list and the session drop the same ids. */
  const dispatch = (action: LibrarySessionAction) => {
    if (action.type === 'mutated' && action.removedIds.length > 0) {
      onRemoved?.(action.removedIds);
    }
    session.dispatch(action);
  };

  // A durable job's finished items leave this list as the job finishes them, not all at once and
  // not on a reload (owner decision, September 22, 2026).
  $effect(() =>
    durableBulkTracker.onRemoved((removedIds) => {
      const shown = removedIds.filter((id) => byId.has(id));
      if (shown.length > 0) {
        dispatch({ type: 'mutated', removedIds: shown });
      }
    }),
  );

  const bulk = new BulkController({
    dispatch,
    context: () => ({
      currentUserId,
      ownerById: Object.fromEntries(
        session.selection.map((id) => [id, byId.get(id)?.ownerId]).filter(([, owner]) => !!owner) as [string, string][],
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

  const selectedAssets = $derived(
    session.selection
      .map((id) => byId.get(id))
      .filter((asset): asset is TimelineAsset => !!asset)
      .map((asset) => toBulk(asset)),
  );

  // A snapshot selection covers items that are not loaded, so the bar is told what it may offer.
  // Mirrors `LibraryView`'s `snapshot` — both read the same session-level `selectionSnapshot`.
  const snapshot = $derived(selectAllMode === 'matching' ? session.session.selectionSnapshot : undefined);

  const runBulk = (id: BulkActionId, payload?: BulkPayload) => {
    const withFileName =
      id === 'download' && downloadFileName && !payload?.fileName
        ? { ...payload, fileName: downloadFileName }
        : payload;
    if (snapshot) {
      // Frozen at submit: editing the query afterwards cannot change what the operation touches.
      void bulk.runMatching(id, snapshot, { payload: withFileName, submittedTotal: session.total });
      session.clearSelection();
      return;
    }
    void bulk.run(id, [...session.selection], withFileName);
  };

  /**
   * Count everything matching the session's current scope and query, then select a frozen
   * snapshot of it — mirrors `LibraryView`'s `selectAllMatching`. Only meaningful where the
   * session carries a query the server can resolve on its own (`selectAllMode: 'matching'`).
   */
  const selectAllMatching = async () => {
    const total = await bulk.count(session.state);
    session.dispatch({ type: 'selection', ids: assets.map((asset) => asset.id), allMatching: true });
    if (total !== null) {
      session.applyTotal(total, session.revision);
    }
  };

  /**
   * The session owns the selection; the multi-select manager is kept in step with it so anything
   * still reading that manager sees the same items. One selection, two readers.
   */
  $effect(() => {
    const ids = new Set(session.selection);
    for (const asset of assetMultiSelectManager.assets) {
      if (!ids.has(asset.id)) {
        assetMultiSelectManager.removeAssetFromMultiselectGroup(asset.id);
      }
    }
    for (const id of ids) {
      const asset = byId.get(id);
      if (asset && !assetMultiSelectManager.hasSelectedAsset(id)) {
        assetMultiSelectManager.selectAsset(asset);
      }
    }
  });
</script>

<div class="frameleaf fl-results" data-testid="frameleaf-results">
  <AssetGrid
    {assets}
    {session}
    {onEndReached}
    {onOpen}
    {selectionMode}
    {singleSelect}
    {onSelect}
    {tileOverlay}
    {cellOptions}
    {caption}
    {offlineFor}
    {header}
    {empty}
  />

  {#if !noSelectionBar}
    <SelectionBar
      count={session.selection.length}
      total={selectAllMode === 'matching' ? session.total : assets.length}
      assets={selectedAssets}
      context={{ ...bulkContext, currentUserId, snapshot: !!snapshot }}
      {tagOptions}
      operations={session.session.operations}
      undoLabel={bulk.undo?.label}
      onAction={runBulk}
      onUndo={() => void bulk.undo?.run()}
      onClear={() => session.clearSelection()}
      onSelectAllMatching={selectAllMode === 'matching' ? () => void selectAllMatching() : onSelectAll}
      onCancelOperation={(requestId) => bulk.cancel(requestId)}
      onRetryOperation={(operation) => void bulk.retry(operation)}
      onDismissOperation={(requestId) => bulk.dismiss(requestId)}
    />
  {/if}
</div>

<style>
  .fl-results {
    position: relative;
    width: 100%;
  }
</style>
