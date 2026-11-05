<script lang="ts">
  import { goto } from '$app/navigation';
  import type AlbumActions from '$lib/components/frameleaf/AlbumActions.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import { canEdit, isOwner } from '$lib/frameleaf/album-directory';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { AlbumKind, type AlbumResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiArrowCollapseUp,
    mdiAutoFix,
    mdiDeleteOutline,
    mdiFolderMoveOutline,
    mdiFolderMultiplePlusOutline,
    mdiFolderPlusOutline,
    mdiLinkVariant,
    mdiLogoutVariant,
    mdiPaletteOutline,
    mdiPencilOutline,
    mdiPlus,
    mdiRenameOutline,
    mdiUpload,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The sidebar's right-click menu (approved design, 2026-11-04, RailAlbumMenu.jsx): on an album,
   * collection or shared space, the useful commands for it, opened in place through the same
   * dialogs as the Albums page (AlbumActions); on the Albums or Shared spaces heading, what can be
   * created there. Rename happens in the sidebar row itself (`onRename`).
   */
  interface Props {
    /** Every album, collection and space the sidebar shows, as the server sent them. */
    albums: AlbumResponseDto[];
    onRename: (id: string) => void;
    onRefresh: () => Promise<void> | void;
  }

  let { albums, onRename, onRefresh }: Props = $props();

  type Target = { album: AlbumResponseDto } | { section: 'albums' | 'spaces' };
  let target = $state<Target | null>(null);
  let at = $state<{ x: number; y: number } | null>(null);
  let actions: AlbumActions | undefined = $state();
  // The dialogs (and the icon catalogue they read) load the first time a menu opens, not with every page.
  let used = $state(false);
  // A command chosen before they have loaded runs as soon as they are there.
  let pending: ((loaded: AlbumActions) => unknown) | null = null;
  const run = (command: (loaded: AlbumActions) => unknown) => {
    if (actions) {
      void command(actions);
    } else {
      pending = command;
    }
  };
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
    albums: albums.filter(({ kind }) => kind !== AlbumKind.Space),
    spaces: albums.filter(({ kind }) => kind === AlbumKind.Space),
  });
  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');

  /** Opens the menu for the album with this id at the point; false when the sidebar does not know it. */
  export const openFor = (id: string, point: { x: number; y: number }) => {
    const album = albums.find((candidate) => candidate.id === id);
    if (!album) {
      return false;
    }
    target = { album };
    at = point;
    used = true;
    return true;
  };
  export const openHeading = (section: 'albums' | 'spaces', point: { x: number; y: number }) => {
    target = { section };
    at = point;
    used = true;
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
    {#if editor && !space}
      <MenuItem onSelect={() => run((loaded) => loaded.appearance(album, hasChildren))}>
        <Icon icon={mdiPaletteOutline} size="18" aria-hidden={true} />{$t('frameleaf_album_color_menu')}
      </MenuItem>
    {/if}
    {#if editor}
      <MenuItem onSelect={() => run((loaded) => loaded.edit(album))}>
        <Icon icon={mdiPencilOutline} size="18" aria-hidden={true} />
        {album.smartRuleId ? $t('frameleaf_albums_edit_rules') : $t('frameleaf_album_edit_details')}
      </MenuItem>
    {/if}
    {#if owner && !space}
      <MenuItem onSelect={() => run((loaded) => loaded.openMove(album))}>
        <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_move_to')}
      </MenuItem>
      {#if parent}
        <MenuItem onSelect={() => run((loaded) => loaded.move(album, null))}>
          <Icon icon={mdiArrowCollapseUp} size="18" aria-hidden={true} />
          {$t('frameleaf_albums_take_out', { values: { name: nameOf(parent) } })}
        </MenuItem>
      {/if}
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
      <MenuItem onSelect={() => run((loaded) => loaded.share(album))}>
        <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" aria-hidden={true} />
        {owner ? $t('share') : $t('frameleaf_albums_members')}
      </MenuItem>
    {/if}
    {#if owner}
      <MenuItem onSelect={() => run((loaded) => loaded.link(album))}>
        <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_link')}
      </MenuItem>
    {/if}
    <div class="menu-separator" role="separator"></div>
    {#if owner}
      <MenuItem onSelect={() => run((loaded) => loaded.remove(album))}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden={true} />{$t('delete')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => run((loaded) => loaded.leave(album))}>
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
