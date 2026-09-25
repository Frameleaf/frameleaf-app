<script lang="ts">
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import SharedSpaceActivity from '$lib/components/frameleaf/SharedSpaceActivity.svelte';
  import SharedSpaceAddMatching from '$lib/components/frameleaf/SharedSpaceAddMatching.svelte';
  import SharedSpaceLinkedAlbums from '$lib/components/frameleaf/SharedSpaceLinkedAlbums.svelte';
  import SharedSpaceMap from '$lib/components/frameleaf/SharedSpaceMap.svelte';
  import SharedSpaceMembers from '$lib/components/frameleaf/SharedSpaceMembers.svelte';
  import SharedSpaceNewSince from '$lib/components/frameleaf/SharedSpaceNewSince.svelte';
  import SharedSpacePeople from '$lib/components/frameleaf/SharedSpacePeople.svelte';
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
  import { removalOutcome, type AlbumDetailsDraft } from '$lib/frameleaf/album-directory';
  import { Route } from '$lib/route';
  import {
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleEditAlbumDetails,
    handleLeaveAlbum,
    leftLocally,
  } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumKind,
    type AlbumResponseDto,
    type AssetResponseDto,
    type SharedSpaceActivityResponseDto,
    type SharedSpaceAlbumResponseDto,
    type SharedSpaceMemberResponseDto,
    type SharedSpaceNewResponseDto,
    type SharedSpacePeopleResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import {
    mdiArrowLeft,
    mdiDeleteOutline,
    mdiDownloadOutline,
    mdiImageMultipleOutline,
    mdiLogoutVariant,
    mdiPencilOutline,
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

<section class="space" aria-labelledby="frameleaf-space-heading">
  <a class="back" href={Route.sharing()}>
    <Icon icon={mdiArrowLeft} size="16" aria-hidden={true} />
    {$t('frameleaf_spaces_all')}
  </a>

  <header class="head">
    <AlbumIcon name={space.icon} size="36" />
    <div class="heading">
      <h1 id="frameleaf-space-heading">{space.albumName}</h1>
      <p>
        {#if ownerUser}
          {$t('frameleaf_spaces_owned_by', { values: { name: ownerUser.name } })} ·
        {/if}
        {$t('frameleaf_albums_items', { values: { count: space.assetCount } })}
      </p>
      {#if space.description}
        <p class="description">{space.description}</p>
      {/if}
    </div>

    <div class="actions">
      <a class="button primary" href={Route.viewAlbum({ id: space.id })}>
        <Icon icon={mdiImageMultipleOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_open_photos')}
      </a>
      {#if contributor}
        <button type="button" onclick={() => (editOpen = true)}>
          <Icon icon={mdiPencilOutline} size="16" aria-hidden={true} />
          {$t('edit')}
        </button>
      {/if}
      {#if space.assetCount > 0}
        <button type="button" onclick={() => handleDownloadAlbum(space)}>
          <Icon icon={mdiDownloadOutline} size="16" aria-hidden={true} />
          {$t('download')}
        </button>
      {/if}
      {#if owner}
        <button type="button" class="danger" disabled={busy} onclick={() => (deleteOpen = true)}>
          <Icon icon={mdiDeleteOutline} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_delete')}
        </button>
      {:else}
        <button type="button" class="danger" disabled={busy} onclick={() => (leaveOpen = true)}>
          <Icon icon={mdiLogoutVariant} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_leave')}
        </button>
      {/if}
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
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    color: var(--fl-muted);
    font-size: 0.8125rem;
    text-decoration: none;
    width: fit-content;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.75rem;
  }
  .heading {
    flex: 1;
    min-width: 12rem;
  }
  /* The collection header's large title, shrinking as the page scrolls (apple-style.css:219-244). */
  h1 {
    margin: 0;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    transform-origin: left bottom;
  }
  @supports (animation-timeline: scroll()) {
    h1 {
      animation: fl-space-title-shrink linear both;
      animation-timeline: scroll(nearest block);
      animation-range: 0 90px;
    }
    @media (prefers-reduced-motion: reduce) {
      h1 {
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
  .heading p {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .heading .description {
    max-width: 40rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  button,
  .button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    font-weight: 600;
    text-decoration: none;
  }
  .button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  button.danger {
    color: var(--fl-danger, #c0392b);
  }
  button:disabled {
    opacity: 0.6;
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
