<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCoverDialog from '$lib/components/frameleaf/AlbumCoverDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import AlbumInlineEdit from '$lib/components/frameleaf/AlbumInlineEdit.svelte';
  import AlbumOptionsDialog from '$lib/components/frameleaf/AlbumOptionsDialog.svelte';
  import AlbumShareDialog from '$lib/components/frameleaf/AlbumShareDialog.svelte';
  import AlbumAvatarStack from '$lib/components/frameleaf/AlbumAvatarStack.svelte';
  import AlbumTile from '$lib/components/frameleaf/AlbumTile.svelte';
  import IconChooser from '$lib/components/frameleaf/IconChooser.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import { canEdit, defaultIconFor, isOwner, monthSpan, othersOf } from '$lib/frameleaf/album-directory';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import MapModal from '$lib/modals/MapModal.svelte';
  import { Route } from '$lib/route';
  import {
    handleCreateAlbumEntry,
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleLeaveAlbum,
    handleUpdateAlbumInfo,
  } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { navigate } from '$lib/utils/navigation';
  import {
    AlbumKind,
    getAlbumMapMarkers,
    SharedLinkType,
    type AlbumResponseDto,
    type CreateAlbumDto,
    type MapMarkerResponseDto,
  } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiAccountCircleOutline,
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiChevronRight,
    mdiCommentTextOutline,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiImageMultipleOutline,
    mdiImageOutline,
    mdiLinkVariant,
    mdiLogoutVariant,
    mdiMapOutline,
    mdiPencilOutline,
    mdiPlayCircleOutline,
    mdiPlus,
    mdiTuneVariant,
    mdiUpload,
  } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  /**
   * The album detail header (FL-53), ported from
   * `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * It carries inline title and description, the icon popover over the whole Material
   * catalogue, members with roles, links, map, slideshow, download, cover, options, delete
   * keeping assets, and leave — and, on a collection, the strip of its albums above its
   * photos with a New album tile and a New album primary action in place of Add photos.
   *
   * Every control calls an existing endpoint: `PATCH /albums/{id}` for the details, the
   * album user endpoints for membership, the shared-link endpoints for links,
   * `GET /albums/{id}/map-marker` for the map and `GET /albums/tree` (loaded by the route)
   * for the album strip. What a viewer, an editor and the owner may do follows the roles the
   * server returned in `albumUsers`, so a revoked role removes the control on the next read.
   */
  interface Props {
    album: AlbumResponseDto;
    /** Albums inside this collection, from the tree endpoint. Empty for an album or space. */
    childAlbums?: AlbumResponseDto[];
    /** The collection this album sits in, for the breadcrumb. */
    parent?: AlbumResponseDto;
    /** Collections the current user may create an album in. */
    collections?: AlbumResponseDto[];
    likeCount?: number;
    commentCount?: number;
    activityOpen?: boolean;
    /** True when the album has editors, so owner badges can be shown on its items. */
    canShowOwnerBadges?: boolean;
    ownerBadges?: boolean;
    /** Items on the page; the slideshow and download are offered only when there are some. */
    assetCount?: number;
    onAlbumChange: (album: AlbumResponseDto) => void;
    /** Re-read the album and the tree after membership or structure changed. */
    onRefresh: () => Promise<void> | void;
    onAddPhotos?: () => void;
    onSlideshow?: () => void;
    onToggleActivity?: () => void;
    onToggleOwnerBadges?: () => void;
  }

  let {
    album,
    childAlbums = [],
    parent,
    collections = [],
    likeCount = 0,
    commentCount = 0,
    activityOpen = false,
    canShowOwnerBadges = false,
    ownerBadges = false,
    assetCount = 0,
    onAlbumChange,
    onRefresh,
    onAddPhotos,
    onSlideshow,
    onToggleActivity,
    onToggleOwnerBadges,
  }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const owner = $derived(isOwner(album, currentUserId));
  const editor = $derived(canEdit(album, currentUserId));
  const isCollection = $derived(album.kind === AlbumKind.Collection);
  const others = $derived(othersOf(album, currentUserId));
  const name = $derived(album.albumName || $t('unnamed_album'));
  const span = $derived(monthSpan(album.startDate, album.endDate, $locale ?? undefined));

  const kindLabel = $derived(
    isCollection
      ? $t('frameleaf_album_kind_collection')
      : album.kind === AlbumKind.Space
        ? $t('frameleaf_album_kind_space')
        : $t('frameleaf_album_kind_album'),
  );

  /** The albums a cover may be picked from: this album, or a collection's albums. */
  const coverSourceIds = $derived(isCollection ? childAlbums.map(({ id }) => id) : [album.id]);

  let iconOpen = $state(false);
  let shareOpen = $state(false);
  let coverOpen = $state(false);
  let optionsOpen = $state(false);
  let deleteOpen = $state(false);
  let leaveOpen = $state(false);
  let createOpen = $state(false);
  let linkFormOpen = $state(false);
  let status = $state('');

  let mapMarkers = $state<MapMarkerResponseDto[]>([]);
  let markerController: AbortController | undefined;

  const mapEnabled = $derived(featureFlagsManager.value.map);

  // The map button states honestly whether this album has anything to put on a map, so it is
  // disabled rather than opening an empty map.
  $effect(() => {
    const id = album.id;
    if (!mapEnabled) {
      mapMarkers = [];
      return;
    }
    markerController?.abort();
    const controller = new AbortController();
    markerController = controller;
    void getAlbumMapMarkers({ ...authManager.params, id }, { signal: controller.signal })
      .then((markers) => {
        if (!controller.signal.aborted) {
          mapMarkers = markers;
        }
      })
      .catch(() => {
        // A map that cannot be loaded simply stays unavailable; nothing else depends on it.
        if (!controller.signal.aborted) {
          mapMarkers = [];
        }
      });
    return () => controller.abort();
  });

  const save = async (dto: Parameters<typeof handleUpdateAlbumInfo>[1], message: string) => {
    const updated = await handleUpdateAlbumInfo(album.id, dto, { message });
    if (!updated) {
      return false;
    }
    onAlbumChange(updated);
    status = message;
    return true;
  };

  const openMap = async () => {
    const assetIds = await modalManager.show(MapModal, { mapMarkers });
    if (assetIds?.[0]) {
      await navigate({ targetRoute: 'current', assetId: assetIds[0] });
    }
  };

  const createChildAlbum = async (dto: CreateAlbumDto) => {
    const created = await handleCreateAlbumEntry(dto);
    if (!created) {
      return false;
    }
    await goto(Route.viewAlbum({ id: created.id }));
    return true;
  };

  const confirmDelete = async () => {
    const deleted = await handleDeleteAlbum(album, { prompt: false });
    if (deleted) {
      await goto(Route.albums());
    }
  };

  const confirmLeave = async () => {
    const left = await handleLeaveAlbum(album);
    if (left) {
      await goto(Route.albums());
    }
  };

  const upload = async () => {
    try {
      await openFileUploadDialog({ albumId: album.id });
    } catch (error) {
      handleError(error, $t('errors.unable_to_upload_file'));
    }
  };

  const linkTarget = $derived({ type: SharedLinkType.Album, albumId: album.id, name });

  /** With links already on the album, the list is the useful place; otherwise create one. */
  const openLinks = async () => {
    if (album.hasSharedLink) {
      await goto(Route.sharedLinks());
      return;
    }
    linkFormOpen = true;
  };
</script>

<header class="album-header" aria-label={kindLabel}>
  <nav class="crumbs" aria-label={$t('frameleaf_album_breadcrumb')}>
    <a href={Route.albums()}>{album.kind === AlbumKind.Space ? $t('sharing') : $t('albums')}</a>
    {#if parent}
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
      <a href={Route.viewAlbum({ id: parent.id })}>{parent.albumName || $t('unnamed_album')}</a>
    {/if}
    <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
    <span aria-current="page">{name}</span>
  </nav>

  <div class="main">
    <div class="icon-wrap">
      {#if editor}
        <button
          type="button"
          class="icon-button"
          class:open={iconOpen}
          aria-haspopup="dialog"
          aria-expanded={iconOpen}
          aria-label={$t('frameleaf_album_change_icon')}
          onclick={() => (iconOpen = !iconOpen)}
        >
          <AlbumIcon name={album.icon ?? defaultIconFor(album.kind)} size="26" />
          <span class="badge" aria-hidden="true"><Icon icon={mdiPencilOutline} size="12" /></span>
        </button>
        {#if iconOpen}
          <div class="popover">
            <IconChooser
              value={album.icon ?? defaultIconFor(album.kind)}
              label={$t('frameleaf_album_icon_for', { values: { name } })}
              onClose={() => (iconOpen = false)}
              onChange={(icon) => void save({ icon }, $t('frameleaf_album_icon_updated'))}
            />
          </div>
        {/if}
      {:else}
        <span class="icon-button static" aria-hidden="true">
          <AlbumIcon name={album.icon ?? defaultIconFor(album.kind)} size="26" />
        </span>
      {/if}
    </div>

    <div class="text">
      <div class="title-row">
        <AlbumInlineEdit
          as="h1"
          label={$t('frameleaf_album_edit_title')}
          value={album.albumName}
          editable={editor}
          placeholder={$t('unnamed_album')}
          onSave={(albumName) => save({ albumName }, $t('frameleaf_album_title_saved'))}
        />
        {#if album.kind === AlbumKind.Space}
          <span class="badge-pill">{$t('frameleaf_album_kind_space')}</span>
        {:else if isCollection}
          <span class="badge-pill">{$t('frameleaf_album_kind_collection')}</span>
        {/if}
        {#if album.isSmart}
          <span class="badge-pill">{$t('frameleaf_albums_smart_mark')}</span>
        {/if}
        {#if !owner}
          <span class="shared-by">{$t('frameleaf_album_shared_with_you')}</span>
        {/if}
      </div>

      <AlbumInlineEdit
        as="p"
        label={$t('frameleaf_album_edit_description')}
        value={album.description}
        editable={editor}
        multiline
        placeholder={$t('frameleaf_album_add_description')}
        onSave={(description) => save({ description }, $t('frameleaf_album_description_saved'))}
      />

      <div class="summary">
        <span>{$t('frameleaf_albums_items', { values: { count: assetCount } })}</span>
        {#if span}
          <span class="dot" aria-hidden="true"></span>
          <span>{span}</span>
        {/if}
        <span class="dot" aria-hidden="true"></span>
        {#if others.length > 0}
          <button type="button" class="members" onclick={() => (shareOpen = true)}>
            <AlbumAvatarStack users={others} />
            <span>{$t('frameleaf_album_shared_with_count', { values: { count: others.length } })}</span>
          </button>
        {:else if owner}
          <button type="button" class="members" onclick={() => (shareOpen = true)}>
            <span aria-hidden="true"><Icon icon={mdiAccountPlusOutline} size="16" /></span>
            <span>{$t('frameleaf_album_private_share_it')}</span>
          </button>
        {:else}
          <span>{$t('frameleaf_album_private')}</span>
        {/if}
        {#if likeCount + commentCount > 0}
          <span class="dot" aria-hidden="true"></span>
          <span>
            {$t('frameleaf_album_activity_summary', { values: { likes: likeCount, comments: commentCount } })}
          </span>
        {/if}
      </div>
    </div>
  </div>

  <div class="actions" role="toolbar" aria-label={$t('frameleaf_album_actions', { values: { kind: kindLabel } })}>
    {#if editor && isCollection}
      <button type="button" class="action primary" onclick={() => (createOpen = true)}>
        <Icon icon={mdiPlus} size="18" />
        <span>{$t('frameleaf_albums_create_album')}</span>
      </button>
    {:else if editor && !album.isSmart}
      <Menu label={$t('add_photos')} align="start">
        {#snippet trigger()}
          <span class="trigger-content"><Icon icon={mdiPlus} size="18" />{$t('add_photos')}</span>
        {/snippet}
        <MenuItem onSelect={() => onAddPhotos?.()}>
          <Icon icon={mdiImageMultipleOutline} size="18" />
          {$t('select_photos')}
        </MenuItem>
        <MenuItem onSelect={() => void upload()}>
          <Icon icon={mdiUpload} size="18" />
          {$t('select_from_computer')}
        </MenuItem>
      </Menu>
    {/if}

    <button type="button" class="action" onclick={() => (shareOpen = true)}>
      <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" />
      <span>{owner ? $t('share') : $t('frameleaf_albums_members')}</span>
    </button>

    {#if owner}
      <button
        type="button"
        class="action"
        onclick={() => void openLinks()}
      >
        <Icon icon={mdiLinkVariant} size="18" />
        <span>{$t('shared_links')}</span>
      </button>
    {/if}

    {#if mapEnabled}
      <button type="button" class="action" disabled={mapMarkers.length === 0} onclick={() => void openMap()}>
        <Icon icon={mdiMapOutline} size="18" />
        <span>{$t('map')}</span>
      </button>
    {/if}

    <button type="button" class="action" disabled={assetCount === 0} onclick={() => onSlideshow?.()}>
      <Icon icon={mdiPlayCircleOutline} size="18" />
      <span>{$t('slideshow')}</span>
    </button>

    <button type="button" class="action" disabled={assetCount === 0} onclick={() => void handleDownloadAlbum(album)}>
      <Icon icon={mdiDownloadOutline} size="18" />
      <span>{$t('download')}</span>
    </button>

    {#if others.length > 0}
      <button type="button" class="action" aria-pressed={activityOpen} onclick={() => onToggleActivity?.()}>
        <Icon icon={mdiCommentTextOutline} size="18" />
        <span>{$t('activity')}</span>
        {#if likeCount + commentCount > 0}
          <span class="count">{likeCount + commentCount}</span>
        {/if}
      </button>
    {/if}

    <span class="spacer"></span>

    <Menu label={$t('frameleaf_album_more_actions')} align="end">
      {#snippet trigger()}
        <span class="trigger-content"><Icon icon={mdiDotsHorizontal} size="18" /></span>
      {/snippet}
      {#if canShowOwnerBadges}
        <MenuItem checked={ownerBadges} onSelect={() => onToggleOwnerBadges?.()}>
          <Icon icon={mdiAccountCircleOutline} size="18" />
          {$t('frameleaf_album_owner_badges')}
        </MenuItem>
      {/if}
      {#if editor && !album.isSmart}
        <MenuItem disabled={coverSourceIds.length === 0} onSelect={() => (coverOpen = true)}>
          <Icon icon={mdiImageOutline} size="18" />
          {$t('frameleaf_album_cover_title')}
        </MenuItem>
      {/if}
      {#if editor}
        <MenuItem onSelect={() => (optionsOpen = true)}>
          <Icon icon={mdiTuneVariant} size="18" />
          {$t('options')}
        </MenuItem>
      {/if}
      {#if owner}
        <MenuItem onSelect={() => (deleteOpen = true)}>
          <Icon icon={mdiDeleteOutline} size="18" />
          {$t('frameleaf_album_delete', { values: { kind: kindLabel } })}
        </MenuItem>
      {:else}
        <MenuItem onSelect={() => (leaveOpen = true)}>
          <Icon icon={mdiLogoutVariant} size="18" />
          {$t('frameleaf_album_leave', { values: { kind: kindLabel } })}
        </MenuItem>
      {/if}
    </Menu>
  </div>

  <p class="status" role="status" aria-live="polite">{status}</p>

  {#if isCollection}
    <section class="strip" aria-label={$t('albums')}>
      <div class="strip-head">
        <h2>{$t('albums')}</h2>
        <small>{$t('frameleaf_albums_count', { values: { count: childAlbums.length } })}</small>
      </div>
      <div class="strip-grid">
        {#each childAlbums as child (child.id)}
          <AlbumTile album={child} {currentUserId} />
        {/each}
        {#if editor}
          <button type="button" class="new-tile" onclick={() => (createOpen = true)}>
            <Icon icon={mdiPlus} size="22" />
            <span>{$t('frameleaf_albums_create_album')}</span>
          </button>
        {/if}
      </div>
      {#if childAlbums.length === 0 && !editor}
        <p class="empty">{$t('frameleaf_albums_shelf_empty')}</p>
      {/if}
    </section>
  {/if}
</header>

<AlbumShareDialog {album} bind:open={shareOpen} onChanged={onRefresh} onLeave={() => (leaveOpen = true)} />
<AlbumCoverDialog {album} albumIds={coverSourceIds} bind:open={coverOpen} onUpdated={onAlbumChange} />
<AlbumOptionsDialog {album} bind:open={optionsOpen} onUpdated={onAlbumChange} />
<SharedLinkForm bind:open={linkFormOpen} target={linkTarget} />

<AlbumCreateDialog
  kind={AlbumKind.Album}
  collections={collections.length > 0 ? collections : [album]}
  defaultParentId={album.id}
  bind:open={createOpen}
  onCreate={createChildAlbum}
/>

<AlbumConfirmDialog
  title={$t('frameleaf_album_delete_title', { values: { name } })}
  body={isCollection
    ? $t('frameleaf_album_delete_collection_body')
    : $t('frameleaf_album_delete_body', { values: { kind: kindLabel } })}
  keepNote={isCollection
    ? $t('frameleaf_album_delete_collection_keep', { values: { count: childAlbums.length } })
    : $t('frameleaf_album_delete_keep', { values: { count: assetCount } })}
  confirmLabel={$t('frameleaf_album_delete', { values: { kind: kindLabel } })}
  bind:open={deleteOpen}
  onConfirm={confirmDelete}
/>

<AlbumConfirmDialog
  title={$t('frameleaf_album_leave_title', { values: { name } })}
  body={$t('frameleaf_album_leave_body')}
  confirmLabel={$t('frameleaf_album_leave', { values: { kind: kindLabel } })}
  bind:open={leaveOpen}
  onConfirm={confirmLeave}
/>

<style>
  .album-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-block: 1rem;
    color: var(--fl-text);
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
    border-radius: 999px;
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
  .action.primary {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .action[aria-pressed='true']:not(.primary) {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .action:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .count {
    padding: 0 0.375rem;
    font-size: 0.75rem;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-radius: 999px;
  }
  .spacer {
    flex: 1;
  }
  .status {
    margin: 0;
    min-block-size: 1rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .strip {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-block-start: 0.5rem;
    border-block-start: 1px solid var(--fl-border);
  }
  .strip-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .strip-head h2 {
    margin: 0;
    font-size: 0.875rem;
  }
  .strip-head small {
    color: var(--fl-muted);
  }
  .strip-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
    gap: 0.75rem;
  }
  .new-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    aspect-ratio: 1;
    font: inherit;
    color: var(--fl-muted);
    background: transparent;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .new-tile:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  @media (max-width: 40rem) {
    .action span {
      display: none;
    }
  }
</style>
