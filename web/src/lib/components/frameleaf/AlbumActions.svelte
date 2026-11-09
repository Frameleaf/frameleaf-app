<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumMergeDialog from '$lib/components/frameleaf/AlbumMergeDialog.svelte';
  import AlbumMergeIntoDialog from '$lib/components/frameleaf/AlbumMergeIntoDialog.svelte';
  import AlbumMoveDialog from '$lib/components/frameleaf/AlbumMoveDialog.svelte';
  import AlbumShareDialog from '$lib/components/frameleaf/AlbumShareDialog.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import SmartAlbumReevaluateDialog from '$lib/components/frameleaf/SmartAlbumReevaluateDialog.svelte';
  import SmartAlbumRuleDialog from '$lib/components/frameleaf/SmartAlbumRuleDialog.svelte';
  import {
    canEdit,
    canMerge,
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
    isHttpError,
    getClassificationRule,
    deleteAlbum,
    mergeAlbum,
    mergeAlbumsInto,
    moveAlbumToCollection,
    updateAlbumInfo,
    undoLatestAlbumChangeRun,
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
  const mergeCandidates = $derived(everything.filter((album) => canMerge(album, currentUserId)));
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
  let moveDialog = $state<{ open: boolean; albums: AlbumResponseDto[] }>({ open: false, albums: [] });
  let mergeIntoDialog = $state<{ open: boolean; albums: AlbumResponseDto[] }>({ open: false, albums: [] });
  let bulkDeleteDialog = $state<{ open: boolean; albums: AlbumResponseDto[] }>({ open: false, albums: [] });
  let bulkLockDialog = $state<{ open: boolean; albums: AlbumResponseDto[] }>({ open: false, albums: [] });
  let mergeDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
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
        moveDialog = { open: false, albums: [] };
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
      moveDialog = { open: false, albums: [] };
      await refresh();
    } finally {
      busy = false;
    }
  };

  export const openMove = (album: AlbumResponseDto) => {
    moveDialog = { open: true, albums: [album] };
  };

  /* ---- several albums chosen on the Albums page ---- */
  /**
   * Runs one change per album, then refreshes once. The SDK is called directly so the page is not
   * re-fetched after every album. Returns the albums it changed; a failure stops there and says so.
   * ponytail: one request per album; a bulk endpoint if people routinely pick hundreds.
   */
  const eachAlbum = async (albums: AlbumResponseDto[], change: (album: AlbumResponseDto) => Promise<unknown>) => {
    const done: AlbumResponseDto[] = [];
    busy = true;
    try {
      for (const album of albums) {
        await change(album);
        done.push(album);
      }
    } catch (error) {
      handleError(error, $t('frameleaf_albums_bulk_failed', { values: { done: done.length, count: albums.length } }));
    } finally {
      busy = false;
      await refresh();
    }
    return done;
  };

  export const openMoveMany = (albums: AlbumResponseDto[]) => {
    moveDialog = { open: true, albums };
  };
  /** Moves each chosen album that is not already there; Undo puts each back where it was. */
  const moveMany = async (albums: AlbumResponseDto[], parentId: string | null, undoable = true) => {
    const moving = albums.filter((album) => album.parentId !== parentId);
    const before = new Map(moving.map((album) => [album.id, album.parentId ?? null]));
    const moved = await eachAlbum(moving, (album) =>
      moveAlbumToCollection({
        id: album.id,
        moveAlbumDto: { collectionId: parentId, expectedParentId: album.parentId },
      }),
    );
    moveDialog = { open: false, albums: [] };
    if (moved.length === 0) {
      return;
    }
    const destination = parentId ? find(parentId) : undefined;
    announce(
      destination
        ? $t('frameleaf_albums_moved_many_into', { values: { count: moved.length, collection: nameOf(destination) } })
        : $t('frameleaf_albums_moved_many_out', { values: { count: moved.length } }),
      undoable
        ? async () => {
            // Each goes back to its own old parent; group them so every group is one moveMany.
            for (const previous of new Set(before.values())) {
              const group = moved
                .filter(({ id }) => before.get(id) === previous)
                .map((album) => ({ ...album, parentId }));
              await moveMany(group, previous, false);
            }
          }
        : undefined,
    );
  };

  export const openMergeInto = (albums: AlbumResponseDto[]) => {
    mergeIntoDialog = { open: true, albums };
  };
  const mergeInto = async (target: AlbumResponseDto, albums: AlbumResponseDto[]) => {
    const otherIds = albums.filter(({ id }) => id !== target.id).map(({ id }) => id);
    busy = true;
    try {
      const { runId } = await mergeAlbumsInto({ id: target.id, albumMergeIntoDto: { otherIds } });
      announce(
        $t('frameleaf_albums_merged_many', { values: { count: otherIds.length, winner: nameOf(target) } }),
        () => void undoMerge(runId),
      );
      mergeIntoDialog = { open: false, albums: [] };
      if (otherIds.some((id) => page.url.pathname.includes(id))) {
        await goto(Route.viewAlbum({ id: target.id }));
      }
      await refresh();
    } catch (error) {
      handleError(error, $t('frameleaf_albums_merge_failed'));
    } finally {
      busy = false;
    }
  };

  /** Locking asks first (it moves the owner's items into Locked); unlocking moves nothing. */
  export const lockMany = (albums: AlbumResponseDto[], isLocked: boolean) => {
    const changing = albums.filter((album) => album.isLocked !== isLocked);
    if (isLocked) {
      bulkLockDialog = { open: true, albums: changing };
      return;
    }
    void setLockedMany(changing, false);
  };
  const setLockedMany = async (albums: AlbumResponseDto[], isLocked: boolean) => {
    const done = await eachAlbum(albums, (album) => updateAlbumInfo({ id: album.id, updateAlbumDto: { isLocked } }));
    if (done.length > 0) {
      announce(
        $t(isLocked ? 'frameleaf_albums_locked_many' : 'frameleaf_albums_unlocked_many', {
          values: { count: done.length },
        }),
      );
    }
  };

  export const removeMany = (albums: AlbumResponseDto[]) => {
    bulkDeleteDialog = { open: true, albums };
  };
  const confirmDeleteMany = async () => {
    const done = await eachAlbum(bulkDeleteDialog.albums, (album) => deleteAlbum({ id: album.id }));
    if (done.length > 0) {
      announce($t('frameleaf_albums_deleted_many', { values: { count: done.length } }));
    }
  };

  export const openMerge = (album: AlbumResponseDto) => {
    mergeDialog = { open: true, album };
  };

  /** Puts a merge back. Anything changed since stays as it is, and the message says what was kept. */
  const undoMerge = async (runId: string) => {
    try {
      const { skipped } = await undoLatestAlbumChangeRun({ albumChangeUndoDto: { runId } });
      announce(
        skipped.length > 0
          ? $t('frameleaf_albums_merge_undone_kept', { values: { names: skipped.join(', ') } })
          : $t('frameleaf_albums_merge_undone'),
      );
      await refresh();
    } catch (error) {
      if (isHttpError(error) && error.status === 409) {
        announce($t('frameleaf_albums_merge_undo_newer'));
        return;
      }
      handleError(error, $t('frameleaf_albums_merge_undo_failed'));
    }
  };

  /** The server decides which album stays, again, in case the albums changed since the preview. */
  const merge = async (album: AlbumResponseDto, other: AlbumResponseDto) => {
    busy = true;
    try {
      const { winnerId, runId } = await mergeAlbum({ id: album.id, albumMergeDto: { otherId: other.id } });
      const [winner, loser] = winnerId === album.id ? [album, other] : [other, album];
      announce(
        $t('frameleaf_albums_merged', { values: { loser: nameOf(loser), winner: nameOf(winner) } }),
        () => void undoMerge(runId),
      );
      mergeDialog = { open: false };
      if (page.url.pathname.includes(loser.id)) {
        await goto(Route.viewAlbum({ id: winner.id }));
      }
      await refresh();
    } catch (error) {
      handleError(error, $t('frameleaf_albums_merge_failed'));
    } finally {
      busy = false;
    }
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

{#if moveDialog.albums.length > 0}
  {@const albums = moveDialog.albums}
  <AlbumMoveDialog
    bind:open={moveDialog.open}
    moving={albums}
    albums={moveCandidates}
    {busy}
    onMove={(parentId) => void (albums.length === 1 ? move(albums[0], parentId) : moveMany(albums, parentId))}
  />
{/if}

{#if mergeIntoDialog.albums.length > 0}
  {@const albums = mergeIntoDialog.albums}
  <AlbumMergeIntoDialog
    bind:open={mergeIntoDialog.open}
    merging={albums}
    albums={mergeCandidates}
    {busy}
    onMerge={(target) => mergeInto(target, albums)}
  />
{/if}

{#if bulkDeleteDialog.albums.length > 0}
  {@const count = bulkDeleteDialog.albums.length}
  <AlbumConfirmDialog
    title={$t('frameleaf_albums_delete_many_title', { values: { count } })}
    body={$t('frameleaf_albums_delete_many_body')}
    confirmLabel={$t('frameleaf_albums_delete_many', { values: { count } })}
    bind:open={bulkDeleteDialog.open}
    onConfirm={confirmDeleteMany}
  />
{/if}

{#if bulkLockDialog.albums.length > 0}
  {@const albums = bulkLockDialog.albums}
  <AlbumConfirmDialog
    title={$t('frameleaf_albums_lock_many_title', { values: { count: albums.length } })}
    body={$t('frameleaf_album_lock_body')}
    confirmLabel={$t('frameleaf_album_options_locked')}
    bind:open={bulkLockDialog.open}
    onConfirm={() => setLockedMany(albums, true)}
  />
{/if}

{#if mergeDialog.album}
  {@const album = mergeDialog.album}
  <AlbumMergeDialog
    bind:open={mergeDialog.open}
    {album}
    albums={mergeCandidates}
    {busy}
    onMerge={(other) => merge(album, other)}
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
