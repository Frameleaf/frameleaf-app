<script lang="ts">
  import { goto, invalidate, onNavigate } from '$app/navigation';
  import { navigating } from '$app/state';
  import { scrollMemoryClearer } from '$lib/actions/scroll-memory';
  import ActivityPanel from '$lib/components/frameleaf/ActivityPanel.svelte';
  import AlbumHeader from '$lib/components/frameleaf/AlbumHeader.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import SpaceMediaComments from '$lib/components/frameleaf/SpaceMediaComments.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import HeaderActionButton from '$lib/components/HeaderActionButton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AlbumPageViewMode } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { canEdit } from '$lib/frameleaf/album-directory';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession, LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { AssetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getAlbumAssetsActions, handleDeleteAlbum } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
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
   * The album, collection and shared space detail page (FL-53, FL-33 cleanup).
   *
   * The Frameleaf header replaces the legacy album title, description, summary and app-bar
   * controls outright. An album's photos are the Frameleaf library scoped to the album
   * (`LibraryView`); a collection's photos are the union of its albums, read through the existing
   * metadata search and drawn in the flat Frameleaf grid (`ResultsView`). Both mount FL-32's
   * selection bar over the same library session, so a bulk action here behaves as it does
   * everywhere else. Adding photos is a picking step over its own session, so the album's own
   * selection is untouched while it runs.
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
  let viewerInvisible = $state(false);
  let activityOpen = $state(false);
  let tagOptions = $state<{ id: string; name: string }[]>([]);

  const timelineMultiSelectManager = new AssetMultiSelectManager();
  /** The "add photos" step picks over its own session, so the album's selection survives it. */
  const addAssetsSession = new LibrarySessionStore();

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
  // FL-55: a shared space has one comment system, the threaded one, here as on the space's own page.
  const isSpace = $derived(album.kind === AlbumKind.Space);
  // FL-45: the kind-aware fallback only matters if `album.albumName` itself sanitizes away.
  const albumDownloadFileName = $derived(
    namedArchiveName(
      album.albumName,
      $t(isCollection ? 'frameleaf_album_kind_collection' : 'frameleaf_album_kind_album'),
    ),
  );
  // A shared space's photos are one of its panels, so leaving them goes back to the space's own page.
  const backRoute = $derived(album.kind === AlbumKind.Space ? Route.viewSharedSpace({ id: album.id }) : Route.albums());
  const showAlbumUsers = $derived(timelineManager?.showAssetOwners ?? false);
  const containsEditors = $derived(album.shared && album.albumUsers.some(({ role }) => role === AlbumUserRole.Editor));
  const isShared = $derived(viewMode === AlbumPageViewMode.SELECT_ASSETS ? false : album.albumUsers.length > 1);

  /* ------------------------------------------------------------------ */
  /* Tree-derived context: breadcrumb, album strip, collection choices   */
  /* ------------------------------------------------------------------ */
  const node = $derived(tree.collections.find(({ collection }) => collection.id === album.id));
  const childAlbums = $derived(node?.albums ?? []);
  const parent = $derived(
    album.parentId
      ? tree.collections.find(({ collection }) => collection.id === album.parentId)?.collection
      : undefined,
  );
  const editableCollections = $derived(
    tree.collections.map(({ collection }) => collection).filter((collection) => canEdit(collection, currentUserId)),
  );

  /* ------------------------------------------------------------------ */
  /* Collection photos: the union of its albums                          */
  /* ------------------------------------------------------------------ */
  const COLLECTION_PAGE = 250;
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

  const assetCount = $derived(isCollection ? (node?.assetCount ?? collectionAssets.length) : album.assetCount);

  /* ------------------------------------------------------------------ */
  /* Library session and bulk actions                                    */
  /* ------------------------------------------------------------------ */

  /**
   * A bulk action that removed assets reports them here, so the collection's own list and the
   * album counts drop the same ids instead of each discovering the change on its own. The library
   * view and the results view already drop them from the grid and the selection.
   */
  const handleMutated = (removedIds: string[]) => {
    const removed = new Set(removedIds);
    collectionAssets = collectionAssets.filter(({ id }) => !removed.has(id));
    handlePromiseError(refreshAlbum());
  };

  // The album is the scope of everything the bar does here.
  $effect(() => {
    const scope = { kind: album.kind === AlbumKind.Space ? ('space' as const) : ('album' as const), id: albumId };
    if (librarySession.state.scope.kind !== scope.kind || librarySession.state.scope.id !== scope.id) {
      librarySession.setScope(scope);
    }
  });

  $effect(() => {
    void getAllTags()
      .then((tags: TagResponseDto[]) => (tagOptions = tags.map(({ id, value }) => ({ id, name: value }))))
      .catch(() => {
        // Tagging simply offers no existing tags if they cannot be read.
      });
  });

  /**
   * A viewer of a shared space contributes nothing to it, so their "select everything matching" set
   * offers only the two actions their role always permits — download and add to an album of their
   * own — instead of the album-level actions an editor or owner has (FL-48 map/space follow-ups).
   * `canEdit` is the same owner-or-editor check `shared-space.ts`'s `canContribute` makes; this page
   * already imports it for the collection tree above, so the space case reuses it rather than adding
   * a second role check.
   */
  const isSpaceViewer = $derived(isSpace && !canEdit(album, currentUserId));

  /**
   * A collection holds albums, not items: "remove from album" and "set as cover" belong to the
   * album an item actually lives in, so the album-scoped bulk actions are offered on an album
   * or a shared space only. A collection's cover is set from the header instead.
   */
  const bulkContext = $derived({
    albumId: isCollection ? null : albumId,
    ...(isSpaceViewer && { spaceViewerMatching: true }),
  });

  const collectionTimelineAssets = $derived(collectionAssets.map((asset) => toTimelineAsset(asset)));

  const selectEverythingInCollection = () => librarySession.selectAll(collectionAssets.map((asset) => asset.id));

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
    addAssetsSession.clearSelection();
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
    if (librarySession.selection.length > 0) {
      librarySession.clearSelection();
      return;
    }
    await goto(backRoute);
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

  // A like on the space itself; the space's comment panel offers it beside the conversation.
  const toggleSpaceLike = async () => {
    try {
      await activityManager.toggleLike();
    } catch (error) {
      handleError(error, $t('errors.cant_change_asset_favorite'));
    }
  };

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
    addAssetsSession.clearSelection();
    timelineMultiSelectManager.clear();
    await setModeToView();
  };

  const onAlbumShare = async () => {
    await refreshEverything();
    await setModeToView();
  };

  const onAlbumUserUpdate = ({
    albumId: id,
    userId,
    role,
  }: {
    albumId: string;
    userId: string;
    role: AlbumUserRole;
  }) => {
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
          <div class="h-full overflow-y-auto">
            <section class="pt-8 md:pt-24">{@render header()}</section>
            <ResultsView
              assets={collectionTimelineAssets}
              {bulkContext}
              downloadFileName={albumDownloadFileName}
              {tagOptions}
              onEndReached={loadMoreCollectionAssets}
              onRemoved={handleMutated}
              onSelectAll={selectEverythingInCollection}
              onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
            />
          </div>
        </Theme>
      {:else if viewMode === AlbumPageViewMode.SELECT_ASSETS}
        <!-- Adding photos is a picking step: its own session, its own manager, no bulk bar. -->
        <LibraryView
          session={addAssetsSession}
          multiSelect={timelineMultiSelectManager}
          bind:timelineManager
          {options}
          destination={{ kind: 'library' }}
          selectionMode
          noSelectionBar
          syncUrl={false}
        />
      {:else}
        <LibraryView
          enableRouting
          syncUrl={false}
          selectAll={isSpace ? 'matching' : 'loaded'}
          bind:timelineManager
          {options}
          destination={{ kind: 'album', id: albumId }}
          {bulkContext}
          downloadFileName={albumDownloadFileName}
          {tagOptions}
          onMutated={handleMutated}
          onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
        >
          <Theme theme={appTheme}>
            <section class="pt-8 md:pt-24">{@render header()}</section>
          </Theme>

          {#snippet viewer()}
            <Portal target="body">
              {#if assetViewerManager.isViewing}
                <TimelineAssetViewer
                  bind:invisible={viewerInvisible}
                  {timelineManager}
                  {album}
                  {isShared}
                  withStacked
                  activityPanel={isSpace ? spaceAssetComments : undefined}
                />
              {/if}
            </Portal>
          {/snippet}
        </LibraryView>
      {/if}
    </main>

    {#if viewMode === AlbumPageViewMode.VIEW}
      <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(backRoute)}>
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
      {#if isSpace}
        <!-- FL-55: the conversation on the space itself, threaded, with the space's own like. -->
        <div class="h-full w-[min(22rem,100vw)] border-s border-(--fl-border)">
          <SpaceMediaComments
            spaceId={album.id}
            canComment={album.isActivityEnabled}
            likes={{ count: activityManager.likeCount, liked: !!activityManager.isLiked, onToggle: toggleSpaceLike }}
            onClose={() => (activityOpen = false)}
          />
        </div>
      {:else}
        <ActivityPanel {album} onClose={() => (activityOpen = false)} />
      {/if}
    </Theme>
  {/if}
</div>

{#snippet spaceAssetComments(asset: AssetResponseDto)}
  <!-- FL-55: an item in a shared space is discussed in the space's threaded comments, not the album activity. -->
  <div class="h-full *:h-full">
    <Theme theme={appTheme}>
      <SpaceMediaComments
        spaceId={album.id}
        assetId={asset.id}
        canComment={album.isActivityEnabled}
        onClose={() => assetViewerManager.closeActivityPanel()}
      />
    </Theme>
  </div>
{/snippet}
