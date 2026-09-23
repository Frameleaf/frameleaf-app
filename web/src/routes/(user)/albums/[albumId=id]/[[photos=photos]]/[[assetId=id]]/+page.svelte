<script lang="ts">
  import { goto, invalidate, onNavigate } from '$app/navigation';
  import { navigating } from '$app/state';
  import { scrollMemoryClearer } from '$lib/actions/scroll-memory';
  import ActivityPanel from '$lib/components/frameleaf/ActivityPanel.svelte';
  import AlbumHeader from '$lib/components/frameleaf/AlbumHeader.svelte';
  import SelectionBar from '$lib/components/frameleaf/SelectionBar.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import HeaderActionButton from '$lib/components/HeaderActionButton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import GalleryViewer from '$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { AlbumPageViewMode } from '$lib/constants';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { type BulkActionId, type BulkAsset } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { canEdit } from '$lib/frameleaf/album-directory';
  import {
    createLibrarySession,
    reduceLibrarySession,
    type LibrarySession,
    type LibrarySessionAction,
  } from '$lib/frameleaf/library-session';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { assetMultiSelectManager, AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { TimelineAsset, Viewport } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { getAlbumAssetsActions, handleDeleteAlbum } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { selectAllAssets } from '$lib/utils/asset-utils';
  import { isAlbumsRoute, navigate, type AssetGridRouteSearchParams } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AlbumKind,
    AlbumUserRole,
    AssetVisibility,
    getAllTags,
    getAlbumInfo,
    searchAssets,
    type AlbumResponseDto,
    type AssetResponseDto,
    type TagResponseDto,
  } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiArrowLeft } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * The album, collection and shared space detail page (FL-53).
   *
   * The Frameleaf header replaces the legacy album title, description, summary and app-bar
   * controls outright; the floating Frameleaf selection bar replaces the legacy select bar
   * on this route, bound to the shared library session so a bulk action here behaves as it
   * does everywhere else. A collection shows its albums as a strip above its photos, and its
   * photos are the union of those albums, read through the existing metadata search.
   */
  interface Props {
    data: PageData;
  }

  let { data = $bindable() }: Props = $props();
  let { slideshowState, slideshowNavigation } = slideshowStore;

  let album = $state(data.album);
  const tree = $derived(data.tree);
  let oldAt: AssetGridRouteSearchParams | null | undefined = $state();
  let viewMode: AlbumPageViewMode = $state(AlbumPageViewMode.VIEW);
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let activityOpen = $state(false);
  let tagOptions = $state<{ id: string; name: string }[]>([]);

  const timelineMultiSelectManager = new AssetMultiSelectManager();

  // The page keeps its own copy so an inline edit renders what the server returned without
  // waiting for a loader re-run; navigating to a different album replaces it outright.
  $effect(() => {
    if (data.album.id !== album.id) {
      album = data.album;
    }
  });

  const currentUserId = $derived(authManager.user.id);
  const albumId = $derived(album.id);
  const isCollection = $derived(album.kind === AlbumKind.Collection);
  const showAlbumUsers = $derived(timelineManager?.showAssetOwners ?? false);
  const containsEditors = $derived(album.shared && album.albumUsers.some(({ role }) => role === AlbumUserRole.Editor));
  const albumUsers = $derived(showAlbumUsers && containsEditors ? album.albumUsers.map(({ user }) => user) : []);
  const isShared = $derived(viewMode === AlbumPageViewMode.SELECT_ASSETS ? false : album.albumUsers.length > 1);

  /* ------------------------------------------------------------------ */
  /* Tree-derived context: breadcrumb, album strip, collection choices   */
  /* ------------------------------------------------------------------ */
  const node = $derived(tree.collections.find(({ collection }) => collection.id === album.id));
  const childAlbums = $derived(node?.albums ?? []);
  const parent = $derived(
    album.parentId ? tree.collections.find(({ collection }) => collection.id === album.parentId)?.collection : undefined,
  );
  const editableCollections = $derived(
    tree.collections.map(({ collection }) => collection).filter((collection) => canEdit(collection, currentUserId)),
  );
  const albumOptions = $derived(
    [
      ...tree.albums,
      ...tree.collections.flatMap(({ albums }) => albums),
      ...tree.spaces,
    ]
      .filter((entry) => canEdit(entry, currentUserId))
      .map((entry) => ({ id: entry.id, name: entry.albumName || $t('unnamed_album'), count: entry.assetCount })),
  );

  /* ------------------------------------------------------------------ */
  /* Collection photos: the union of its albums                          */
  /* ------------------------------------------------------------------ */
  const COLLECTION_PAGE = 250;
  const viewport: Viewport = $state({ width: 0, height: 0 });
  let collectionAssets = $state<AssetResponseDto[]>([]);
  let collectionPage = $state(1);
  let collectionLoading = $state(false);
  let collectionExhausted = $state(false);

  const loadCollectionAssets = async (page: number) => {
    const ids = childAlbums.map(({ id }) => id);
    if (ids.length === 0) {
      collectionAssets = [];
      collectionExhausted = true;
      return;
    }
    collectionLoading = true;
    try {
      const results = await searchAssets({
        metadataSearchDto: { albumIds: ids, page, size: COLLECTION_PAGE, order: album.order },
      });
      collectionAssets = page === 1 ? results.assets.items : [...collectionAssets, ...results.assets.items];
      collectionExhausted = results.assets.nextPage === null;
    } finally {
      collectionLoading = false;
    }
  };

  $effect(() => {
    if (!isCollection) {
      return;
    }
    // Re-runs when the collection's albums change, which is what its photos are made of.
    void childAlbums.map(({ id }) => id).join(',');
    collectionPage = 1;
    void loadCollectionAssets(1);
  });

  const loadMoreCollectionAssets = () => {
    if (collectionLoading || collectionExhausted) {
      return;
    }
    collectionPage += 1;
    void loadCollectionAssets(collectionPage);
  };

  const assetCount = $derived(isCollection ? node?.assetCount ?? collectionAssets.length : album.assetCount);

  /* ------------------------------------------------------------------ */
  /* Library session and bulk actions                                    */
  /* ------------------------------------------------------------------ */
  let session = $state<LibrarySession>(createLibrarySession());

  /**
   * The one place a session action is applied on this route. A bulk action that removed
   * assets reports them here, so the grid, the selection and the album counts all drop the
   * same ids instead of each discovering the change on its own.
   */
  const dispatch = (action: LibrarySessionAction) => {
    session = reduceLibrarySession(session, action);
    if (action.type === 'mutated' && action.removedIds.length > 0) {
      timelineManager?.removeAssets(action.removedIds);
      const removed = new Set(action.removedIds);
      for (const id of action.removedIds) {
        assetMultiSelectManager.removeAssetFromMultiselectGroup(id);
      }
      collectionAssets = collectionAssets.filter(({ id }) => !removed.has(id));
      handlePromiseError(refreshAlbum());
    }
  };

  const bulk = new BulkController({
    dispatch,
    context: () => ({
      currentUserId,
      ownerById: Object.fromEntries(assetMultiSelectManager.assets.map((asset) => [asset.id, asset.ownerId])),
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
    stackId: asset.stack?.id ?? null,
  });

  const selectedBulkAssets = $derived(assetMultiSelectManager.assets.map((asset) => toBulk(asset)));

  // The album is the scope of everything the bar does here.
  $effect(() => {
    const scope = { kind: album.kind === AlbumKind.Space ? ('space' as const) : ('album' as const), id: albumId };
    if (session.state.scope.kind !== scope.kind || session.state.scope.id !== scope.id) {
      dispatch({ type: 'scope', scope });
    }
  });

  // The grid owns the selection; the session mirrors it so the bar and the bulk coordinator
  // see exactly what is selected without a second source of truth.
  $effect(() => {
    const ids = assetMultiSelectManager.assets.map(({ id }) => id);
    const unchanged = ids.length === session.selection.length && ids.every((id, index) => session.selection[index] === id);
    if (!unchanged) {
      dispatch({ type: 'selection', ids });
    }
  });

  $effect(() => {
    void getAllTags()
      .then((tags: TagResponseDto[]) => (tagOptions = tags.map(({ id, value }) => ({ id, name: value }))))
      .catch(() => {
        // Tagging simply offers no existing tags if they cannot be read.
      });
  });

  const runBulk = (action: BulkActionId, payload?: BulkPayload) => {
    handlePromiseError(bulk.run(action, session.selection, payload));
  };

  const selectEverything = () => {
    if (isCollection) {
      assetMultiSelectManager.selectAssets(collectionAssets.map((asset) => toTimelineAsset(asset)));
      return;
    }
    handlePromiseError(selectAllAssets(timelineManager, assetMultiSelectManager));
  };

  /* ------------------------------------------------------------------ */
  /* Album lifecycle                                                     */
  /* ------------------------------------------------------------------ */
  const refreshAlbum = async () => {
    album = await getAlbumInfo({ id: albumId });
  };

  const refreshEverything = async () => {
    await refreshAlbum();
    await invalidate('album:data');
  };

  const handleStartSlideshow = async () => {
    const asset =
      $slideshowNavigation === SlideshowNavigation.Shuffle
        ? await timelineManager?.getRandomAsset()
        : timelineManager?.months[0]?.timelineDays[0]?.viewerAssets[0]?.asset;
    const first = asset ?? (collectionAssets[0] ? toTimelineAsset(collectionAssets[0]) : undefined);
    if (first) {
      handlePromiseError(
        assetViewerManager.setAssetId(first.id).then(() => ($slideshowState = SlideshowState.PlaySlideshow)),
      );
    }
  };

  const setModeToView = async () => {
    if (timelineManager) {
      timelineManager.suspendTransitions = true;
    }
    viewMode = AlbumPageViewMode.VIEW;
    await navigate(
      { targetRoute: 'current', assetId: null, assetGridRouteSearchParams: { at: oldAt?.at } },
      { replaceState: true, forceNavigate: true },
    );
    oldAt = null;
  };

  const handleCloseSelectAssets = async () => {
    timelineMultiSelectManager.clear();
    await setModeToView();
  };

  const startSelectAssets = async () => {
    if (timelineManager) {
      timelineManager.suspendTransitions = true;
    }
    viewMode = AlbumPageViewMode.SELECT_ASSETS;
    oldAt = { at: assetViewerManager.gridScrollTarget?.at };
    await navigate(
      { targetRoute: 'current', assetId: null, assetGridRouteSearchParams: { at: null } },
      { replaceState: true },
    );
  };

  const handleEscape = async () => {
    if (timelineManager) {
      timelineManager.suspendTransitions = true;
    }
    if (viewMode === AlbumPageViewMode.SELECT_ASSETS) {
      await handleCloseSelectAssets();
      return;
    }
    if (assetViewerManager.isViewing) {
      return;
    }
    if (assetMultiSelectManager.selectionActive) {
      assetMultiSelectManager.clear();
      return;
    }
    await goto(Route.albums());
  };

  const handleRemoveAssets = async (assetIds: string[]) => {
    timelineManager?.removeAssets(assetIds);
    await refreshAlbum();
  };

  const onAlbumRemoveAssets = async ({ assetIds, albumIds }: { assetIds: string[]; albumIds: string[] }) => {
    if (albumIds.includes(albumId)) {
      await handleRemoveAssets(assetIds);
    }
  };

  onNavigate(async ({ to }) => {
    if (!isAlbumsRoute(to?.route.id) && album.assetCount === 0 && !album.albumName) {
      await handleDeleteAlbum(album, { notify: false, prompt: false });
    }
  });

  const options = $derived.by(() => {
    if (viewMode === AlbumPageViewMode.SELECT_ASSETS) {
      return {
        visibility: AssetVisibility.Timeline,
        withPartners: true,
        timelineAlbumId: albumId,
      };
    }
    return { albumId, order: album.order };
  });

  $effect(() => {
    if (!album.isActivityEnabled && activityManager.commentCount === 0) {
      activityOpen = false;
    }
  });

  $effect(() => {
    if (assetViewerManager.isViewing || !isShared) {
      return;
    }
    handlePromiseError(activityManager.init(albumId));
  });

  onDestroy(() => activityManager.reset());

  const onAlbumDelete = async ({ id }: AlbumResponseDto) => {
    if (id !== albumId) {
      return;
    }
    await goto(Route.albums());
    viewMode = AlbumPageViewMode.VIEW;
  };

  const onAlbumAddAssets = async ({ albumIds }: { albumIds: string[] }) => {
    if (!albumIds.includes(albumId)) {
      return;
    }
    await refreshAlbum();
    timelineMultiSelectManager.clear();
    await setModeToView();
  };

  const onAlbumShare = async () => {
    await refreshEverything();
    await setModeToView();
  };

  const onAlbumUserUpdate = ({ albumId: id, userId, role }: { albumId: string; userId: string; role: AlbumUserRole }) => {
    if (id !== albumId) {
      return;
    }
    album = {
      ...album,
      albumUsers: album.albumUsers.map((albumUser) =>
        albumUser.user.id === userId ? { ...albumUser, role } : albumUser,
      ),
    };
  };

  const onAlbumUpdate = async (newAlbum: AlbumResponseDto) => {
    if (newAlbum.id === albumId) {
      album = newAlbum;
    }

    // invalidating during navigation causes an infinite page load
    await navigating.complete;
    await invalidate('album:data');
  };

  const { Cast } = $derived(getGlobalActions($t));
  const { AddAssets, Upload } = $derived(getAlbumAssetsActions($t, album, timelineMultiSelectManager.assets));

  const Close = $derived({
    title: $t('go_back'),
    icon: mdiArrowLeft,
    onAction: handleEscape,
    $if: () => !assetViewerManager.isViewing,
    shortcuts: { key: 'Escape' },
  });

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<OnEvents
  onSharedLinkCreate={refreshAlbum}
  onSharedLinkDelete={refreshAlbum}
  {onAlbumDelete}
  {onAlbumAddAssets}
  {onAlbumRemoveAssets}
  {onAlbumShare}
  {onAlbumUserUpdate}
  onAlbumUserDelete={refreshEverything}
  {onAlbumUpdate}
/>
<CommandPaletteDefaultProvider name={$t('album')} actions={[AddAssets, Upload, Close]} />

{#snippet header()}
  <AlbumHeader
    {album}
    {childAlbums}
    {parent}
    collections={editableCollections}
    likeCount={activityManager.likeCount}
    commentCount={activityManager.commentCount}
    {activityOpen}
    canShowOwnerBadges={containsEditors}
    ownerBadges={showAlbumUsers}
    {assetCount}
    onAlbumChange={(next) => (album = next)}
    onRefresh={refreshEverything}
    onAddPhotos={() => handlePromiseError(startSelectAssets())}
    onSlideshow={() => handlePromiseError(handleStartSlideshow())}
    onToggleActivity={() => (activityOpen = !activityOpen)}
    onToggleOwnerBadges={() => timelineManager?.toggleShowAssetOwners()}
  />
{/snippet}

<div class="flex overflow-hidden" use:scrollMemoryClearer={{ routeStartsWith: Route.albums() }}>
  <div class="relative w-full shrink">
    <main class="relative h-dvh overflow-hidden px-2 pt-(--navbar-height) max-md:pt-(--navbar-height-md) md:px-6">
      {#if isCollection}
        <Theme theme={appTheme}>
          <div
            class="h-full overflow-y-auto"
            bind:clientWidth={viewport.width}
            bind:clientHeight={viewport.height}
            onscrollend={loadMoreCollectionAssets}
          >
            <section class="pt-8 md:pt-24">{@render header()}</section>
            {#if collectionAssets.length > 0}
              <GalleryViewer
                bind:assets={collectionAssets}
                assetInteraction={assetMultiSelectManager}
                {viewport}
                onEndReached={loadMoreCollectionAssets}
                onReload={() => void loadCollectionAssets(1)}
              />
            {/if}
          </div>
        </Theme>
      {:else}
        <Timeline
          enableRouting={viewMode !== AlbumPageViewMode.SELECT_ASSETS}
          {album}
          {albumUsers}
          bind:timelineManager
          {options}
          assetInteraction={viewMode === AlbumPageViewMode.SELECT_ASSETS
            ? timelineMultiSelectManager
            : assetMultiSelectManager}
          {isShared}
          isSelectionMode={viewMode === AlbumPageViewMode.SELECT_ASSETS}
          singleSelect={false}
          showArchiveIcon={viewMode !== AlbumPageViewMode.SELECT_ASSETS}
          onEscape={handleEscape}
          withStacked={true}
        >
          {#if viewMode !== AlbumPageViewMode.SELECT_ASSETS}
            <Theme theme={appTheme}>
              <section class="pt-8 md:pt-24">{@render header()}</section>
            </Theme>
          {/if}
        </Timeline>
      {/if}
    </main>

    {#if viewMode === AlbumPageViewMode.VIEW}
      <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(Route.albums())}>
        {#snippet trailing()}
          <ActionButton action={Cast} />
        {/snippet}
      </ControlAppBar>
    {/if}

    {#if viewMode === AlbumPageViewMode.SELECT_ASSETS}
      <ControlAppBar onClose={handleCloseSelectAssets}>
        {#snippet leading()}
          <p class="text-lg dark:text-immich-dark-fg">
            {#if timelineMultiSelectManager.selectionActive}
              {$t('selected_count', { values: { count: timelineMultiSelectManager.assets.length } })}
            {:else}
              {$t('add_to_album')}
            {/if}
          </p>
        {/snippet}
        {#snippet trailing()}
          <HeaderActionButton action={Upload} />
          <HeaderActionButton action={AddAssets} />
        {/snippet}
      </ControlAppBar>
    {/if}
  </div>

  {#if activityOpen && isShared && authManager.authenticated && !assetViewerManager.isViewing}
    <Theme theme={appTheme}>
      <ActivityPanel {album} onClose={() => (activityOpen = false)} />
    </Theme>
  {/if}
</div>

{#if viewMode !== AlbumPageViewMode.SELECT_ASSETS}
  <Theme theme={appTheme}>
    <SelectionBar
      count={session.selection.length}
      total={assetCount}
      assets={selectedBulkAssets}
      context={{ albumId, currentUserId }}
      {tagOptions}
      {albumOptions}
      operations={session.operations}
      undoLabel={bulk.undo?.label}
      onAction={runBulk}
      onUndo={() => handlePromiseError(bulk.undo?.run() ?? Promise.resolve())}
      onClear={() => assetMultiSelectManager.clear()}
      onSelectAllMatching={selectEverything}
      onCancelOperation={(requestId) => bulk.cancel(requestId)}
      onRetryOperation={(operation) => handlePromiseError(bulk.retry(operation))}
      onDismissOperation={(requestId) => bulk.dismiss(requestId)}
    />
  </Theme>
{/if}
