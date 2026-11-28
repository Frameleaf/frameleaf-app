<script lang="ts">
  import { goto } from '$app/navigation';
  import type AlbumActions from '$lib/components/frameleaf/AlbumActions.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import { canEdit, canMerge, isOwner } from '$lib/frameleaf/album-directory';
  import { pendingPins, togglePinned } from '$lib/frameleaf/pinned-albums';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { AlbumKind, getAlbumInfo, type AlbumRailItemDto, type AlbumResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiArrowCollapseUp,
    mdiAutoFix,
    mdiCallMerge,
    mdiDeleteOutline,
    mdiFolderMoveOutline,
    mdiFolderMultiplePlusOutline,
    mdiFolderPlusOutline,
    mdiLinkVariant,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiLogoutVariant,
    mdiPaletteOutline,
    mdiPencilOutline,
    mdiPin,
    mdiPinOff,
    mdiPlus,
    mdiRenameOutline,
    mdiUpload,
  } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The sidebar's right-click menu (approved design, 2026-11-04, RailAlbumMenu.jsx): on an album,
   * collection or shared space, the useful commands for it, opened in place through the same
   * dialogs as the Albums page (AlbumActions); on the Albums or Shared spaces heading, what can be
   * created there. Rename happens in the sidebar row itself (`onRename`).
   */
  interface Props {
    /** Every album, collection and space the sidebar shows, from the slim rail list (FL-1796). */
    albums: AlbumRailItemDto[];
    /**
     * The same albums in full (members, links, origin), which the dialogs need. Asked for when a menu
     * opens; a command waits for it.
     */
    fullAlbums: () => Promise<AlbumResponseDto[]>;
    onRename: (id: string) => void;
    onRefresh: () => Promise<void> | void;
  }

  let { albums, fullAlbums, onRename, onRefresh }: Props = $props();

  type Target = { album: AlbumRailItemDto } | { section: 'albums' | 'spaces' };
  /** The full albums once read, for the dialogs and for what only they tell (a partner copy cannot merge). */
  let full = $state<AlbumResponseDto[] | null>(null);
  let fullRequest: Promise<AlbumResponseDto[]> | null = null;
  const loadFull = () => {
    fullRequest ??= fullAlbums()
      .then((albums) => (full = albums))
      .catch((error: unknown) => {
        fullRequest = null;
        throw error;
      });
    return fullRequest;
  };
  // A new list from the server means the full albums are read again. What was read stays until the new
  // answer arrives, so a dialog that is open keeps its lists.
  $effect(() => {
    void albums;
    untrack(() => {
      fullRequest = null;
      if (full) {
        void loadFull().catch(() => {});
      }
    });
  });
  let target = $state<Target | null>(null);
  let at = $state<{ x: number; y: number } | null>(null);
  let actions: AlbumActions | undefined = $state();
  // The dialogs (and the icon catalogue they read) load the first time a menu opens, not with every page.
  let used = $state(false);
  // A command chosen before they have loaded runs as soon as they are there.
  let pending: ((loaded: AlbumActions) => unknown) | null = null;
  const start = (command: (loaded: AlbumActions) => unknown) => {
    if (actions) {
      void command(actions);
    } else {
      pending = command;
    }
  };
  /** A command on the album the menu is open for: it gets the full album, read first if need be. */
  const runFor = (id: string, command: (loaded: AlbumActions, album: AlbumResponseDto) => unknown) =>
    void loadFull()
      .then((albums) => {
        // An album the full list does not hold yet (just created, or read a moment apart) is read on its own.
        const known = albums.find((candidate) => candidate.id === id);
        return Promise.resolve(known ?? getAlbumInfo({ id })).then((album) =>
          start((loaded) => command(loaded, album)),
        );
      })
      .catch((error: unknown) => handleError(error, $t('errors.frameleaf_unable_to_load_albums')));
  /** A command that needs no album (create), or only the directory the dialogs choose from. */
  const run = (command: (loaded: AlbumActions) => unknown) =>
    void loadFull()
      .catch(() => [])
      .then(() => start(command));
  $effect(() => {
    if (actions && pending) {
      const command = pending;
      pending = null;
      void command(actions);
    }
  });

  const currentUserId = $derived(authManager.user.id);
  // The dialogs choose parents and move targets by `parentId`, so the flat list serves as the directory.
  const tree = $derived({
    collections: [],
    albums: (full ?? []).filter(({ kind }) => kind !== AlbumKind.Space),
    spaces: (full ?? []).filter(({ kind }) => kind === AlbumKind.Space),
  });
  const nameOf = (album: { albumName: string } | undefined) => album?.albumName || $t('unnamed_album');

  /** Opens the menu for the album with this id at the point; false when the sidebar does not know it. */
  export const openFor = (id: string, point: { x: number; y: number }) => {
    const album = albums.find((candidate) => candidate.id === id);
    if (!album) {
      return false;
    }
    target = { album };
    at = point;
    used = true;
    void loadFull().catch(() => {
      // a command asks again, and says so if it still fails
    });
    return true;
  };
  export const openHeading = (section: 'albums' | 'spaces', point: { x: number; y: number }) => {
    target = { section };
    at = point;
    used = true;
    void loadFull().catch(() => {});
  };

  const label = $derived(
    target && 'album' in target
      ? $t('frameleaf_albums_actions_for', { values: { name: nameOf(target.album) } })
      : $t('frameleaf_albums_new'),
  );
</script>

<Menu {label} hideTrigger bind:at>
  {#if target && 'album' in target}
    {@const album = target.album}
    {@const owner = isOwner(album, currentUserId)}
    {@const editor = canEdit(album, currentUserId)}
    {@const space = album.kind === AlbumKind.Space}
    {@const parent = album.parentId ? albums.find(({ id }) => id === album.parentId) : undefined}
    {@const hasChildren = albums.some(({ parentId }) => parentId === album.id)}
    {@const isPinned = (
      $pendingPins ??
      (authManager.authenticated ? authManager.preferences.albums.pinned : undefined) ??
      []
    ).includes(album.id)}
    {#if editor && !space}
      <MenuItem onSelect={() => run((loaded) => loaded.create(AlbumKind.Album, album.id))}>
        <Icon icon={mdiPlus} size="18" aria-hidden={true} />
        {$t('frameleaf_albums_new_album_in', { values: { name: nameOf(album) } })}
      </MenuItem>
      {#if album.kind === AlbumKind.Collection}
        <MenuItem onSelect={() => run((loaded) => loaded.create(AlbumKind.Album, album.id, true))}>
          <Icon icon={mdiAutoFix} size="18" aria-hidden={true} />
          {$t('frameleaf_albums_new_smart_in', { values: { name: nameOf(album) } })}
        </MenuItem>
      {/if}
      <div class="menu-separator" role="separator"></div>
    {/if}
    {#if editor}
      <MenuItem onSelect={() => onRename(album.id)}>
        <Icon icon={mdiRenameOutline} size="18" aria-hidden={true} />{$t('rename')}
      </MenuItem>
    {/if}
    <!-- Unpin where the pin shows: the Albums page hides an empty pinned album, so it could not be unpinned there. -->
    <MenuItem onSelect={() => void togglePinned(album.id)}>
      <Icon icon={isPinned ? mdiPinOff : mdiPin} size="18" aria-hidden={true} />
      {isPinned ? $t('frameleaf_albums_unpin') : $t('frameleaf_albums_pin')}
    </MenuItem>
    {#if editor && !space}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.appearance(album, hasChildren))}>
        <Icon icon={mdiPaletteOutline} size="18" aria-hidden={true} />{$t('frameleaf_album_color_menu')}
      </MenuItem>
    {/if}
    {#if editor}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.edit(album))}>
        <Icon icon={mdiPencilOutline} size="18" aria-hidden={true} />
        {album.smartRuleId ? $t('frameleaf_albums_edit_rules') : $t('frameleaf_album_edit_details')}
      </MenuItem>
    {/if}
    {#if owner && !space}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.openMove(album))}>
        <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_move_to')}
      </MenuItem>
      {@const fullAlbum = full?.find(({ id }) => id === album.id)}
      <!-- Only the full album says whether this is a partner's copy, which cannot merge. Until it is read the
           entry holds its place, so nothing below it moves under the pointer. -->
      {#if fullAlbum ? canMerge(fullAlbum, currentUserId) : album.kind === AlbumKind.Album && !album.isSmart}
        <MenuItem disabled={!fullAlbum} onSelect={() => runFor(album.id, (loaded, album) => loaded.openMerge(album))}>
          <Icon icon={mdiCallMerge} size="18" aria-hidden={true} />{$t('frameleaf_albums_merge_with')}
        </MenuItem>
      {/if}
      {#if parent}
        <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.move(album, null))}>
          <Icon icon={mdiArrowCollapseUp} size="18" aria-hidden={true} />
          {$t('frameleaf_albums_take_out', { values: { name: nameOf(parent) } })}
        </MenuItem>
      {/if}
    {/if}
    {#if owner && album.kind === AlbumKind.Album}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.toggleLock(album))}>
        <Icon icon={album.isLocked ? mdiLockOpenVariantOutline : mdiLockOutline} size="18" aria-hidden={true} />
        {album.isLocked ? $t('frameleaf_albums_unlock') : $t('frameleaf_albums_lock')}
      </MenuItem>
    {/if}
    {#if editor && album.kind === AlbumKind.Album && !album.isSmart}
      <MenuItem onSelect={() => void openFileUploadDialog({ albumId: album.id })}>
        <Icon icon={mdiUpload} size="18" aria-hidden={true} />{$t('frameleaf_albums_upload')}
      </MenuItem>
    {/if}
    <div class="menu-separator" role="separator"></div>
    {#if space}
      <!-- A space's people are invitations and roles, managed on the space's own Members panel. -->
      <MenuItem onSelect={() => goto(`${Route.viewSharedSpace({ id: album.id })}?panel=members`)}>
        <Icon icon={mdiAccountMultipleOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_members')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.share(album))}>
        <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" aria-hidden={true} />
        {owner ? $t('share') : $t('frameleaf_albums_members')}
      </MenuItem>
    {/if}
    {#if owner}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.link(album))}>
        <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_link')}
      </MenuItem>
    {/if}
    <div class="menu-separator" role="separator"></div>
    {#if owner}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.remove(album))}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden={true} />{$t('delete')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => runFor(album.id, (loaded, album) => loaded.leave(album))}>
        <Icon icon={mdiLogoutVariant} size="18" aria-hidden={true} />{$t('leave')}
      </MenuItem>
    {/if}
  {:else if target?.section === 'albums'}
    <MenuItem onSelect={() => run((loaded) => loaded.create(AlbumKind.Album))}>
      <Icon icon={mdiPlus} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_album')}
    </MenuItem>
    <MenuItem onSelect={() => run((loaded) => loaded.create(AlbumKind.Album, null, true))}>
      <Icon icon={mdiAutoFix} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_smart')}
    </MenuItem>
    <MenuItem onSelect={() => run((loaded) => loaded.create(AlbumKind.Collection))}>
      <Icon icon={mdiFolderMultiplePlusOutline} size="18" aria-hidden={true} />{$t(
        'frameleaf_albums_create_collection',
      )}
    </MenuItem>
  {:else if target?.section === 'spaces'}
    <MenuItem onSelect={() => run((loaded) => loaded.create(AlbumKind.Space))}>
      <Icon icon={mdiFolderPlusOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_space')}
    </MenuItem>
  {/if}
</Menu>

{#if used}{#await import('$lib/components/frameleaf/AlbumActions.svelte') then { default: LoadedAlbumActions }}
    <LoadedAlbumActions bind:this={actions} {tree} {onRefresh} />
  {/await}{/if}

<style>
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
</style>
