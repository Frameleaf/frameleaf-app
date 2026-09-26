<script lang="ts" module>
  /** Stable id for the page heading so the layout's skip link can target it. */
  export const albumDirectoryHeadingId = 'frameleaf-albums-heading';
</script>

<script lang="ts">
  import { afterNavigate, goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumConfirmDialog from '$lib/components/frameleaf/AlbumConfirmDialog.svelte';
  import AlbumCreateDialog from '$lib/components/frameleaf/AlbumCreateDialog.svelte';
  import AlbumMoveDialog from '$lib/components/frameleaf/AlbumMoveDialog.svelte';
  import AlbumShareDialog from '$lib/components/frameleaf/AlbumShareDialog.svelte';
  import AlbumTile from '$lib/components/frameleaf/AlbumTile.svelte';
  import CollectionShelf from '$lib/components/frameleaf/CollectionShelf.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import SharedLinkForm from '$lib/components/frameleaf/SharedLinkForm.svelte';
  import SmartAlbumReevaluateDialog from '$lib/components/frameleaf/SmartAlbumReevaluateDialog.svelte';
  import SmartAlbumRuleDialog from '$lib/components/frameleaf/SmartAlbumRuleDialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    albumDirectoryFilters,
    albumDirectorySorts,
    arrangeAlbumDirectory,
    canDropOnCollection,
    canEdit,
    canTakeOut,
    isOwner,
    moveInOrder,
    moveTargets,
    normalizeAlbumDirectoryView,
    orderGroupOf,
    placeBefore,
    type AlbumDirectoryFilter,
    type AlbumDirectorySort,
    type AlbumDetailsDraft,
    type AlbumDirectoryViewMode,
  } from '$lib/frameleaf/album-directory';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import SmartAlbumReevaluateModal from '$lib/modals/SmartAlbumReevaluateModal.svelte';
  import { Route } from '$lib/route';
  import {
    handleCreateAlbumEntry,
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleEditAlbumDetails,
    handleLeaveAlbum,
    handleMoveAlbumToCollection,
    handleSetAlbumOrder,
  } from '$lib/services/album.service';
  import { albumDirectoryView } from '$lib/stores/preferences.store';
  import { loadRuleSources, type RuleSources } from '$lib/frameleaf/classification-sources';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumDragData, isAlbumDrag } from '$lib/utils/album-drag';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import {
    AlbumKind,
    SharedLinkType,
    createClassificationRule,
    getClassificationRule,
    type AlbumResponseDto,
    type AlbumTreeResponseDto,
    type ClassificationRuleCreateDto,
    type ClassificationRuleResponseDto,
    type CreateAlbumDto,
  } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiArrowDown,
    mdiArrowUp,
    mdiAutoFix,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiFolderMoveOutline,
    mdiFolderMultipleOutline,
    mdiFolderOpenOutline,
    mdiImageAlbum,
    mdiLinkVariant,
    mdiLogoutVariant,
    mdiMagnify,
    mdiPencilOutline,
    mdiPlus,
    mdiRefresh,
    mdiSortVariant,
    mdiUpload,
    mdiViewGridOutline,
    mdiViewListOutline,
  } from '@mdi/js';
  import { hasRouterStarted } from '$lib/utils/router-started';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Albums page (FL-52). Collections are shelves with their albums beneath;
   * albums that stand on their own follow under "Other albums", then shared
   * spaces. Filters All, My albums, Shared, Smart; one sort menu; grid and list
   * (the list keeps the shelves); a New menu for album, smart album, collection
   * or shared space. Albums drag onto a collection shelf (mouse, pen) or move
   * through the dialog (keyboard, touch). Everything comes from GET /albums/tree
   * and goes back through the album service; the server owns the access rules.
   *
   * Shared spaces are the last shelf (FL-55). They stay top level — never inside
   * a collection, never offered a move — and open on their own page, where the
   * space's photos, viewer and members live. The shelf links to Sharing, where
   * spaces are created and invitations answered, and says when invitations are
   * waiting.
   *
   * "Custom order" (FL-52) shows every group in the person's own arrangement, which the server keeps
   * per person. While it is the sort — and nothing is filtered or searched, so the whole group is on
   * screen — an item drags onto another in its group to go just before it, and every item's menu has
   * Move earlier / Move later as the keyboard and touch alternative. Moving into or out of a
   * collection keeps using the shelves, the take-out zone and Move to…. A move or an order decided on
   * an outdated directory is refused by the server; the page then reloads and says so.
   */
  interface Props {
    tree: AlbumTreeResponseDto;
    /** Shared space invitations waiting for this person's answer. */
    spaceInvitations?: number;
    /** Re-fetch the tree after a change; the page owns the loader. */
    onRefresh: () => Promise<void> | void;
  }

  let { tree, spaceInvitations = 0, onRefresh }: Props = $props();

  const currentUserId = $derived(authManager.user.id);
  const view = $derived(normalizeAlbumDirectoryView($albumDirectoryView));

  let search = $state('');
  let status = $state('');
  let dragged = $state<AlbumResponseDto | undefined>();
  let overRoot = $state(false);
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
  let linkDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let editDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let shareDialog = $state<{ open: boolean; album?: AlbumResponseDto }>({ open: false });
  let reevaluate = $state<{ open: boolean; rule?: ClassificationRuleResponseDto; sources: RuleSources }>({
    open: false,
    sources: { people: [], tags: [] },
  });
  const headingId = albumDirectoryHeadingId;

  const arrangement = $derived(
    arrangeAlbumDirectory(tree, { filter: view.filter, sort: view.sort, search, userId: currentUserId }),
  );
  const everything = $derived([
    ...tree.collections.flatMap((node) => [node.collection, ...node.albums]),
    ...tree.albums,
    ...tree.spaces,
  ]);
  const editableCollections = $derived(
    tree.collections.map(({ collection }) => collection).filter((collection) => canEdit(collection, currentUserId)),
  );
  const find = (id: string) => everything.find((album) => album.id === id);

  /**
   * The spaces shelf shows whenever it has spaces to show, and — so there is always a way to one
   * from here — as an invitation to make the first when the page has other things on it and the
   * filter could include a space.
   */
  const showSpaces = $derived(
    arrangement.spaces.length > 0 ||
      (!arrangement.searching && !arrangement.empty && (view.filter === 'all' || view.filter === 'shared')),
  );
  const isSpace = (album: AlbumResponseDto) => album.kind === AlbumKind.Space;
  const openRoute = (album: AlbumResponseDto) =>
    isSpace(album) ? Route.viewSharedSpace({ id: album.id }) : Route.viewAlbum({ id: album.id });
  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');
  const kindOf = (album: AlbumResponseDto) =>
    album.kind === AlbumKind.Collection
      ? $t('frameleaf_album_kind_collection')
      : isSpace(album)
        ? $t('frameleaf_album_kind_space')
        : $t('frameleaf_album_kind_album');
  const albumCountOf = (album: AlbumResponseDto) =>
    tree.collections.find(({ collection }) => collection.id === album.id)?.albumCount ?? 0;

  const filterLabels: Record<AlbumDirectoryFilter, () => string> = {
    all: () => $t('all'),
    owned: () => $t('frameleaf_albums_filter_owned'),
    shared: () => $t('shared'),
    smart: () => $t('frameleaf_albums_filter_smart'),
  };
  const sortLabels: Record<AlbumDirectorySort, () => string> = {
    modified: () => $t('frameleaf_albums_sort_modified'),
    created: () => $t('frameleaf_albums_sort_created'),
    title: () => $t('frameleaf_albums_sort_title'),
    items: () => $t('frameleaf_albums_sort_items'),
    'recent-photo': () => $t('frameleaf_albums_sort_recent'),
    'oldest-photo': () => $t('frameleaf_albums_sort_oldest'),
    custom: () => $t('frameleaf_albums_sort_custom'),
  };

  const summary = $derived(
    [
      $t('frameleaf_albums_count', { values: { count: arrangement.totals.albums } }),
      arrangement.totals.collections > 0
        ? $t('frameleaf_albums_collection_count', { values: { count: arrangement.totals.collections } })
        : null,
      arrangement.totals.shared > 0
        ? $t('frameleaf_albums_shared_count', { values: { count: arrangement.totals.shared } })
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  const setView = (patch: Partial<typeof view>) => {
    $albumDirectoryView = { ...view, ...patch };
  };
  const setFilter = (filter: AlbumDirectoryFilter) => setView({ filter });
  const setSort = (sort: AlbumDirectorySort) => setView({ sort });
  const setViewMode = (mode: AlbumDirectoryViewMode) => setView({ view: mode });
  const isCollapsed = (id: string) => view.collapsed.includes(id);
  const toggleCollapsed = (id: string) =>
    setView({ collapsed: isCollapsed(id) ? view.collapsed.filter((item) => item !== id) : [...view.collapsed, id] });

  const onFilterKeydown = (event: KeyboardEvent, index: number) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const next = (index + step + albumDirectoryFilters.length) % albumDirectoryFilters.length;
    setFilter(albumDirectoryFilters[next]);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };

  const refresh = async () => {
    await onRefresh();
  };

  onMount(() =>
    eventManager.on({
      AlbumCreate: () => void refresh(),
      AlbumUpdate: () => void refresh(),
      AlbumDelete: () => void refresh(),
      AlbumUserDelete: () => void refresh(),
      AlbumShare: () => void refresh(),
    }),
  );

  /* ---- actions ---- */
  const openCreate = (kind: AlbumKind, parentId: string | null = null, smart = false) => {
    createDialog = { open: true, kind, parentId, smart };
  };

  /**
   * The rail's "+" (LibraryRail.jsx `onSave`, `onNewSpace`) arrives as `?create=album|space`. The
   * request is consumed once and dropped from the address, so opening All albums afterwards, going
   * back or reloading never replays it (September 24 polish pass).
   */
  // `replaceState` throws before the router's first navigation, as on a direct load of the link.
  let routerReady = $state(hasRouterStarted());
  afterNavigate(() => {
    routerReady = true;
  });

  $effect(() => {
    const request = page.url.searchParams.get('create');
    if (request !== 'album' && request !== 'space') {
      return;
    }
    if (!routerReady) {
      return;
    }
    untrack(() => openCreate(request === 'space' ? AlbumKind.Space : AlbumKind.Album));
    const url = new URL(page.url);
    url.searchParams.delete('create');
    replaceState(url, page.state);
  });

  /** A smart album and its rule are created together (FL-60); nothing is matched until it is applied. */
  const createSmart = async (dto: ClassificationRuleCreateDto) => {
    busy = true;
    try {
      const rule = await createClassificationRule({ classificationRuleCreateDto: dto });
      status = $t('frameleaf_albums_created', { values: { name: rule.albumName } });
      await goto(Route.viewAlbum({ id: rule.albumId }));
      return true;
    } catch (error) {
      handleError(error, $t('frameleaf_rules_create_failed'));
      return false;
    } finally {
      busy = false;
    }
  };

  /** Re-evaluate a rule-backed smart album in place; the built-in ones keep the server-wide check. */
  const openReevaluate = async (album: AlbumResponseDto) => {
    if (!album.smartRuleId) {
      void modalManager.show(SmartAlbumReevaluateModal, {});
      return;
    }
    try {
      const [rule, sources] = await Promise.all([getClassificationRule({ id: album.smartRuleId }), loadRuleSources()]);
      reevaluate = { open: true, rule, sources };
    } catch (error) {
      handleError(error, $t('frameleaf_rules_plan_failed'));
    }
  };

  const create = async (dto: CreateAlbumDto) => {
    busy = true;
    try {
      const album = await handleCreateAlbumEntry(dto);
      if (!album) {
        return false;
      }
      // Stay on the page and say what happened (Collections.jsx); the new album is in the refreshed tree.
      status = $t('frameleaf_albums_created', { values: { name: nameOf(album) } });
      await refresh();
      return true;
    } finally {
      busy = false;
    }
  };

  const move = async (album: AlbumResponseDto, collectionId: string | null) => {
    if (album.parentId === collectionId) {
      return;
    }
    busy = true;
    try {
      const moved = await handleMoveAlbumToCollection(album, collectionId);
      if (moved === 'stale') {
        await reloadStale();
        return;
      }
      if (!moved) {
        return;
      }
      const destination = collectionId ? find(collectionId) : undefined;
      status = destination
        ? $t('frameleaf_albums_moved_into', { values: { name: nameOf(album), collection: nameOf(destination) } })
        : $t('frameleaf_albums_moved_out', { values: { name: nameOf(album) } });
      moveDialog = { open: false };
      await refresh();
    } finally {
      busy = false;
    }
  };

  /** The server refused a change made from an outdated directory: show the latest and say so. */
  const reloadStale = async () => {
    status = $t('frameleaf_albums_stale');
    moveDialog = { open: false };
    await refresh();
  };

  /* ---- custom order (FL-52) ---- */
  const reorderable = $derived(view.sort === 'custom' && view.filter === 'all' && !arrangement.searching);

  const saveOrder = async (album: AlbumResponseDto, parentId: string | null, ids: string[]) => {
    busy = true;
    try {
      const saved = await handleSetAlbumOrder(parentId, ids);
      if (saved === 'stale') {
        await reloadStale();
        return;
      }
      if (!saved) {
        return;
      }
      status = $t('frameleaf_albums_reordered', {
        values: { name: nameOf(album), position: ids.indexOf(album.id) + 1, count: ids.length },
      });
      await refresh();
    } finally {
      busy = false;
    }
  };

  /** Move earlier / Move later: the keyboard and touch way to arrange a group. */
  const step = (album: AlbumResponseDto, direction: -1 | 1) => {
    const group = orderGroupOf(tree, album.id);
    const ids = group && moveInOrder(group.ids, album.id, direction);
    if (group && ids) {
      void saveOrder(album, group.parentId, ids);
    }
  };
  const canStep = (album: AlbumResponseDto, direction: -1 | 1) => {
    const group = orderGroupOf(tree, album.id);
    return !!group && !!moveInOrder(group.ids, album.id, direction);
  };

  /** A dragged item may land on another item of the same group, which it then goes just before. */
  const acceptsReorder = (target: AlbumResponseDto) => {
    if (!reorderable || !dragged || dragged.id === target.id) {
      return false;
    }
    return orderGroupOf(tree, dragged.id)?.ids.includes(target.id) ?? false;
  };
  const dropBefore = (albumId: string, target: AlbumResponseDto) => {
    const album = find(albumId);
    endDrag();
    const group = orderGroupOf(tree, albumId);
    const ids = group && placeBefore(group.ids, albumId, target.id);
    if (album && group && ids) {
      void saveOrder(album, group.parentId, ids);
    }
  };
  /** In custom order everything can be dragged to arrange it; otherwise only an owner's album, to move it. */
  const canDrag = (album: AlbumResponseDto) =>
    reorderable || (album.kind === AlbumKind.Album && isOwner(album, currentUserId));

  /** Delete and Leave confirm in the Frameleaf dialog (AlbumConfirmDialog), as the album header does. */
  const confirmDelete = async () => {
    const album = deleteDialog.album;
    if (!album) {
      return;
    }
    const ok = await handleDeleteAlbum(album, { notify: false });
    if (ok) {
      status =
        album.kind === AlbumKind.Collection
          ? $t('frameleaf_albums_deleted_collection', { values: { name: nameOf(album) } })
          : $t('frameleaf_albums_deleted', { values: { name: nameOf(album) } });
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
      status = $t('frameleaf_albums_left', { values: { name: nameOf(album) } });
    }
    await refresh();
  };

  let ruleEdit = $state<{
    open: boolean;
    album?: AlbumResponseDto;
    rule?: ClassificationRuleResponseDto;
    sources: RuleSources;
  }>({ open: false, sources: { people: [], tags: [] } });

  const edit = async (album: AlbumResponseDto) => {
    // A smart album is edited with its rule, as the design's edit dialog does (FL-60).
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
      status = $t('frameleaf_albums_saved', { values: { name: nameOf(saved) } });
    }
    return !!saved;
  };

  /** Members and roles in the Frameleaf share dialog (`ShareDialog`), as the album header does. */
  const share = (album: AlbumResponseDto) => {
    shareDialog = { open: true, album };
  };

  /* ---- drag an album onto a collection shelf; touch uses Move to… ---- */
  const startDrag = (album: AlbumResponseDto) => {
    dragged = album;
    status = reorderable ? $t('frameleaf_albums_reorder_hint') : $t('frameleaf_albums_drag_hint');
  };
  const endDrag = () => {
    dragged = undefined;
    overRoot = false;
  };
  const dropOnCollection = async (albumId: string, collection: AlbumResponseDto) => {
    const album = find(albumId);
    endDrag();
    if (canDropOnCollection(album, collection, currentUserId) && album) {
      await move(album, collection.id);
    }
  };
  const onRootDragOver = (event: DragEvent) => {
    if (!(canTakeOut(dragged, currentUserId) && isAlbumDrag(event))) {
      return;
    }

    event.preventDefault();
    overRoot = true;
  };
  const onRootDrop = async (event: DragEvent) => {
    const albumId = getAlbumDragData(event);
    const album = albumId ? find(albumId) : undefined;
    endDrag();
    if (album && canTakeOut(album, currentUserId)) {
      event.preventDefault();
      await move(album, null);
    }
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (!(event.key === 'Escape' && dragged)) {
      return;
    }

    endDrag();
    status = $t('frameleaf_albums_move_cancelled');
  };

  const draggedParent = $derived(dragged?.parentId ? find(dragged.parentId) : undefined);
</script>

{#snippet menu(album: AlbumResponseDto)}
  {@const owner = isOwner(album, currentUserId)}
  {@const editor = canEdit(album, currentUserId)}
  {@const isAlbum = album.kind === AlbumKind.Album}
  {@const isCollection = album.kind === AlbumKind.Collection}
  <!--
    The item menu in the prototype's order (Collections.jsx `menuFor`, lines 298-372), on the
    Frameleaf Menu. "Move earlier" / "Move later" (FL-52 custom order) sit with "Move to…", the
    prototype's other organising command, and use the same icon-and-label item.
  -->
  <Menu label={$t('frameleaf_albums_actions_for', { values: { name: nameOf(album) } })} align="end">
    {#snippet trigger()}<Icon icon={mdiDotsHorizontal} size="18" aria-hidden={true} />{/snippet}
    <MenuItem onSelect={() => goto(openRoute(album))}>
      <Icon icon={mdiFolderOpenOutline} size="18" aria-hidden={true} />{$t('open')}
    </MenuItem>
    {#if editor}
      <MenuItem onSelect={() => edit(album)}>
        <Icon icon={mdiPencilOutline} size="18" aria-hidden={true} />{$t('edit')}
      </MenuItem>
    {/if}
    {#if editor && isCollection}
      <MenuItem onSelect={() => openCreate(AlbumKind.Album, album.id)}>
        <Icon icon={mdiPlus} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_album')}
      </MenuItem>
    {/if}
    {#if owner && isAlbum}
      <MenuItem onSelect={() => (moveDialog = { open: true, album })}>
        <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_move_to')}
      </MenuItem>
    {/if}
    {#if reorderable && canStep(album, -1)}
      <MenuItem onSelect={() => step(album, -1)}>
        <Icon icon={mdiArrowUp} size="18" aria-hidden={true} />{$t('frameleaf_albums_move_earlier')}
      </MenuItem>
    {/if}
    {#if reorderable && canStep(album, 1)}
      <MenuItem onSelect={() => step(album, 1)}>
        <Icon icon={mdiArrowDown} size="18" aria-hidden={true} />{$t('frameleaf_albums_move_later')}
      </MenuItem>
    {/if}
    {#if editor && isAlbum && !album.isSmart}
      <MenuItem onSelect={() => void openFileUploadDialog({ albumId: album.id })}>
        <Icon icon={mdiUpload} size="18" aria-hidden={true} />{$t('frameleaf_albums_upload')}
      </MenuItem>
    {/if}
    {#if album.isSmart && (album.smartRuleId || authManager.user.isAdmin)}
      <MenuItem onSelect={() => void openReevaluate(album)}>
        <Icon icon={mdiRefresh} size="18" aria-hidden={true} />{$t('frameleaf_albums_smart_reevaluate')}
      </MenuItem>
    {/if}
    <div class="menu-separator" role="separator"></div>
    {#if isSpace(album)}
      <!-- A space's people are invitations and roles, managed on the space's own Members panel. -->
      <MenuItem onSelect={() => goto(`${Route.viewSharedSpace({ id: album.id })}?panel=members`)}>
        <Icon icon={mdiAccountMultipleOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_members')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => share(album)}>
        <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" aria-hidden={true} />
        {owner ? $t('share') : $t('frameleaf_albums_members')}
      </MenuItem>
    {/if}
    {#if owner}
      <MenuItem onSelect={() => (linkDialog = { open: true, album })}>
        <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_link')}
      </MenuItem>
    {/if}
    <MenuItem disabled={album.assetCount === 0} onSelect={() => handleDownloadAlbum(album)}>
      <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />{$t('download')}
    </MenuItem>
    <div class="menu-separator" role="separator"></div>
    {#if owner}
      <MenuItem onSelect={() => (deleteDialog = { open: true, album })}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden={true} />{$t('delete')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => (leaveDialog = { open: true, album })}>
        <Icon icon={mdiLogoutVariant} size="18" aria-hidden={true} />{$t('leave')}
      </MenuItem>
    {/if}
  </Menu>
{/snippet}

{#snippet albums(list: AlbumResponseDto[], emptyText: string)}
  {#if view.view === 'grid'}
    <div class="grid">
      {#each list as album (album.id)}
        <AlbumTile
          {album}
          {currentUserId}
          draggable={canDrag(album)}
          dragging={dragged?.id === album.id}
          acceptsReorder={acceptsReorder(album)}
          onDragStart={startDrag}
          onDragEnd={endDrag}
          onReorderDrop={(albumId) => dropBefore(albumId, album)}
        >
          {#snippet actions()}{@render menu(album)}{/snippet}
        </AlbumTile>
      {/each}
      {#if list.length === 0 && emptyText}
        <p class="shelf-empty">{emptyText}</p>
      {/if}
    </div>
  {:else}
    <div class="list" role="list">
      {#each list as album (album.id)}
        <div role="listitem">
          <AlbumTile
            {album}
            {currentUserId}
            layout="list"
            draggable={canDrag(album)}
            dragging={dragged?.id === album.id}
            acceptsReorder={acceptsReorder(album)}
            onDragStart={startDrag}
            onDragEnd={endDrag}
            onReorderDrop={(albumId) => dropBefore(albumId, album)}
          >
            {#snippet actions()}{@render menu(album)}{/snippet}
          </AlbumTile>
        </div>
      {/each}
      {#if list.length === 0 && emptyText}
        <p class="shelf-empty">{emptyText}</p>
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:document onkeydown={onKeydown} />

<section class="albums" aria-labelledby={headingId}>
  <header class="head">
    <div class="heading">
      <h1 id={headingId}>{$t('albums')}</h1>
      <p>{summary}</p>
    </div>
    <div class="tools">
      <label class="search">
        <Icon icon={mdiMagnify} size="17" />
        <input type="search" bind:value={search} placeholder={$t('search_albums')} aria-label={$t('search_albums')} />
      </label>
      <!-- The prototype's sort menu (Collections.jsx:672-683), plus "Custom order" (FL-52). -->
      <div class="sort">
        <Menu label={$t('frameleaf_albums_sort')} align="end">
          {#snippet trigger()}
            <Icon icon={mdiSortVariant} size="17" aria-hidden={true} />
            <span aria-hidden="true">{sortLabels[view.sort]()}</span>
          {/snippet}
          {#each albumDirectorySorts as sort (sort)}
            <MenuItem checked={view.sort === sort} onSelect={() => setSort(sort)}>{sortLabels[sort]()}</MenuItem>
          {/each}
        </Menu>
      </div>
      <div class="view" role="group" aria-label={$t('view')}>
        <button
          type="button"
          aria-pressed={view.view === 'grid'}
          aria-label={$t('frameleaf_albums_view_grid')}
          title={$t('frameleaf_albums_view_grid')}
          onclick={() => setViewMode('grid')}
        >
          <Icon icon={mdiViewGridOutline} size="18" />
        </button>
        <button
          type="button"
          aria-pressed={view.view === 'list'}
          aria-label={$t('frameleaf_albums_view_list')}
          title={$t('frameleaf_albums_view_list')}
          onclick={() => setViewMode('list')}
        >
          <Icon icon={mdiViewListOutline} size="18" />
        </button>
      </div>
      <!-- The prototype's primary "New" menu (Collections.jsx:702-735). -->
      <div class="new-menu">
        <Menu label={$t('frameleaf_albums_new')} align="end">
          {#snippet trigger()}
            <Icon icon={mdiPlus} size="18" aria-hidden={true} />
            <span>{$t('frameleaf_albums_new')}</span>
          {/snippet}
          <MenuItem onSelect={() => openCreate(AlbumKind.Album)}>
            <Icon icon={mdiImageAlbum} size="18" aria-hidden={true} />{$t('frameleaf_albums_new_album')}
          </MenuItem>
          <MenuItem onSelect={() => openCreate(AlbumKind.Album, null, true)}>
            <Icon icon={mdiAutoFix} size="18" aria-hidden={true} />{$t('frameleaf_albums_new_smart')}
          </MenuItem>
          <div class="menu-separator" role="separator"></div>
          <MenuItem onSelect={() => openCreate(AlbumKind.Collection)}>
            <Icon icon={mdiFolderMultipleOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_new_collection')}
          </MenuItem>
          <MenuItem onSelect={() => openCreate(AlbumKind.Space)}>
            <Icon icon={mdiAccountMultipleOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_new_space')}
          </MenuItem>
        </Menu>
      </div>
    </div>
  </header>

  <div class="filters" role="tablist" aria-label={$t('frameleaf_albums_show')}>
    {#each albumDirectoryFilters as filter, index (filter)}
      <button
        type="button"
        role="tab"
        aria-selected={view.filter === filter}
        tabindex={view.filter === filter ? 0 : -1}
        onclick={() => setFilter(filter)}
        onkeydown={(event) => onFilterKeydown(event, index)}
      >
        {filterLabels[filter]()}
      </button>
    {/each}
  </div>

  <Status message={status} {busy} />

  {#each arrangement.shelves as shelf (shelf.collection.id)}
    {@const editor = canEdit(shelf.collection, currentUserId)}
    <CollectionShelf
      {shelf}
      {currentUserId}
      collapsed={isCollapsed(shelf.collection.id)}
      canEdit={editor}
      acceptsDrop={canDropOnCollection(dragged, shelf.collection, currentUserId)}
      onToggle={() => toggleCollapsed(shelf.collection.id)}
      onNewAlbum={() => openCreate(AlbumKind.Album, shelf.collection.id)}
      onDrop={(albumId) => void dropOnCollection(albumId, shelf.collection)}
    >
      {#snippet actions()}{@render menu(shelf.collection)}{/snippet}
      {@render albums(
        shelf.albums,
        editor ? $t('frameleaf_albums_shelf_empty_editor') : $t('frameleaf_albums_shelf_empty'),
      )}
    </CollectionShelf>
  {/each}

  {#if arrangement.albums.length > 0}
    <section class="plain" aria-label={$t('frameleaf_albums_other')}>
      {#if arrangement.shelves.length > 0 || showSpaces}
        <h2>
          {$t('frameleaf_albums_other')}
          <small>{$t('frameleaf_albums_count', { values: { count: arrangement.albums.length } })}</small>
        </h2>
      {/if}
      {@render albums(arrangement.albums, '')}
    </section>
  {/if}

  {#if showSpaces}
    <section class="plain spaces" aria-label={$t('frameleaf_albums_spaces')}>
      <div class="spaces-head">
        <h2>
          {$t('frameleaf_albums_spaces')}
          <small>{$t('frameleaf_albums_space_count', { values: { count: arrangement.spaces.length } })}</small>
        </h2>
        <div class="spaces-links">
          {#if spaceInvitations > 0}
            <a class="invitations" href={Route.sharing()}>
              {$t('frameleaf_albums_spaces_invitations', { values: { count: spaceInvitations } })}
            </a>
          {/if}
          <a href={Route.sharing()}>{$t('frameleaf_albums_spaces_open_sharing')}</a>
        </div>
      </div>
      <p class="spaces-hint">{$t('frameleaf_spaces_intro')}</p>
      {#if arrangement.spaces.length > 0}
        {@render albums(arrangement.spaces, '')}
      {:else}
        <div class="shelf-empty spaces-empty">
          <p>{$t('frameleaf_spaces_empty_title')}</p>
          <button type="button" class="primary" onclick={() => openCreate(AlbumKind.Space)}>
            {$t('frameleaf_spaces_new')}
          </button>
        </div>
      {/if}
    </section>
  {/if}

  {#if arrangement.empty}
    <div class="empty">
      <Icon icon={mdiImageAlbum} size="36" />
      {#if arrangement.searching}
        <h2>{$t('frameleaf_albums_empty_search_title')}</h2>
        <p>{$t('frameleaf_albums_empty_search_text')}</p>
      {:else if view.filter === 'shared'}
        <h2>{$t('frameleaf_albums_empty_shared_title')}</h2>
        <p>{$t('frameleaf_albums_empty_shared_text')}</p>
      {:else if view.filter === 'smart'}
        <h2>{$t('frameleaf_albums_empty_smart_title')}</h2>
        <p>{$t('frameleaf_albums_empty_smart_text')}</p>
      {:else}
        <h2>{$t('frameleaf_albums_empty_title')}</h2>
        <p>{$t('frameleaf_albums_empty_text')}</p>
        <button type="button" class="primary" onclick={() => openCreate(AlbumKind.Album)}>{$t('create_album')}</button>
      {/if}
    </div>
  {/if}

  <div
    class="root-drop"
    class:visible={!!draggedParent}
    class:over={overRoot}
    aria-hidden="true"
    ondragover={onRootDragOver}
    ondragenter={onRootDragOver}
    ondragleave={() => (overRoot = false)}
    ondrop={onRootDrop}
  >
    {#if dragged && draggedParent}
      {$t('frameleaf_albums_drop_take_out', { values: { name: nameOf(dragged), collection: nameOf(draggedParent) } })}
    {/if}
  </div>
</section>

<AlbumCreateDialog
  bind:open={createDialog.open}
  kind={createDialog.kind}
  collections={editableCollections}
  defaultParentId={createDialog.parentId}
  smart={createDialog.smart}
  onCreate={create}
  onCreateSmart={createSmart}
/>

{#if moveDialog.album}
  <AlbumMoveDialog
    bind:open={moveDialog.open}
    album={moveDialog.album}
    targets={moveTargets(tree, moveDialog.album, currentUserId)}
    {busy}
    onMove={(collectionId) => moveDialog.album && void move(moveDialog.album, collectionId)}
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

{#if editDialog.album}
  <AlbumCreateDialog
    bind:open={editDialog.open}
    kind={editDialog.album.kind}
    album={editDialog.album}
    collections={editableCollections}
    canMove={editDialog.album.kind === AlbumKind.Album && isOwner(editDialog.album, currentUserId)}
    onCreate={create}
    onSave={saveDetails}
  />
{/if}
{#if shareDialog.album}
  {@const album = find(shareDialog.album.id) ?? shareDialog.album}
  <AlbumShareDialog
    {album}
    bind:open={shareDialog.open}
    onChanged={refresh}
    onLeave={() => (leaveDialog = { open: true, album })}
  />
{/if}
{#if linkDialog.album}
  <SharedLinkForm
    bind:open={linkDialog.open}
    target={{ type: SharedLinkType.Album, albumId: linkDialog.album.id, name: nameOf(linkDialog.album) }}
  />
{/if}

{#if ruleEdit.rule && ruleEdit.album}
  <SmartAlbumRuleDialog
    album={ruleEdit.album}
    rule={ruleEdit.rule}
    sources={ruleEdit.sources}
    bind:open={ruleEdit.open}
    onSaved={(_saved, message) => {
      status = message;
      void refresh();
    }}
  />
{/if}

{#if reevaluate.rule}
  <SmartAlbumReevaluateDialog
    rule={reevaluate.rule}
    sources={reevaluate.sources}
    bind:open={reevaluate.open}
    onApplied={(message) => {
      status = message;
      void refresh();
    }}
  />
{/if}

<style>
  /*
   * The Albums page rhythm of apple-style.css:941-984 ("tighter rhythm, denser grid, like Photos'
   * Albums"), over collections.css: page padding, a 10px header gap, 20px under the filters, 28px
   * between shelves and sections, 17px section titles and a 164px (132px compact) grid.
   */
  .albums {
    padding: 18px 24px 120px;
    color: var(--fl-text);
  }
  .albums > :global(*) {
    max-width: 1400px;
    margin-inline: auto;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 14px 18px;
    margin-bottom: 10px;
  }
  .heading h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
  }
  .heading p {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-inline-start: 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-muted);
    min-width: 14rem;
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  .search input:focus-visible {
    outline: none;
  }
  .search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .view {
    display: inline-flex;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    overflow: hidden;
  }
  .view button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.625rem;
    border: 0;
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .view button[aria-pressed='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin: 0 0 20px;
  }
  .filters button {
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .filters button[aria-selected='true'] {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
  /* The prototype's primary New menu trigger (Collections.jsx:702, Menu primary). */
  .new-menu :global(.menu-root > button) {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(164px, 1fr));
    gap: 18px 12px;
    align-items: start;
  }
  .list {
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--fl-border);
  }
  .shelf-empty {
    grid-column: 1 / -1;
    margin: 0;
    padding: 1rem;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius);
    color: var(--fl-muted);
    font-size: 0.875rem;
    text-align: center;
  }
  .plain {
    margin-bottom: 28px;
  }
  .plain h2 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 10px;
    padding-left: 4px;
    font-size: 17px;
    font-weight: 600;
  }
  .spaces-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }
  .spaces-head h2 {
    margin-block-end: 0.25rem;
  }
  .spaces-links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }
  .spaces-links a {
    color: var(--fl-accent);
    font-weight: 600;
    text-decoration: none;
  }
  .spaces-links .invitations {
    color: var(--fl-text);
  }
  .spaces-hint {
    margin: 0 0 0.75rem;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .spaces-empty {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
  }
  .spaces-empty p {
    margin: 0;
  }
  .spaces-empty .primary {
    min-height: 36px;
  }
  .plain h2 small {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 400;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 3rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
  .empty h2 {
    margin: 0;
    color: var(--fl-text);
    font-size: 1.125rem;
  }
  .empty p {
    margin: 0;
    font-size: 0.875rem;
  }
  .primary {
    padding: 0 1rem;
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .root-drop {
    display: none;
    padding: 1rem;
    border: 2px dashed var(--fl-border);
    border-radius: 10px;
    color: var(--fl-muted);
    text-align: center;
    font-size: 0.875rem;
  }
  .root-drop.visible {
    display: block;
  }
  .root-drop.over {
    border-color: var(--fl-accent);
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  @media (max-width: 700px) {
    .albums {
      padding: 14px 16px 120px;
    }
    .head {
      flex-direction: column;
      align-items: flex-start;
    }
    .tools {
      width: 100%;
    }
    .search {
      min-width: 0;
      flex: 1 1 100%;
    }
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
