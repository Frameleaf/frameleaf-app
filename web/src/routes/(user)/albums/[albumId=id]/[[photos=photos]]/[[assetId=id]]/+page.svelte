<script lang="ts">
  import { browser } from '$app/env';
  import { afterNavigate, beforeNavigate, goto, invalidate, onNavigate } from '$app/navigation';
  import { navigating, page } from '$app/state';
  import { scrollMemoryClearer } from '$lib/actions/scroll-memory';
  import ActivityPanel from '$lib/components/frameleaf/ActivityPanel.svelte';
  import AlbumHeader from '$lib/components/frameleaf/AlbumHeader.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import LibraryItemsView from '$lib/components/frameleaf/LibraryItemsView.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import SpaceMediaComments from '$lib/components/frameleaf/SpaceMediaComments.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import {
    albumAncestors,
    directoryAlbums,
    moveTargets,
    canEdit,
    isOwner,
    removalOutcome,
  } from '$lib/frameleaf/album-directory';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { publishCollectionPage } from '$lib/frameleaf/collection-page-request';
  import { albumSearchContext } from '$lib/frameleaf/search-context';
  import { writeLibraryView, readLibraryView, createLibrarySession } from '$lib/frameleaf/library-session';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { HERO_PAGE_ATTRIBUTE, HERO_SHARED_ATTRIBUTE } from '$lib/frameleaf/motion';
  import { findTileImage } from '$lib/frameleaf/viewer-zoom';
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
    getAlbumItems,
    LibraryScope,
    LibraryViewScope,
    searchAssets,
    type AlbumResponseDto,
    type AssetResponseDto,
    type TagResponseDto,
  } from '@frameleaf/sdk';
  import { CommandPaletteDefaultProvider, Theme as AppTheme, themeManager, toastManager } from '@frameleaf/ui';
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

  /**
   * The album's cover on Albums travels to that photo in this grid, and back (BRAND.md "Hero",
   * `data-fl-shared`). The page has no cover of its own, so the photo's tile is the other end; it
   * belongs to the library grid, so it carries the mark only around a navigation between this
   * page and Albums. When the tile is not on screen the page crossfades.
   */
  const ALBUMS_ROUTE_ID = '/(user)/albums';
  const markCoverTile = () => {
    const image = album.albumThumbnailAssetId ? findTileImage(album.albumThumbnailAssetId) : null;
    image?.setAttribute(HERO_SHARED_ATTRIBUTE, `album:${album.id}`);
    image?.setAttribute(HERO_PAGE_ATTRIBUTE, '');
    return image;
  };
  const unmarkCoverTile = (image: HTMLElement | null) => {
    image?.removeAttribute(HERO_SHARED_ATTRIBUTE);
    image?.removeAttribute(HERO_PAGE_ATTRIBUTE);
  };
  beforeNavigate(({ to }) => {
    if (to?.route.id === ALBUMS_ROUTE_ID) {
      markCoverTile();
    }
  });
  afterNavigate(({ from }) => {
    if (from?.route.id !== ALBUMS_ROUTE_ID) {
      return;
    }
    const image = markCoverTile();
    // The root layout reads the mark in the same turn; a later press on the tile opens the viewer.
    setTimeout(() => unmarkCoverTile(image), 0);
  });

  // The page keeps its own copy so an inline edit renders what the server returned without
  // waiting for a loader re-run; navigating to a different album replaces it outright.
  $effect(() => {
    if (data.album.id !== album.id) {
      album = data.album;
    }
  });

  const currentUserId = $derived(authManager.user.id);
  const albumId = $derived(album.id);
  let alive = true;
  const albumView = $derived({ albumId, isCurrentSession: authManager.captureSession() });
  const isCurrentView = (view: typeof albumView) => alive && view === albumView && view.isCurrentSession();
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
  const allAlbums = $derived(directoryAlbums(tree));
  const childAlbums = $derived(allAlbums.filter(({ parentId }) => parentId === album.id));
  const ancestors = $derived(albumAncestors(tree, album));
  const parent = $derived(ancestors.at(-1));
  const editableCollections = $derived(moveTargets(tree, album, currentUserId).map(({ collection }) => collection));
  const collectionAlbums = $derived(
    allAlbums.filter(
      (candidate) => candidate.id === album.id || albumAncestors(tree, candidate).some(({ id }) => id === album.id),
    ),
  );
  const node = $derived({ assetCount: collectionAlbums.reduce((total, child) => total + child.assetCount, 0) });

  /* ------------------------------------------------------------------ */
  /* Collection photos: the union of its albums                          */
  /* ------------------------------------------------------------------ */
  const COLLECTION_PAGE = 250;
  let collectionAssets = $state<AssetResponseDto[]>([]);
  let collectionCursor: string | null = null;
  let collectionLoading = $state(false);
  let collectionExhausted = $state(false);
  let collectionRequest = 0;

  // The collection and every album inside it, at any depth. Flat `albumIds` would mean "in all of these".
  const loadCollectionAssets = async (
    cursor: string | null,
    request: number,
    collectionId: string,
    order: typeof album.order,
  ) => {
    collectionLoading = true;
    await publishCollectionPage(
      () =>
        searchAssets({
          metadataSearchDto: {
            filter: { albumSubtreeIds: { any: [collectionId] } },
            orderBy: { direction: order },
            size: COLLECTION_PAGE,
            ...(cursor && { cursor }),
          },
        }),
      () => request === collectionRequest && collectionId === albumId,
      (results) => {
        collectionAssets = cursor ? [...collectionAssets, ...results.assets.items] : results.assets.items;
        collectionCursor = results.assets.nextCursor;
        collectionExhausted = results.assets.nextCursor === null;
      },
      () => (collectionLoading = false),
    );
  };

  $effect(() => {
    // Re-runs when the collection's albums change, which is what its photos are made of.
    void collectionAlbums.length;
    const order = album.order;
    const collectionId = albumId;
    const request = ++collectionRequest;
    collectionAssets = [];
    collectionLoading = false;
    collectionCursor = null;
    collectionExhausted = !isCollection;
    if (isCollection) {
      handlePromiseError(loadCollectionAssets(null, request, collectionId, order));
    }
  });

  const loadMoreCollectionAssets = () => {
    if (collectionLoading || collectionExhausted || !collectionCursor) {
      return;
    }
    handlePromiseError(loadCollectionAssets(collectionCursor, collectionRequest, albumId, album.order));
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
    handlePromiseError(refreshAlbum().then(() => invalidate('album:data')));
  };

  const updateCollectionAsset = (updated: AssetResponseDto) => {
    collectionAssets = collectionAssets.map((asset) => (asset.id === updated.id ? updated : asset));
  };

  // The album is the scope of everything the bar does here.
  $effect(() => {
    const scope = { kind: album.kind === AlbumKind.Space ? ('space' as const) : ('album' as const), id: albumId };
    if (librarySession.state.scope.kind !== scope.kind || librarySession.state.scope.id !== scope.id) {
      librarySession.setScope(scope);
    }
  });

  // LibraryView restores ordinary albums. Collections use ResultsView, so restore their tab state
  // here; the album id and account keep another collection's tab state out of this one.
  let restoredCollection = $state('');
  $effect(() => {
    if (!isCollection) {
      restoredCollection = '';
      return;
    }
    if (!browser) {
      return;
    }
    const userId = authManager.authenticated && !authManager.isSharedLink ? currentUserId : undefined;
    const context = `collection:${albumId}`;
    const key = `${userId ?? ''}:${context}`;
    if (restoredCollection === key) {
      return;
    }
    librarySession.restore(undefined, userId, context);
    librarySession.setScope({ kind: 'album', id: albumId });
    restoredCollection = key;
  });

  $effect(() => {
    if (!browser || !isCollection || !restoredCollection) {
      return;
    }
    void librarySession.session;
    librarySession.persist(authManager.authenticated && !authManager.isSharedLink ? currentUserId : undefined);
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
  let albumRefreshRequest = 0;
  const refreshAlbum = async () => {
    const view = albumView;
    if (!isCurrentView(view)) {
      return;
    }
    const request = ++albumRefreshRequest;
    const requestedAlbum = album;
    const refreshedAlbum = await getAlbumInfo({ id: requestedAlbum.id });
    // Navigation or a newer server event already replaced this album snapshot.
    if (isCurrentView(view) && request === albumRefreshRequest && album === requestedAlbum) {
      album = refreshedAlbum;
    }
  };

  const refreshEverything = async (view = albumView) => {
    const manager = timelineManager;
    if (!isCurrentView(view)) {
      return;
    }
    await refreshAlbum();
    if (!isCurrentView(view) || manager !== timelineManager) {
      return;
    }
    await invalidate('album:data');
    if (isCurrentView(view) && manager === timelineManager) {
      await manager?.refresh();
    }
  };

  let slideshowRequest = 0;
  const handleStartSlideshow = async (view = albumView) => {
    const request = ++slideshowRequest;
    const manager = timelineManager;
    const isCurrent = () => isCurrentView(view) && request === slideshowRequest && manager === timelineManager;
    if (!isCurrent()) {
      return;
    }
    try {
      const asset =
        $slideshowNavigation === SlideshowNavigation.Shuffle
          ? await manager?.getRandomAsset()
          : manager?.months[0]?.timelineDays[0]?.viewerAssets[0]?.asset;
      if (!isCurrent()) {
        return;
      }
      const first = asset ?? (collectionAssets[0] ? toTimelineAsset(collectionAssets[0]) : undefined);
      if (first) {
        await assetViewerManager.setAssetId(first.id, {
          isCurrent,
          onSet: () => ($slideshowState = SlideshowState.PlaySlideshow),
        });
      }
    } catch (error) {
      if (isCurrent()) {
        throw error;
      }
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

  let bookmarkCount = $state(0);
  let itemsUnavailable = $state(false);
  let itemGeneration = $state(0);
  const mixedQuery = $derived(albumSearchContext(new URL(page.url.href), album));
  const designContext = $derived(mixedQuery.filter.libraryScope === LibraryViewScope.Design);
  const mixedAlbum = $derived(
    !isCollection &&
      (bookmarkCount > 0 || album.libraryScope === LibraryScope.Design || album.libraryScope === LibraryScope.Both),
  );
  $effect(() => {
    const id = albumId;
    const selected = album;
    const version = itemGeneration;
    const current = authManager.captureSession();
    const controller = new AbortController();
    bookmarkCount = 0;
    itemsUnavailable = false;
    if (!isCollection) {
      void getAlbumItems({ id, limit: 1 }, { signal: controller.signal })
        .then((result) => {
          if (
            !controller.signal.aborted &&
            current() &&
            albumId === id &&
            itemGeneration === version &&
            album === selected
          ) {
            bookmarkCount = result.bookmarkCount;
          }
        })
        .catch(() => {
          if (!controller.signal.aborted && current() && albumId === id && itemGeneration === version) {
            itemsUnavailable = true;
          }
        });
    }
    return () => controller.abort();
  });
  onDestroy(
    onLibraryAccessChange(() => {
      bookmarkCount = 0;
      itemGeneration++;
    }),
  );
  const updateMixedQuery = (query: import('$lib/components/discovery/query').DiscoveryQuery) => {
    const url = new URL(Route.viewAlbum({ id: albumId }), page.url.origin);
    const previous = readLibraryView(new URL(page.url.href)) ?? createLibrarySession().state;
    const next = writeLibraryView(url, { ...previous, scope: { kind: 'album', id: albumId }, query });
    void goto(next, { replace: true, reset: false });
  };

  /**
   * An album made with "Create album" and left without a name or anything in it is removed when
   * you leave for anywhere but another album, so abandoned drafts never pile up in Albums. Only your
   * own plain album qualifies: never a collection or space, nor one holding albums or saved links.
   */
  onNavigate(async ({ to }) => {
    if (
      !isAlbumsRoute(to?.route.id) &&
      album.kind === AlbumKind.Album &&
      album.assetCount === 0 &&
      !album.albumName &&
      bookmarkCount === 0 &&
      childAlbums.length === 0 &&
      isOwner(album, currentUserId)
    ) {
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

  onDestroy(() => {
    alive = false;
    collectionRequest++;
    activityManager.reset();
  });

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

  // Another member or device changed this album (its shared order, name, cover): show the server's copy.
  const onAlbumRemoteUpdate = ({ id }: { id: string }) => {
    if (id === albumId) {
      handlePromiseError(refreshAlbum());
    }
  };

  const { Cast } = $derived(getGlobalActions($t));
  const { Upload } = $derived(getAlbumAssetsActions($t, album, designContext ? LibraryScope.Design : undefined));

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
  onAlbumShare={() => refreshEverything()}
  {onAlbumUserUpdate}
  {onAlbumUserDelete}
  {onAlbumUpdate}
  {onAlbumRemoteUpdate}
/>
<CommandPaletteDefaultProvider name={$t('album')} actions={[Upload, Cast, Close]} />

{#snippet header()}
  {#key albumId}
    {@const view = albumView}
    <AlbumHeader
      {album}
      uploadScope={designContext ? LibraryScope.Design : undefined}
      {childAlbums}
      {parent}
      {ancestors}
      collections={editableCollections}
      albums={allAlbums}
      likeCount={activityManager.likeCount}
      commentCount={activityManager.commentCount}
      {activityOpen}
      canShowOwnerBadges={containsEditors}
      ownerBadges={showAlbumUsers}
      {assetCount}
      itemCount={assetCount + bookmarkCount}
      onAlbumChange={(next) => (album = next)}
      onRefresh={() => refreshEverything(view)}
      onAddPhotos={() => handlePromiseError(addPhotosFromLibrary())}
      onSlideshow={() => handlePromiseError(handleStartSlideshow(view))}
      onToggleActivity={() => (activityOpen = !activityOpen)}
      onToggleOwnerBadges={() => timelineManager?.toggleShowAssetOwners()}
    />
  {/key}
{/snippet}

<!--
  The album page sits in the Frameleaf shell (top bar and library rail) like every other library
  screen; the legacy ControlAppBar is gone (AL-17). The breadcrumb in the header, Escape and the
  command palette's Go back lead out of it. An album's LibraryView is the page area's own child, as on
  Photos, a person and a tag, so it carries the page gutter inside its scroller and the frosted
  toolbar band spans the page (LIB-P4). The comments sheet is fixed over the right edge (SHARING-P2).
-->
<UserPageLayout
  scrollbar={false}
  onUploadClick={() =>
    void openFileUploadDialog({ albumId, libraryScope: designContext ? LibraryScope.Design : undefined })}
  use={[[scrollMemoryClearer, { routeStartsWith: Route.albums() }]]}
>
  {#if itemsUnavailable}<InlineError
      compact
      message={$t('frameleaf_album_links_unavailable')}
      onRetry={() => itemGeneration++}
    />{/if}
  {#if isCollection}
    <div class="relative h-full overflow-hidden md:px-4">
      <Theme theme={appTheme}>
        <div class="h-full overflow-y-auto">
          <!-- On phones the header keeps the 16px gutter the library view gives an album's header. -->
          <section class="pt-2 max-md:px-2">{@render header()}</section>
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
    </div>
  {:else if mixedAlbum}
    {#key albumId}
      <LibraryItemsView
        title={album.albumName || $t('unnamed_album')}
        query={mixedQuery}
        {album}
        context={Route.viewAlbum({ id: albumId })}
        workspace={designContext ? 'design' : 'personal'}
        onQueryChange={updateMixedQuery}
        {header}
        {bulkContext}
      />
    {/key}
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

  {#if activityOpen && authManager.authenticated && !assetViewerManager.isViewing}
    <Theme theme={appTheme}>
      <div class="fl-album-activity">
        {#if isSpace}
          <!-- FL-55: the conversation on the space itself, threaded, with the space's own like. -->
          <div class="fl-album-activity-space h-full w-[min(22rem,100vw)] border-s border-(--fl-border)">
            <SpaceMediaComments
              spaceId={album.id}
              canComment={album.isActivityEnabled}
              likes={{
                count: activityManager.likeCount,
                liked: !!activityManager.isLiked,
                onToggle: toggleSpaceLike,
              }}
              onClose={() => (activityOpen = false)}
            />
          </div>
        {:else}
          <ActivityPanel {album} onClose={() => (activityOpen = false)} />
        {/if}
      </div>
    </Theme>
  {/if}
</UserPageLayout>

{#if isCollection}
  <ResultsAssetViewer
    assets={collectionAssets}
    emptyRoute={Route.viewAlbum({ id: albumId })}
    onAssetChange={updateCollectionAsset}
    onRemove={(id) => handleMutated([id])}
  />
{/if}

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

<style>
  /*
   * The prototype's .activity-panel (collections.css:1503, 1708-1716, 1823-1832). SHARING-P2: a
   * full-height side sheet over the right edge at every width above a phone, so opening it never
   * squeezes the grid or wraps the header's buttons; a sheet from the bottom on phones.
   */
  .fl-album-activity {
    position: fixed;
    inset-block: var(--fl-topbar-height) 0;
    inset-inline-end: 0;
    z-index: 40;
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }

  @media (max-width: 700px) {
    .fl-album-activity {
      inset-block-start: auto;
      inset-inline: 0;
      block-size: min(72dvh, 100dvh - var(--fl-topbar-height-phone));
      /* The tab bar floats over the foot of the page: the comment box ends above it. */
      padding-block-end: calc(var(--fl-tabbar-height, 0px) + var(--fl-space-2));
      overflow: hidden;
      border-block-start: 1px solid var(--fl-border);
      border-radius: var(--fl-radius-capsule) var(--fl-radius-capsule) 0 0;
    }

    .fl-album-activity :global(.activity),
    .fl-album-activity-space {
      inline-size: 100%;
      border-inline-start: 0;
    }
  }
</style>
