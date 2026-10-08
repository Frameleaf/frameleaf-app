<script lang="ts">
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumAvatarStack from '$lib/components/frameleaf/AlbumAvatarStack.svelte';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import AlbumInlineEdit from '$lib/components/frameleaf/AlbumInlineEdit.svelte';
  import IconChooser from '$lib/components/frameleaf/IconChooser.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import SharedSpaceActivity from '$lib/components/frameleaf/SharedSpaceActivity.svelte';
  import SharedSpaceAddMatching from '$lib/components/frameleaf/SharedSpaceAddMatching.svelte';
  import SharedSpaceLinkedAlbums from '$lib/components/frameleaf/SharedSpaceLinkedAlbums.svelte';
  import SharedSpaceMap from '$lib/components/frameleaf/SharedSpaceMap.svelte';
  import SharedSpaceMembers from '$lib/components/frameleaf/SharedSpaceMembers.svelte';
  import SharedSpaceNewSince from '$lib/components/frameleaf/SharedSpaceNewSince.svelte';
  import SharedSpacePeople from '$lib/components/frameleaf/SharedSpacePeople.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import SharedSpaceTimeline from '$lib/components/frameleaf/SharedSpaceTimeline.svelte';
  import SpaceMediaComments from '$lib/components/frameleaf/SpaceMediaComments.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { SpacePhotoSet } from '$lib/frameleaf/space-photos.svelte';
  import { shouldPageForViewer, spaceAssetHref, spaceViewerList } from '$lib/frameleaf/space-viewer';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import {
    activityUnreadHint,
    canContribute,
    isSpaceOwner,
    newSinceFilter,
    panelFromSearch,
    spaceOwner,
    SPACE_PANELS,
    type SpacePanel,
  } from '$lib/frameleaf/shared-space';
  import { defaultIconFor, othersOf, removalOutcome, type AlbumDetailsDraft } from '$lib/frameleaf/album-directory';
  import { Route } from '$lib/route';
  import {
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleEditAlbumDetails,
    handleLeaveAlbum,
    handleUpdateAlbumInfo,
    leftLocally,
  } from '$lib/services/album.service';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumKind,
    getAllSharedLinks,
    SharedLinkType,
    type AlbumResponseDto,
    type AssetResponseDto,
    type SharedSpaceActivityResponseDto,
    type SharedSpaceAlbumResponseDto,
    type SharedSpaceMemberResponseDto,
    type SharedSpaceNewResponseDto,
    type SharedSpacePeopleResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiChevronRight,
    mdiCommentTextOutline,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiFolderOpenOutline,
    mdiImageMultipleOutline,
    mdiLinkVariant,
    mdiLogoutVariant,
    mdiMapOutline,
    mdiPencilOutline,
    mdiPlayCircleOutline,
    mdiPlus,
    mdiUpload,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * One shared space (FL-55).
   *
   * This page is the space's home, and a space is its own context: its panels
   * are the ways into it — the photos (with what is new since this member's
   * last visit), the albums members have linked, the people members have named
   * for everyone, where the photos were taken, the conversation, and who is in
   * it with what role — and every photo they open, opens in the space's own
   * viewer at `/sharing/{spaceId}/photos/{assetId}`. Next and previous there
   * walk the space's photos in the grid's order, and closing it comes back to
   * this page on the same panel. The open panel is in the address, so a link
   * or a reload lands on the same one.
   *
   * A space is still an album underneath, so the album view of it keeps the
   * slideshow and adding photos.
   *
   * Leaving and deleting mean what they say: leaving takes you out and keeps
   * the space, deleting removes the space and keeps every original file in its
   * owner's library.
   */
  interface Props {
    space: AlbumResponseDto;
    members: SharedSpaceMemberResponseDto[];
    /** Albums the signed-in person can read, offered as bulk-add sources and to link. */
    albums?: AlbumResponseDto[];
    linkedAlbums?: SharedSpaceAlbumResponseDto[];
    people?: SharedSpacePeopleResponseDto;
    newSince?: SharedSpaceNewResponseDto | null;
    /** The first page of the activity feed, so the Activity panel opens at once and its badge is right. */
    activity?: SharedSpaceActivityResponseDto | null;
    /** Re-fetch after a change; the route owns the loader. */
    onRefresh: () => Promise<void> | void;
  }

  let {
    space,
    members,
    albums = [],
    linkedAlbums = [],
    people = { linked: [], candidates: [] },
    newSince = null,
    activity = null,
    onRefresh,
  }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const owner = $derived(isSpaceOwner(space, currentUserId));
  const contributor = $derived(canContribute(space, currentUserId));
  const ownerUser = $derived(spaceOwner(space));
  const others = $derived(othersOf(space, currentUserId));
  const name = $derived(space.albumName || $t('unnamed_album'));

  /* ------------------------------------------------------------------ */
  /* Panels                                                              */
  /* ------------------------------------------------------------------ */
  let panel = $state<SpacePanel>(panelFromSearch(page.url.searchParams));

  const panelLabels: Record<SpacePanel, string> = $derived({
    timeline: $t('frameleaf_spaces_panel_timeline'),
    albums: $t('frameleaf_spaces_panel_albums'),
    people: $t('frameleaf_spaces_panel_people'),
    places: $t('frameleaf_spaces_panel_places'),
    activity: $t('frameleaf_spaces_panel_activity'),
    members: $t('frameleaf_spaces_panel_members'),
  });
  // The loader's feed until the member marks the space seen; then the server's newer one.
  let activityFeed = $derived<SharedSpaceActivityResponseDto | null>(activity);
  // The Activity segment carries how much has happened since this member last marked the space seen.
  const panelOptions = $derived(
    SPACE_PANELS.map((value) => ({
      value,
      label: panelLabels[value],
      hint: value === 'activity' ? activityUnreadHint(activityFeed) : undefined,
    })),
  );

  // A shallow replace: the address follows the panel without re-running the loader.
  const choosePanel = (next: string) => {
    panel = panelFromSearch(new URLSearchParams({ panel: next }));
    const url = new URL(page.url);
    if (panel === 'timeline') {
      url.searchParams.delete('panel');
    } else {
      url.searchParams.set('panel', panel);
    }
    if (url.href !== page.url.href) {
      replaceState(url, page.state);
    }
  };

  /* ------------------------------------------------------------------ */
  /* New since the last visit                                            */
  /* ------------------------------------------------------------------ */
  // The loader's answer until the member marks the space seen; then the server's newer one, until
  // the loader runs again.
  let newInfo = $derived<SharedSpaceNewResponseDto | null>(newSince);
  let showingNew = $state(false);
  const timelineFilter = $derived(newSinceFilter(newInfo, showingNew));

  /* ------------------------------------------------------------------ */
  /* The space's photos and its own viewer                              */
  /* ------------------------------------------------------------------ */
  // One set per space and order, shared by the grid and the viewer. Keyed on the values, not the
  // space object, so a refresh after a membership change keeps what is already loaded.
  const spaceId = $derived(space.id);
  const spaceOrder = $derived(space.order);
  const photos = $derived(
    new SpacePhotoSet({
      spaceId,
      order: spaceOrder,
      onError: (error) => handleError(error, $t('frameleaf_spaces_error_timeline')),
    }),
  );

  const viewingId = $derived(assetViewerManager.isViewing ? assetViewerManager.asset?.id : undefined);
  const viewerAssets = $derived(spaceViewerList(photos.assets, timelineFilter, viewingId));

  // An item opened from the map, a comment or a linked album may not be loaded yet, and one near
  // the end of what is loaded needs the next page before "next" can reach it.
  $effect(() => {
    if (!viewingId) {
      return;
    }
    const next = shouldPageForViewer({
      index: photos.indexOf(viewingId),
      length: photos.assets.length,
      page: photos.page,
      exhausted: photos.exhausted,
      loading: photos.loading,
      failed: photos.failed,
    });
    if (next) {
      untrack(() => void photos.loadMore());
    }
  });

  // The address keeps the open panel, so closing the viewer lands on it again.
  const openAsset = (assetId: string) => goto(spaceAssetHref(space.id, assetId, globalThis.location?.search ?? ''));

  // Removing an item from the space in the viewer takes it out of the grid too.
  onMount(() =>
    eventManager.on({
      AlbumRemoveAssets: ({ assetIds, albumIds }) => {
        if (!albumIds.includes(space.id)) {
          return;
        }

        photos.remove(assetIds);
        void onRefresh();
      },
      // FL-55: a role changed elsewhere (the server's AlbumUserUpdateV1) re-reads the space, so a
      // downgraded contributor loses "Add everything matching" and the other contributor controls
      // at once. The server refuses the same actions again.
      AlbumUserUpdate: ({ albumId }) => {
        if (albumId === space.id) {
          void onRefresh();
        }
      },
      // Taken out of the space while it is open: nothing loaded for it stays on screen.
      AlbumUserDelete: (removal) => {
        const outcome = removalOutcome(removal, {
          albumId: space.id,
          userId: currentUserId,
          isOwner: isSpaceOwner(space, currentUserId),
          leftLocally: leftLocally(removal.albumId),
        });
        if (outcome === 'refresh') {
          void onRefresh();
        }
        if (outcome !== 'exit') {
          return;
        }
        assetViewerManager.showAssetViewer(false);
        photos.remove(photos.assets.map(({ id }) => id));
        toastManager.primary($t('frameleaf_album_access_removed', { values: { name: space.albumName } }));
        void goto(Route.sharing());
      },
    }),
  );

  /** A map pin can stand for several items; the viewer opens on the first of them. */
  const openFirst = (assetIds: string[]) => {
    if (assetIds.length > 0) {
      void openAsset(assetIds[0]);
    }
  };

  let busy = $state(false);
  let status = $state('');

  let editOpen = $state(false);
  let leaveOpen = $state(false);
  let deleteOpen = $state(false);
  let iconOpen = $state(false);
  let linkFormOpen = $state(false);

  /* ------------------------------------------------------------------ */
  /* The collection header (CollectionHeader.jsx:1100-1352), AL-42       */
  /* ------------------------------------------------------------------ */
  /** Inline title, description and icon: `PATCH /albums/{id}`, since a space is an album underneath. */
  const save = async (dto: Parameters<typeof handleUpdateAlbumInfo>[1], message: string) => {
    const updated = await handleUpdateAlbumInfo(space.id, dto, { message });
    if (!updated) {
      return false;
    }
    status = message;
    await onRefresh();
    return true;
  };

  /** The space's own public links (`GET /shared-links?albumId=`): the owner creates and manages them. */
  let linkCount = $state(0);
  $effect(() => {
    const id = space.id;
    if (!owner) {
      linkCount = 0;
      return;
    }
    let cancelled = false;
    getAllSharedLinks({ albumId: id })
      .then((links) => {
        if (!cancelled) {
          linkCount = links?.length ?? 0;
        }
      })
      .catch(() => {
        // Without the list the button offers to create a link; the Shared links page lists them all.
        if (!cancelled) {
          linkCount = 0;
        }
      });
    return () => {
      cancelled = true;
    };
  });
  const openLinks = () => {
    if (linkCount > 0) {
      void goto(Route.sharedLinks());
      return;
    }
    linkFormOpen = true;
  };
  const linkTarget = $derived({
    type: SharedLinkType.Album,
    albumId: space.id,
    name,
    previewAssetIds: space.albumThumbnailAssetId ? [space.albumThumbnailAssetId] : [],
    count: space.assetCount,
  });

  /** "Select from library": the Library picks, its selection bar's "Add to album" adds (as on an album). */
  const addFromLibrary = async () => {
    await goto(Route.photos());
    toastManager.primary($t('frameleaf_album_add_photos_hint'));
  };
  const upload = async () => {
    try {
      await openFileUploadDialog({ albumId: space.id });
    } catch (error) {
      handleError(error, $t('errors.unable_to_upload_file'));
    }
  };

  /** The slideshow plays in the space's own viewer, over the space's photos in the grid's order. */
  const { slideshowState, slideshowNavigation } = slideshowStore;
  const startSlideshow = async () => {
    if (photos.assets.length === 0) {
      await photos.reload();
    }
    const list = photos.assets;
    if (list.length === 0) {
      return;
    }
    const first =
      $slideshowNavigation === SlideshowNavigation.Shuffle ? list[Math.floor(Math.random() * list.length)] : list[0];
    await openAsset(first.id);
    slideshowState.set(SlideshowState.PlaySlideshow);
  };

  const activityCount = $derived(activityFeed?.unreadCount ?? 0);

  /** The Frameleaf edit dialog (`CollectionFormDialog`) in place of the legacy modal (AL-42). */
  const saveDetails = async (draft: AlbumDetailsDraft) => {
    const saved = await handleEditAlbumDetails(space, draft);
    if (saved) {
      status = $t('frameleaf_albums_saved', { values: { name: saved.albumName || $t('unnamed_album') } });
      await onRefresh();
    }
    return !!saved;
  };

  /** Leave and delete confirm in the Frameleaf dialogs (`LeaveDialog`, `DeleteDialog`); AL-43. */
  const confirmLeave = async () => {
    busy = true;
    try {
      if (await handleLeaveAlbum(space)) {
        await goto(Route.sharing());
      }
    } finally {
      busy = false;
    }
  };

  const confirmDelete = async () => {
    busy = true;
    try {
      if (await handleDeleteAlbum(space)) {
        await goto(Route.sharing());
      }
    } finally {
      busy = false;
    }
  };
</script>

<section class="space" aria-label={name}>
  <header class="head" aria-label={$t('frameleaf_album_kind_space')}>
    <nav class="crumbs" aria-label={$t('frameleaf_album_breadcrumb')}>
      <a href={Route.sharing()}>{$t('frameleaf_shared_spaces')}</a>
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
      <span aria-current="page">{name}</span>
    </nav>

    <div class="main">
      <div class="icon-wrap">
        {#if contributor}
          <button
            type="button"
            class="icon-button"
            class:open={iconOpen}
            aria-haspopup="dialog"
            aria-expanded={iconOpen}
            aria-label={$t('frameleaf_album_change_icon')}
            onclick={() => (iconOpen = !iconOpen)}
          >
            <AlbumIcon name={space.icon ?? defaultIconFor(space.kind)} size="26" />
            <span class="badge" aria-hidden="true"><Icon icon={mdiPencilOutline} size="12" /></span>
          </button>
          {#if iconOpen}
            <div class="popover">
              <IconChooser
                value={space.icon ?? defaultIconFor(space.kind)}
                label={$t('frameleaf_album_icon_for', { values: { name } })}
                onClose={() => (iconOpen = false)}
                onChange={(icon) => void save({ icon }, $t('frameleaf_album_icon_updated'))}
              />
            </div>
          {/if}
        {:else}
          <span class="icon-button static" aria-hidden="true">
            <AlbumIcon name={space.icon ?? defaultIconFor(space.kind)} size="26" />
          </span>
        {/if}
      </div>

      <div class="text">
        <div class="title-row">
          <AlbumInlineEdit
            as="h1"
            label={$t('frameleaf_album_edit_title')}
            value={space.albumName}
            editable={contributor}
            placeholder={$t('unnamed_album')}
            onSave={(albumName) => save({ albumName }, $t('frameleaf_album_title_saved'))}
          />
          <span class="badge-pill">{$t('frameleaf_album_kind_space')}</span>
          {#if !owner && ownerUser}
            <span class="shared-by">{$t('frameleaf_spaces_owned_by', { values: { name: ownerUser.name } })}</span>
          {/if}
        </div>

        <AlbumInlineEdit
          as="p"
          label={$t('frameleaf_album_edit_description')}
          value={space.description}
          editable={contributor}
          multiline
          placeholder={contributor ? $t('frameleaf_album_add_description') : ''}
          onSave={(description) => save({ description }, $t('frameleaf_album_description_saved'))}
        />

        <div class="summary">
          <span>{$t('frameleaf_albums_items', { values: { count: space.assetCount } })}</span>
          <span class="dot" aria-hidden="true"></span>
          {#if others.length > 0}
            <button
              type="button"
              class="members"
              aria-label={$t('frameleaf_spaces_manage_members', { values: { count: others.length } })}
              onclick={() => choosePanel('members')}
            >
              <AlbumAvatarStack users={others} />
              <span>{$t('frameleaf_album_shared_with_count', { values: { count: others.length } })}</span>
            </button>
          {:else if owner}
            <button type="button" class="members" onclick={() => choosePanel('members')}>
              <span aria-hidden="true"><Icon icon={mdiAccountPlusOutline} size="16" /></span>
              <span>{$t('frameleaf_album_private_share_it')}</span>
            </button>
          {:else}
            <span>{$t('frameleaf_album_private')}</span>
          {/if}
        </div>
      </div>
    </div>

    <div class="actions" role="toolbar" aria-label={$t('frameleaf_album_actions', { values: { kind: name } })}>
      {#if contributor}
        <Menu label={$t('add_photos')} align="start">
          {#snippet trigger()}
            <span class="trigger-content"><Icon icon={mdiPlus} size="18" />{$t('add_photos')}</span>
          {/snippet}
          <MenuItem onSelect={() => void addFromLibrary()}>
            <Icon icon={mdiImageMultipleOutline} size="18" />
            {$t('frameleaf_album_select_from_library')}
          </MenuItem>
          <MenuItem onSelect={() => void upload()}>
            <Icon icon={mdiUpload} size="18" />
            {$t('frameleaf_album_upload_from_computer')}
          </MenuItem>
        </Menu>
      {/if}

      <!-- A space's people are invitations and roles, managed on its Members panel. -->
      <button type="button" class="action" onclick={() => choosePanel('members')}>
        <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" />
        <span>{owner ? $t('share') : $t('frameleaf_albums_members')}</span>
      </button>

      {#if owner}
        <button
          type="button"
          class="action"
          aria-label={linkCount > 0
            ? $t('frameleaf_spaces_links_count', { values: { count: linkCount } })
            : $t('frameleaf_albums_create_link')}
          onclick={openLinks}
        >
          <Icon icon={mdiLinkVariant} size="18" />
          <span>{$t('frameleaf_spaces_links')}</span>
          {#if linkCount > 0}
            <span class="count" aria-hidden="true">{linkCount}</span>
          {/if}
        </button>
      {/if}

      <!-- The space's own map and conversation are its Places and Activity panels. -->
      <button type="button" class="action" disabled={space.assetCount === 0} onclick={() => choosePanel('places')}>
        <Icon icon={mdiMapOutline} size="18" />
        <span>{$t('map')}</span>
      </button>

      <button type="button" class="action" disabled={space.assetCount === 0} onclick={() => void startSlideshow()}>
        <Icon icon={mdiPlayCircleOutline} size="18" />
        <span>{$t('slideshow')}</span>
      </button>

      <button type="button" class="action" disabled={space.assetCount === 0} onclick={() => handleDownloadAlbum(space)}>
        <Icon icon={mdiDownloadOutline} size="18" />
        <span>{$t('download')}</span>
      </button>

      <button
        type="button"
        class="action"
        aria-pressed={panel === 'activity'}
        aria-label={$t('frameleaf_spaces_activity_button', { values: { count: activityCount } })}
        onclick={() => choosePanel('activity')}
      >
        <Icon icon={mdiCommentTextOutline} size="18" />
        <span>{$t('activity')}</span>
        {#if activityCount > 0}
          <span class="count" aria-hidden="true">{activityCount}</span>
        {/if}
      </button>

      <span class="spacer"></span>

      <Menu label={$t('frameleaf_album_more_actions')} align="end">
        {#snippet trigger()}
          <span class="trigger-content"><Icon icon={mdiDotsHorizontal} size="18" /></span>
        {/snippet}
        <MenuItem onSelect={() => goto(Route.viewAlbum({ id: space.id }))}>
          <Icon icon={mdiFolderOpenOutline} size="18" />
          {$t('frameleaf_spaces_open_photos')}
        </MenuItem>
        {#if contributor}
          <MenuItem onSelect={() => (editOpen = true)}>
            <Icon icon={mdiPencilOutline} size="18" />
            {$t('frameleaf_album_edit_details')}
          </MenuItem>
        {/if}
        <div class="menu-separator" role="separator"></div>
        {#if owner}
          <MenuItem disabled={busy} onSelect={() => (deleteOpen = true)}>
            <span class="danger-item">
              <Icon icon={mdiDeleteOutline} size="18" />
              {$t('frameleaf_spaces_delete')}
            </span>
          </MenuItem>
        {:else}
          <MenuItem disabled={busy} onSelect={() => (leaveOpen = true)}>
            <span class="danger-item">
              <Icon icon={mdiLogoutVariant} size="18" />
              {$t('frameleaf_spaces_leave')}
            </span>
          </MenuItem>
        {/if}
      </Menu>
    </div>
  </header>

  <Status message={status} {busy} />

  <div class="panels">
    <SegmentedControl
      label={$t('frameleaf_spaces_panels')}
      options={panelOptions}
      value={panel}
      onChange={choosePanel}
    />
  </div>

  <!-- Moving to another space starts every panel afresh, so nothing loaded for one space shows in the next. -->
  {#key space.id}
    <div class="panel" data-panel={panel}>
      {#if panel === 'timeline'}
        <SharedSpaceNewSince
          {space}
          info={newInfo}
          showing={showingNew}
          onToggle={(next) => (showingNew = next)}
          onMarked={(next) => (newInfo = next)}
        />
        {#if contributor}
          <SharedSpaceAddMatching {space} {albums} />
        {/if}
        <SharedSpaceTimeline
          {space}
          {photos}
          filter={timelineFilter}
          isViewer={!contributor}
          onOpen={(asset) => void openAsset(asset.id)}
          onChanged={onRefresh}
        />
      {:else if panel === 'albums'}
        <SharedSpaceLinkedAlbums
          {space}
          albums={linkedAlbums}
          library={albums}
          onChanged={onRefresh}
          onOpenAsset={(assetId) => void openAsset(assetId)}
        />
      {:else if panel === 'people'}
        <SharedSpacePeople {space} linked={people.linked} candidates={people.candidates} onChanged={onRefresh} />
      {:else if panel === 'places'}
        <SharedSpaceMap {space} onSelect={openFirst} />
      {:else if panel === 'activity'}
        <SharedSpaceActivity
          {space}
          {members}
          feed={activityFeed}
          onClose={() => choosePanel('timeline')}
          onOpenAsset={(assetId) => void openAsset(assetId)}
          onMarked={(next) => (activityFeed = next)}
        />
      {:else}
        <SharedSpaceMembers {space} {members} onChanged={onRefresh} />
      {/if}
    </div>
  {/key}
</section>

<AlbumCreateDialog
  bind:open={editOpen}
  kind={AlbumKind.Space}
  album={space}
  collections={[]}
  onCreate={() => Promise.resolve(false)}
  onSave={saveDetails}
/>

{#if owner}
  <SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />
{/if}

<AlbumConfirmDialog
  title={$t('frameleaf_album_delete_title', { values: { name: space.albumName || $t('unnamed_album') } })}
  body={$t('frameleaf_album_delete_space_body')}
  keepNote={$t('frameleaf_album_delete_keep', { values: { count: space.assetCount } })}
  confirmLabel={$t('frameleaf_album_delete', { values: { kind: $t('frameleaf_album_kind_space') } })}
  bind:open={deleteOpen}
  onConfirm={confirmDelete}
/>

<AlbumConfirmDialog
  title={$t('frameleaf_album_leave_title', { values: { name: space.albumName || $t('unnamed_album') } })}
  body={$t('frameleaf_album_leave_body')}
  confirmLabel={$t('frameleaf_album_leave', { values: { kind: $t('frameleaf_album_kind_space') } })}
  bind:open={leaveOpen}
  onConfirm={confirmLeave}
/>

<!--
  The space's own viewer. It walks the same photo set the grid draws, and its side panel is the
  space's conversation about the open item: comments with @mentions, edit and delete of one's own,
  and owner/editor moderation, through the shared space comment endpoints.
-->
<ResultsAssetViewer
  assets={viewerAssets}
  album={space}
  isShared={true}
  emptyRoute={Route.viewSharedSpace({ id: space.id })}
  onAssetChange={(asset) => photos.replace(asset)}
  onRemove={(id) => {
    photos.remove([id]);
    void onRefresh();
  }}
  activityPanel={spaceComments}
/>

{#snippet spaceComments(asset: AssetResponseDto)}
  <div class="space-comments" data-space-comments-mount data-space-id={space.id} data-comments-asset-id={asset.id}>
    <SpaceMediaComments
      spaceId={space.id}
      assetId={asset.id}
      canComment={space.isActivityEnabled}
      onClose={() => assetViewerManager.closeActivityPanel()}
    />
  </div>
{/snippet}

<style>
  .space {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    color: var(--fl-text);
  }
  .head {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
    flex-wrap: wrap;
  }
  .crumbs a {
    color: var(--fl-muted);
    text-decoration: none;
    padding: 0.125rem 0.25rem;
    border-radius: var(--fl-radius);
  }
  .crumbs a:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .crumbs span[aria-current='page'] {
    color: var(--fl-text);
  }
  .main {
    display: flex;
    gap: 0.875rem;
    align-items: flex-start;
  }
  .icon-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .icon-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 3rem;
    block-size: 3rem;
    padding: 0;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .icon-button.static {
    cursor: default;
  }
  .badge {
    position: absolute;
    inset-block-end: -0.25rem;
    inset-inline-end: -0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 1.25rem;
    block-size: 1.25rem;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-radius: 50%;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .icon-button:hover .badge,
  .icon-button:focus-visible .badge,
  .icon-button.open .badge {
    opacity: 1;
  }
  .popover {
    position: absolute;
    inset-block-start: calc(100% + 0.375rem);
    inset-inline-start: 0;
    z-index: 40;
  }
  .text {
    flex: 1;
    min-inline-size: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .badge-pill {
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .badge-pill::first-letter {
    text-transform: uppercase;
  }
  .shared-by {
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .dot {
    inline-size: 3px;
    block-size: 3px;
    border-radius: 50%;
    background: currentColor;
  }
  .members {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.375rem;
    font: inherit;
    color: var(--fl-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
  }
  .members:hover {
    background: var(--fl-raised);
    border-color: var(--fl-border);
    color: var(--fl-text);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-wrap: wrap;
  }
  .action,
  .trigger-content {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    white-space: nowrap;
  }
  .action {
    padding: 0 0.6875rem;
    min-height: 44px;
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .action:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .action[aria-pressed='true'] {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .action:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .count {
    font-variant-numeric: var(--fl-numeric);
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-radius: var(--fl-radius-pill);
  }
  .spacer {
    flex: 1;
  }
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
  .danger-item {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-danger);
  }
  /* The collection header's large title, shrinking as the page scrolls (apple-style.css:219-244). */
  .title-row :global(h1) {
    margin: 0;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    transform-origin: left bottom;
  }
  @supports (animation-timeline: scroll()) {
    .title-row :global(h1) {
      animation: fl-space-title-shrink linear both;
      animation-timeline: scroll(nearest block);
      animation-range: 0 90px;
    }
    @media (prefers-reduced-motion: reduce) {
      .title-row :global(h1) {
        animation-name: fl-space-title-fade;
      }
    }
  }
  @keyframes fl-space-title-shrink {
    to {
      scale: 0.62;
      opacity: 0.2;
    }
  }
  @keyframes fl-space-title-fade {
    to {
      opacity: 0.2;
    }
  }
  /* Six panels do not fit a phone's width; the row scrolls sideways instead of the page. */
  .panels {
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .panels :global(.segments) {
    flex-wrap: nowrap;
    white-space: nowrap;
  }
  .space-comments {
    block-size: 100%;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  @media (max-width: 640px) {
    .space {
      padding: 0.75rem;
    }
  }
</style>
