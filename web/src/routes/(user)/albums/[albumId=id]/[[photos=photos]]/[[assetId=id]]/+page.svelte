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
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { canEdit, isOwner, removalOutcome } from '$lib/frameleaf/album-directory';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getAlbumAssetsActions, handleDeleteAlbum, leftLocally } from '$lib/services/album.service';
  import { getGlobalActions } from '$lib/services/app.service';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { isAlbumsRoute, navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AlbumKind,
    AlbumUserRole,
    getAllTags,
    getAlbumInfo,
    searchAssets,
    type AlbumResponseDto,
    type AssetResponseDto,
    type TagResponseDto,
  } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
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
   * everywhere else. "Add photos → Select from library" goes to the Library, where the selection
   * bar's "Add to album" does the adding (prototype App.jsx `onAddPhotos`).
   */
  interface Props {
    data: PageData;
  }

  let { data = $bindable() }: Props = $props();
  let { slideshowState, slideshowNavigation } = slideshowStore;

  let album = $state(data.album);
  const tree = $derived(data.tree);
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  let activityOpen = $state(false);
  let tagOptions = $state<{ id: string; name: string }[]>([]);

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
  const isShared = $derived(album.albumUsers.length > 1);

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
  /**
   * FL-53: removing items from the album and choosing its cover are the owner's and an editor's,
   * so a viewer's selection bar does not offer them (the server refuses them too). The flag follows
   * a role change made while the page is open.
   */
  const canChangeAlbum = $derived(canEdit(album, currentUserId));
  const bulkContext = $derived({
    albumId: isCollection || !canChangeAlbum ? null : albumId,
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
    await timelineManager?.refresh();
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

  /**
   * The prototype's "Select from library" (App.jsx `onAddPhotos`): the Library is where photos are
   * picked, and its selection bar's "Add to album" adds them, so the album keeps no picking mode.
   */
  const addPhotosFromLibrary = async () => {
    await goto(Route.photos());
    toastManager.primary($t('frameleaf_album_add_photos_hint'));
  };

  const handleEscape = async () => {
    if (timelineManager) {
      timelineManager.suspendTransitions = true;
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
      await handleDeleteAlbum(album, { notify: false });
    }
  });

  const options = $derived({ albumId, order: album.order });

  $effect(() => {
    if (!album.isActivityEnabled && activityManager.commentCount === 0) {
      activityOpen = false;
    }
  });

  // Activity is offered on every album, shared or not, as in the design (CollectionHeader.jsx:1290-1297).
  $effect(() => {
    if (assetViewerManager.isViewing) {
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
  };

  const onAlbumAddAssets = async ({ albumIds }: { albumIds: string[] }) => {
    if (!albumIds.includes(albumId)) {
      return;
    }
    await refreshAlbum();
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

  /**
   * Somebody left or was taken out of this album (FL-53). When it is the person looking at it —
   * removed by the owner in another window, or leaving from another tab — the page can no longer
   * read the album, so it says so and goes back instead of failing on a refresh.
   */
  const onAlbumUserDelete = async (removal: { albumId: string; userId: string }) => {
    const outcome = removalOutcome(removal, {
      albumId,
      userId: currentUserId,
      isOwner: isOwner(album, currentUserId),
      leftLocally: leftLocally(removal.albumId),
    });
    if (outcome === 'exit') {
      activityOpen = false;
      toastManager.primary($t('frameleaf_album_access_removed', { values: { name: album.albumName } }));
      await goto(album.kind === AlbumKind.Space ? Route.sharing() : Route.albums());
    } else if (outcome === 'refresh') {
      await refreshEverything();
    }
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
  const { Upload } = $derived(getAlbumAssetsActions($t, album));

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
  onAlbumShare={refreshEverything}
  {onAlbumUserUpdate}
  {onAlbumUserDelete}
  {onAlbumUpdate}
/>
<CommandPaletteDefaultProvider name={$t('album')} actions={[Upload, Cast, Close]} />

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
    onAddPhotos={() => handlePromiseError(addPhotosFromLibrary())}
    onSlideshow={() => handlePromiseError(handleStartSlideshow())}
    onToggleActivity={() => (activityOpen = !activityOpen)}
    onToggleOwnerBadges={() => timelineManager?.toggleShowAssetOwners()}
  />
{/snippet}

<!--
  The album page sits in the Frameleaf shell (top bar and library rail) like every other library
  screen; the legacy ControlAppBar is gone (AL-17). The breadcrumb in the header, Escape and the
  command palette's Go back lead out of it.
-->
<UserPageLayout scrollbar={false}>
  <div class="flex h-full overflow-hidden" use:scrollMemoryClearer={{ routeStartsWith: Route.albums() }}>
    <div class="relative w-full shrink">
      <div class="relative h-full overflow-hidden md:px-4">
        {#if isCollection}
          <Theme theme={appTheme}>
            <div class="h-full overflow-y-auto">
              <section class="pt-2">{@render header()}</section>
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
        {:else}
          <LibraryView
            enableRouting
            selectAll={isSpace ? 'matching' : 'loaded'}
            bind:timelineManager
            {options}
            destination={{ kind: 'album', id: albumId }}
            headerHasSlideshow
            {bulkContext}
            downloadFileName={albumDownloadFileName}
            {tagOptions}
            onMutated={handleMutated}
            sidePanelOpen={activityOpen}
            onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
          >
            <Theme theme={appTheme}>
              <section class="pt-2">{@render header()}</section>
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
      </div>
    </div>

    {#if activityOpen && authManager.authenticated && !assetViewerManager.isViewing}
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
</UserPageLayout>

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
