<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumMoveDialog from '$lib/components/frameleaf/AlbumMoveDialog.svelte';
  import AlbumShareDialog from '$lib/components/frameleaf/AlbumShareDialog.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import SmartAlbumReevaluateDialog from '$lib/components/frameleaf/SmartAlbumReevaluateDialog.svelte';
  import SmartAlbumRuleDialog from '$lib/components/frameleaf/SmartAlbumRuleDialog.svelte';
  import {
    canEdit,
    directoryAlbums,
    isOwner,
    moveTargets,
    type AlbumDetailsDraft,
  } from '$lib/frameleaf/album-directory';
  import { loadRuleSources, type RuleSources } from '$lib/frameleaf/classification-sources';
  import { searchContextFor } from '$lib/frameleaf/search-context';
  import { toastUndo } from '$lib/frameleaf/toast';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import SmartAlbumReevaluateModal from '$lib/modals/SmartAlbumReevaluateModal.svelte';
  import { Route } from '$lib/route';
  import {
    handleCreateAlbumEntry,
    handleDeleteAlbum,
    handleEditAlbumDetails,
    handleLeaveAlbum,
    handleMoveAlbumToCollection,
    handleUpdateAlbumInfo,
  } from '$lib/services/album.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumKind,
    LibraryScope,
    LibraryViewScope,
    SharedLinkType,
    createClassificationRule,
    getClassificationRule,
    type AlbumResponseDto,
    type AlbumTreeResponseDto,
    type ClassificationRuleCreateDto,
    type ClassificationRuleResponseDto,
    type CreateAlbumDto,
  } from '@frameleaf/sdk';
  import { modalManager, toastManager } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';

  /**
   * The album commands and their dialogs, shared by the Albums page (FL-52) and the sidebar's
   * right-click menu (approved design, 2026-11-04), so both open the same dialogs in place: create
   * (inside another album or collection), edit details or a smart album's rules, re-evaluate, move,
   * share, create a link, delete and leave. The caller lists the commands; this does them.
   */
  interface Props {
    /** The directory the dialogs choose from (move targets, parents, counts). */
    tree: AlbumTreeResponseDto | undefined;
    /** Re-fetch after a change. */
    onRefresh: () => Promise<void> | void;
    /** The server refused a change made from an outdated directory. */
    onStale?: () => void;
    /** Says what an action did; `undo` puts it back. Defaults to a toast. */
    announce?: (message: string, undo?: () => unknown) => void;
  }

  let {
    tree,
    onRefresh,
    onStale,
    announce = (message, undo) => (undo ? toastUndo(message, undo) : toastManager.primary(message)),
  }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const everything = $derived(tree ? directoryAlbums(tree) : []);
  const editableCollections = $derived(
    everything.filter((album) => album.kind !== AlbumKind.Space && canEdit(album, currentUserId)),
  );
  /** Where "Move to…" may put an album: every album or collection the user can edit. */
  const moveCandidates = $derived(editableCollections);
  const find = (id: string) => everything.find((album) => album.id === id);
  const isSpace = (album: AlbumResponseDto) => album.kind === AlbumKind.Space;
  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');
  const kindOf = (album: AlbumResponseDto) =>
    album.kind === AlbumKind.Collection
      ? $t('frameleaf_album_kind_collection')
      : isSpace(album)
        ? $t('frameleaf_album_kind_space')
        : $t('frameleaf_album_kind_album');
  const albumCountOf = (album: AlbumResponseDto) => everything.filter(({ parentId }) => parentId === album.id).length;

  let busy = $state(false);
  let createDialog = $state<{ open: boolean; kind: AlbumKind; parentId: string | null; smart: boolean }>({
    open: false,
    kind: AlbumKind.Album,
    parentId: null,
    smart: false,
  });
  let moveDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let deleteDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let leaveDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let lockDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let linkDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let editDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let shareDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let reevaluate = $state<{ open: boolean; rule?: ClassificationRuleResponseDto; sources: RuleSources }>({
    open: false,
    sources: { people: [], tags: [] },
  });
  let ruleEdit = $state<{
    open: boolean;
    album?: AlbumResponseDto;
    rule?: ClassificationRuleResponseDto;
    sources: RuleSources;
  }>({ open: false, sources: { people: [], tags: [] } });

  const refresh = async () => {
    await onRefresh();
  };
  const designScope = () =>
    searchContextFor(new URL(page.url.href)).query.filter.libraryScope === LibraryViewScope.Design;

  /** New album, smart album, collection or shared space; `parentId` puts it inside that album. */
  export const create = (kind: AlbumKind, parentId: string | null = null, smart = false) => {
    createDialog = { open: true, kind, parentId, smart };
  };

  const createAlbum = async (dto: CreateAlbumDto) => {
    busy = true;
    try {
      const album = await handleCreateAlbumEntry({
        ...dto,
        ...(designScope() && { libraryScope: LibraryScope.Design }),
      });
      if (!album) {
        return false;
      }
      // Stay on the page and say what happened (Collections.jsx); the new album is in the refreshed tree.
      announce($t('frameleaf_albums_created', { values: { name: nameOf(album) } }));
      await refresh();
      return true;
    } finally {
      busy = false;
    }
  };

  /** A smart album and its rule are created together (FL-60); nothing is matched until it is applied. */
  const createSmart = async (dto: ClassificationRuleCreateDto) => {
    busy = true;
    try {
      const rule = await createClassificationRule({
        classificationRuleCreateDto: {
          ...dto,
          ...(designScope() && { filter: { ...dto.filter, libraryScope: LibraryViewScope.Design } }),
        },
      });
      announce($t('frameleaf_albums_created', { values: { name: rule.albumName } }));
      await goto(Route.viewAlbum({ id: rule.albumId }));
      return true;
    } catch (error) {
      handleError(error, $t('frameleaf_rules_create_failed'));
      return false;
    } finally {
      busy = false;
    }
  };

  /**
   * Re-evaluate a rule-backed smart album in place; a built-in one runs the server check scoped to its
   * own kind (AL-6), and only an album with no known kind falls back to every enabled kind.
   */
  export const openReevaluate = async (album: AlbumResponseDto) => {
    if (!album.smartRuleId) {
      void modalManager.show(
        SmartAlbumReevaluateModal,
        album.smartKind ? { kind: album.smartKind, kindLabel: album.albumName } : {},
      );
      return;
    }
    try {
      const [rule, sources] = await Promise.all([getClassificationRule({ id: album.smartRuleId }), loadRuleSources()]);
      reevaluate = { open: true, rule, sources };
    } catch (error) {
      handleError(error, $t('frameleaf_rules_plan_failed'));
    }
  };

  /** Puts an album inside `parentId`, or at the top level (`null`), and says so with Undo. */
  export const move = async (album: AlbumResponseDto, parentId: string | null, undoable = true) => {
    if (album.parentId === parentId) {
      return;
    }
    const previousParentId = album.parentId ?? null;
    busy = true;
    try {
      const moved = await handleMoveAlbumToCollection(album, parentId);
      if (moved === 'stale') {
        onStale?.();
        moveDialog = { open: false };
        await refresh();
        return;
      }
      if (!moved) {
        return;
      }
      const destination = parentId ? find(parentId) : undefined;
      announce(
        destination
          ? $t('frameleaf_albums_moved_into', { values: { name: nameOf(album), collection: nameOf(destination) } })
          : $t('frameleaf_albums_moved_out', { values: { name: nameOf(album) } }),
        // Undo moves it back from where it now is; the refreshed tree has the album's new parent.
        undoable ? () => void move({ ...album, parentId }, previousParentId, false) : undefined,
      );
      moveDialog = { open: false };
      await refresh();
    } finally {
      busy = false;
    }
  };

  export const openMove = (album: AlbumResponseDto) => {
    moveDialog = { open: true, album };
  };

  /** Delete and Leave confirm in the Frameleaf dialog (AlbumConfirmDialog), as the album header does. */
  export const remove = (album: AlbumResponseDto) => {
    deleteDialog = { open: true, album };
  };
  export const leave = (album: AlbumResponseDto) => {
    leaveDialog = { open: true, album };
  };

  const confirmDelete = async () => {
    const album = deleteDialog.album;
    if (!album) {
      return;
    }
    const ok = await handleDeleteAlbum(album, { notify: false });
    if (ok) {
      announce(
        album.kind === AlbumKind.Collection
          ? $t('frameleaf_albums_deleted_collection', { values: { name: nameOf(album) } })
          : $t('frameleaf_albums_deleted', { values: { name: nameOf(album) } }),
      );
    }
    await refresh();
  };

  const confirmLeave = async () => {
    const album = leaveDialog.album;
    if (!album) {
      return;
    }
    const left = await handleLeaveAlbum(album);
    if (left) {
      announce($t('frameleaf_albums_left', { values: { name: nameOf(album) } }));
    }
    await refresh();
  };

  const setLocked = async (album: AlbumResponseDto, isLocked: boolean) => {
    const message = $t(isLocked ? 'frameleaf_albums_locked' : 'frameleaf_albums_unlocked', {
      values: { name: nameOf(album) },
    });
    if (await handleUpdateAlbumInfo(album.id, { isLocked }, { message })) {
      await refresh();
    }
  };
  /** FL-1296: locking moves the owner's items into Locked, so it asks first; unlocking moves nothing. */
  export const toggleLock = (album: AlbumResponseDto) => {
    if (album.isLocked) {
      void setLocked(album, false);
      return;
    }
    lockDialog = { open: true, album };
  };

  /** Details (name, description, icon, colour, parent), or a smart album's rules (FL-60). */
  export const edit = async (album: AlbumResponseDto) => {
    if (album.smartRuleId) {
      try {
        const [rule, sources] = await Promise.all([
          getClassificationRule({ id: album.smartRuleId }),
          loadRuleSources(),
        ]);
        ruleEdit = { open: true, album, rule, sources };
      } catch (error) {
        handleError(error, $t('frameleaf_rules_save_failed'));
      }
      return;
    }
    editDialog = { open: true, album };
  };

  /** The Frameleaf edit dialog (`CollectionFormDialog`); the tree refreshes on `AlbumUpdate`. */
  const saveDetails = async (draft: AlbumDetailsDraft) => {
    const album = editDialog.album;
    if (!album) {
      return false;
    }
    const saved = await handleEditAlbumDetails(album, draft);
    if (saved) {
      announce($t('frameleaf_albums_saved', { values: { name: nameOf(saved) } }));
    }
    return !!saved;
  };

  /** Members and roles in the Frameleaf share dialog (`ShareDialog`), as the album header does. */
  export const share = (album: AlbumResponseDto) => {
    shareDialog = { open: true, album };
  };

  export const link = (album: AlbumResponseDto) => {
    linkDialog = { open: true, album };
  };

  /** "Icon and colour…", as the album header has it; the sidebar and pickers follow on `AlbumUpdate`. */
  let appearanceDialog = $state<{ open: boolean; album?: AlbumResponseDto; hasChildren: boolean }>({
    open: false,
    hasChildren: false,
  });
  export const appearance = (album: AlbumResponseDto, hasChildren = false) => {
    appearanceDialog = { open: true, album, hasChildren };
  };
  const saveAppearance = async ({ icon, color }: { icon: string | null; color: string | null }) => {
    const album = appearanceDialog.album;
    return (
      !!album &&
      !!(await handleUpdateAlbumInfo(album.id, { icon, color }, { message: $t('frameleaf_album_color_saved') }))
    );
  };
</script>

<AlbumCreateDialog
  bind:open={createDialog.open}
  kind={createDialog.kind}
  collections={editableCollections}
  defaultParentId={createDialog.parentId}
  smart={createDialog.smart}
  onCreate={createAlbum}
  onCreateSmart={createSmart}
/>

{#if moveDialog.album}
  <AlbumMoveDialog
    bind:open={moveDialog.open}
    album={moveDialog.album}
    albums={moveCandidates}
    {busy}
    onMove={(parentId) => moveDialog.album && void move(moveDialog.album, parentId)}
  />
{/if}

{#if deleteDialog.album}
  {@const album = deleteDialog.album}
  <AlbumConfirmDialog
    title={$t('frameleaf_album_delete_title', { values: { name: nameOf(album) } })}
    body={album.kind === AlbumKind.Collection
      ? $t('frameleaf_album_delete_collection_body')
      : isSpace(album)
        ? $t('frameleaf_album_delete_space_body')
        : $t('frameleaf_album_delete_body', { values: { kind: kindOf(album) } })}
    keepNote={album.kind === AlbumKind.Collection
      ? $t('frameleaf_album_delete_collection_keep', { values: { count: albumCountOf(album) } })
      : $t('frameleaf_album_delete_keep', { values: { count: album.assetCount } })}
    confirmLabel={$t('frameleaf_album_delete', { values: { kind: kindOf(album) } })}
    bind:open={deleteDialog.open}
    onConfirm={confirmDelete}
  />
{/if}

{#if leaveDialog.album}
  {@const album = leaveDialog.album}
  <AlbumConfirmDialog
    title={$t('frameleaf_album_leave_title', { values: { name: nameOf(album) } })}
    body={$t('frameleaf_album_leave_body')}
    confirmLabel={$t('frameleaf_album_leave', { values: { kind: kindOf(album) } })}
    bind:open={leaveDialog.open}
    onConfirm={confirmLeave}
  />
{/if}

{#if lockDialog.album}
  {@const album = lockDialog.album}
  <AlbumConfirmDialog
    title={$t('frameleaf_album_lock_title', { values: { name: nameOf(album) } })}
    body={$t('frameleaf_album_lock_body')}
    confirmLabel={$t('frameleaf_album_options_locked')}
    bind:open={lockDialog.open}
    onConfirm={() => setLocked(album, true)}
  />
{/if}

{#if editDialog.album}
  <AlbumCreateDialog
    bind:open={editDialog.open}
    kind={editDialog.album.kind}
    album={editDialog.album}
    collections={tree
      ? moveTargets(tree, editDialog.album, currentUserId).map(({ collection }) => collection)
      : editableCollections}
    canMove={editDialog.album.kind !== AlbumKind.Space && isOwner(editDialog.album, currentUserId)}
    onCreate={createAlbum}
    onSave={saveDetails}
  />
{/if}
{#if shareDialog.album}
  {@const album = find(shareDialog.album.id) ?? shareDialog.album}
  <AlbumShareDialog {album} bind:open={shareDialog.open} onChanged={refresh} onLeave={() => leave(album)} />
{/if}
{#if linkDialog.album}
  <SharedLinkForm
    bind:open={linkDialog.open}
    target={{
      type: SharedLinkType.Album,
      albumId: linkDialog.album.id,
      name: nameOf(linkDialog.album),
      previewAssetIds: linkDialog.album.albumThumbnailAssetId ? [linkDialog.album.albumThumbnailAssetId] : [],
      count: linkDialog.album.assetCount,
    }}
  />
{/if}

{#if ruleEdit.rule && ruleEdit.album}
  <SmartAlbumRuleDialog
    album={ruleEdit.album}
    rule={ruleEdit.rule}
    sources={ruleEdit.sources}
    bind:open={ruleEdit.open}
    onSaved={(_saved, message) => {
      announce(message);
      void refresh();
    }}
  />
{/if}

{#if appearanceDialog.album}{#await import('$lib/components/frameleaf/AlbumAppearanceDialog.svelte') then { default: AlbumAppearanceDialog }}
    <AlbumAppearanceDialog
      album={appearanceDialog.album}
      hasChildren={appearanceDialog.hasChildren}
      bind:open={appearanceDialog.open}
      onSave={saveAppearance}
    />
  {/await}{/if}

{#if reevaluate.rule}
  <SmartAlbumReevaluateDialog
    rule={reevaluate.rule}
    sources={reevaluate.sources}
    bind:open={reevaluate.open}
    onApplied={(message) => {
      announce(message);
      void refresh();
    }}
  />
{/if}
