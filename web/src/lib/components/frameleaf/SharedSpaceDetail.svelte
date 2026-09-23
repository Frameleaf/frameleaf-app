<script lang="ts">
  import { goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import SharedSpaceActivity from '$lib/components/frameleaf/SharedSpaceActivity.svelte';
  import SharedSpaceAddMatching from '$lib/components/frameleaf/SharedSpaceAddMatching.svelte';
  import SharedSpaceLinkedAlbums from '$lib/components/frameleaf/SharedSpaceLinkedAlbums.svelte';
  import SharedSpaceMap from '$lib/components/frameleaf/SharedSpaceMap.svelte';
  import SharedSpaceMembers from '$lib/components/frameleaf/SharedSpaceMembers.svelte';
  import SharedSpaceNewSince from '$lib/components/frameleaf/SharedSpaceNewSince.svelte';
  import SharedSpacePeople from '$lib/components/frameleaf/SharedSpacePeople.svelte';
  import SharedSpaceTimeline from '$lib/components/frameleaf/SharedSpaceTimeline.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { canEdit } from '$lib/frameleaf/album-directory';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    canContribute,
    isSpaceOwner,
    newSinceFilter,
    panelFromSearch,
    spaceOwner,
    SPACE_PANELS,
    type SpacePanel,
  } from '$lib/frameleaf/shared-space';
  import AlbumEditModal from '$lib/modals/AlbumEditModal.svelte';
  import { Route } from '$lib/route';
  import { handleDeleteAlbum, handleDownloadAlbum, handleRemoveUserFromAlbum } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import type {
    AlbumResponseDto,
    SharedSpaceAlbumResponseDto,
    SharedSpaceMemberResponseDto,
    SharedSpaceNewResponseDto,
    SharedSpacePeopleResponseDto,
  } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiArrowLeft,
    mdiDeleteOutline,
    mdiDownloadOutline,
    mdiImageMultipleOutline,
    mdiLogoutVariant,
    mdiPencilOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * One shared space (FL-55).
   *
   * A space is an album, so the album view still owns the viewer, per-item
   * activity, the cover and the slideshow; this page is the space's home. Its
   * panels are the ways into it: the photos (with what is new since this
   * member's last visit), the albums members have linked, the people members
   * have named for everyone, where the photos were taken, the conversation,
   * and who is in it with what role. The open panel is in the address, so a
   * link or a reload lands on the same one.
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
    /** Shared spaces the signed-in person is in, offered as bulk "add to album" targets. */
    spaces?: AlbumResponseDto[];
    linkedAlbums?: SharedSpaceAlbumResponseDto[];
    people?: SharedSpacePeopleResponseDto;
    newSince?: SharedSpaceNewResponseDto | null;
    /** Re-fetch after a change; the route owns the loader. */
    onRefresh: () => Promise<void> | void;
  }

  let {
    space,
    members,
    albums = [],
    spaces = [],
    linkedAlbums = [],
    people = { linked: [], candidates: [] },
    newSince = null,
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
  const panelOptions = $derived(SPACE_PANELS.map((value) => ({ value, label: panelLabels[value] })));

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

  /** Albums and spaces a bulk "add to album" may target: the ones this member may add to. */
  const albumOptions = $derived(
    [...albums, ...spaces]
      .filter((entry) => canEdit(entry, currentUserId))
      .map((entry) => ({ id: entry.id, name: entry.albumName || $t('unnamed_album'), count: entry.assetCount })),
  );

  // The viewer, per-item activity and the slideshow live on the album view of the same space.
  const openAsset = (assetId: string) => goto(Route.viewAlbumAsset({ albumId: space.id, assetId }));

  /** A map pin can stand for several items; the viewer opens on the first of them. */
  const openFirst = (assetIds: string[]) => {
    if (assetIds.length > 0) {
      void openAsset(assetIds[0]);
    }
  };

  let busy = $state(false);
  let status = $state('');

  const edit = async () => {
    await modalManager.show(AlbumEditModal, { album: space });
    await onRefresh();
  };

  const leave = async () => {
    busy = true;
    try {
      await handleRemoveUserFromAlbum(space, authManager.user);
      await goto(Route.sharing());
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
    } finally {
      busy = false;
    }
  };

  const remove = async () => {
    busy = true;
    try {
      const deleted = await handleDeleteAlbum(space);
      if (deleted) {
        await goto(Route.sharing());
      }
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_members'));
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
        <button type="button" onclick={edit}>
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
        <button type="button" class="danger" disabled={busy} onclick={remove}>
          <Icon icon={mdiDeleteOutline} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_delete')}
        </button>
      {:else}
        <button type="button" class="danger" disabled={busy} onclick={leave}>
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
          filter={timelineFilter}
          {albumOptions}
          onOpen={(asset) => void openAsset(asset.id)}
          onChanged={onRefresh}
        />
      {:else if panel === 'albums'}
        <SharedSpaceLinkedAlbums {space} albums={linkedAlbums} library={albums} onChanged={onRefresh} />
      {:else if panel === 'people'}
        <SharedSpacePeople {space} linked={people.linked} candidates={people.candidates} onChanged={onRefresh} />
      {:else if panel === 'places'}
        <SharedSpaceMap {space} onSelect={openFirst} />
      {:else if panel === 'activity'}
        <SharedSpaceActivity {space} onClose={() => choosePanel('timeline')} />
      {:else}
        <SharedSpaceMembers {space} {members} onChanged={onRefresh} />
      {/if}
    </div>
  {/key}
</section>

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
  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
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
  .button.primary,
  button.primary {
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
