<script lang="ts" module>
  /** Stable id for the page heading so the layout's skip link can target it. */
  export const albumDirectoryHeadingId = 'frameleaf-albums-heading';
</script>

<script lang="ts">
  import { afterNavigate, goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumActions from '$lib/components/frameleaf/AlbumActions.svelte';
  import AlbumTile from '$lib/components/frameleaf/AlbumTile.svelte';
  import CollectionShelf from '$lib/components/frameleaf/CollectionShelf.svelte';
  import { listEnter, listFlip, listLeave } from '$lib/components/frameleaf/people/list-motion';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    albumDirectoryFilters,
    albumDirectorySorts,
    albumAncestorsIn,
    albumsById,
    directoryAlbums,
    arrangeAlbumDirectory,
    canDropOnCollection,
    canEdit,
    canTakeOut,
    isOwner,
    moveInOrder,
    normalizeAlbumDirectoryView,
    orderGroupOf,
    placeBefore,
    type AlbumDirectoryFilter,
    type AlbumDirectorySort,
    type AlbumDirectoryViewMode,
  } from '$lib/frameleaf/album-directory';
  import { albumColorStyle } from '$lib/frameleaf/album-tree';
  import { canRevealNearby, createNearbyReveal } from '$lib/frameleaf/reveal-near';
  import { toastUndo } from '$lib/frameleaf/toast';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { handleDownloadAlbum, handleSetAlbumOrder } from '$lib/services/album.service';
  import { albumDirectoryView } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumDragData, isAlbumDrag } from '$lib/utils/album-drag';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { AlbumKind, type AlbumResponseDto, type AlbumTreeResponseDto } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
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
    mdiLockOpenVariantOutline,
    mdiLockOutline,
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
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

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
   *
   * What an action did is said in a toast at the foot of the page, with Undo for a move and a
   * reorder. The line under the filters is kept for what stays true until the next action: the drag
   * hint and "your albums changed since this page loaded".
   *
   * A library can hold thousands of albums (FL-1297). Each cell is a plain placeholder of the tile's
   * size until it nears the view; then its tile and menu are built and stay built. While the server is
   * still working out some albums' numbers, the page asks again every few seconds.
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
  /** The persistent line under the filters: a drag hint, or that the directory was reloaded. */
  let status = $state('');
  /** The item Move earlier / Move later just moved; its tile shows a ring that fades. */
  let movedId = $state<string | undefined>();

  /** An outcome, in a toast (a live region). `undo` puts the change back. */
  const announce = (message: string, undo?: () => unknown) => {
    status = '';
    if (undo) {
      toastUndo(message, undo);
    } else {
      toastManager.primary(message);
    }
  };
  let dragged = $state<AlbumResponseDto | undefined>();
  let overRoot = $state(false);
  let busy = $state(false);
  /** The album commands and their dialogs, shared with the sidebar's right-click menu. */
  let actions: AlbumActions | undefined = $state();
  const headingId = albumDirectoryHeadingId;

  /** The albums whose tile has been built. */
  const revealed = new SvelteSet<string>();
  const nearby = createNearbyReveal((id) => revealed.add(id));
  const watchNear = nearby.watch;
  const revealsAll = !canRevealNearby();
  onDestroy(() => nearby.disconnect());

  const arrangement = $derived(
    arrangeAlbumDirectory(tree, { filter: view.filter, sort: view.sort, search, userId: currentUserId }),
  );
  const everything = $derived(directoryAlbums(tree));
  /** A tile asks for its path on every update: with thousands of albums, one lookup table for them all. */
  const byId = $derived(albumsById(tree));
  const find = (id: string) => byId.get(id);

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
  // Every kind opens in the library view; a shared space too (owner, 2026-11-05).
  const openRoute = (album: AlbumResponseDto) => Route.viewAlbum({ id: album.id });
  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');

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

  /** New albums, and a library's first load, get their numbers in the background: ask again until they arrive. */
  const STATS_POLL_MS = 3000;
  const STATS_POLL_LIMIT = 20;
  let statsPolls = 0;
  const anyStatsPending = $derived(everything.some((album) => album.statsPending));
  $effect(() => {
    // Every new tree restarts the wait, so a slow answer never overlaps the next question.
    void tree;
    if (!anyStatsPending) {
      statsPolls = 0;
      return;
    }
    if (statsPolls >= STATS_POLL_LIMIT) {
      return;
    }
    const timer = setTimeout(() => {
      statsPolls += 1;
      void refresh();
    }, STATS_POLL_MS);
    return () => clearTimeout(timer);
  });

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
  const openCreate = (kind: AlbumKind, parentId: string | null = null, smart = false) =>
    actions?.create(kind, parentId, smart);
  const move = (album: AlbumResponseDto, parentId: string | null) => actions?.move(album, parentId);

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
  // FL-40 fix: same shallow-replaceState hazard as LibraryView.svelte — `page.url` does not update
  // synchronously after we delete `create` via replaceState, so without this guard the effect could
  // re-fire on the same stale `create` value and loop (openCreate + replaceState repeatedly). Reset
  // to null once `create` is gone so a later `?create=` on the same mounted page still opens.
  let consumedCreateRequest: string | null = null;

  $effect(() => {
    const request = page.url.searchParams.get('create');
    if (request !== 'album' && request !== 'space') {
      consumedCreateRequest = null;
      return;
    }
    if (request === consumedCreateRequest) {
      return;
    }
    if (!routerReady) {
      return;
    }
    consumedCreateRequest = request;
    untrack(() => openCreate(request === 'space' ? AlbumKind.Space : AlbumKind.Album));
    const url = new URL(page.url.href);
    url.searchParams.delete('create');
    replaceState(url, page.state).catch((error) => handleError(error, $t('error')));
  });

  /** The server refused a change made from an outdated directory: show the latest and say so. */
  const reloadStale = async () => {
    status = $t('frameleaf_albums_stale');
    await refresh();
  };

  /* ---- custom order (FL-52) ---- */
  const reorderable = $derived(view.sort === 'custom' && view.filter === 'all' && !arrangement.searching);

  const saveOrder = async (album: AlbumResponseDto, parentId: string | null, ids: string[], previousIds?: string[]) => {
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
      announce(
        $t('frameleaf_albums_reordered', {
          values: { name: nameOf(album), position: ids.indexOf(album.id) + 1, count: ids.length },
        }),
        previousIds ? () => void saveOrder(album, parentId, previousIds) : undefined,
      );
      await refresh();
      movedId = album.id;
    } finally {
      busy = false;
    }
  };

  /** Move earlier / Move later: the keyboard and touch way to arrange a group. */
  const step = (album: AlbumResponseDto, direction: -1 | 1) => {
    const group = orderGroupOf(tree, album.id);
    const ids = group && moveInOrder(group.ids, album.id, direction);
    if (group && ids) {
      void saveOrder(album, group.parentId, ids, group.ids);
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
      void saveOrder(album, group.parentId, ids, group.ids);
    }
  };
  /**
   * Outside custom order a plain album takes an album dropped on it, which goes inside it (albums nest
   * in albums, approved design 2026-11-04): never itself, a smart album, or one already inside the dragged one.
   */
  const acceptsNest = (target: AlbumResponseDto) =>
    !!dragged &&
    !acceptsReorder(target) &&
    target.kind === AlbumKind.Album &&
    !target.isSmart &&
    dragged.id !== target.id &&
    canDropOnCollection(dragged, target, currentUserId) &&
    albumAncestorsIn(byId, target).every(({ id }) => id !== dragged?.id);
  /** In custom order everything can be dragged to arrange it; otherwise only an owner's album, to move it. */
  const canDrag = (album: AlbumResponseDto) =>
    reorderable || (album.kind !== AlbumKind.Space && isOwner(album, currentUserId));

  /* ---- drag an album onto a collection shelf; touch uses Move to… ---- */
  const startDrag = (album: AlbumResponseDto) => {
    dragged = album;
    movedId = undefined;
    status = reorderable ? $t('frameleaf_albums_reorder_hint') : $t('frameleaf_albums_drag_hint');
  };
  const endDrag = () => {
    dragged = undefined;
    overRoot = false;
    // The hint is only true while something is being dragged.
    if (status === $t('frameleaf_albums_reorder_hint') || status === $t('frameleaf_albums_drag_hint')) {
      status = '';
    }
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
  /**
   * A right-click on an album, a collection's shelf or a space opens that item's menu at the pointer
   * (approved design, 2026-11-04); Shift+F10 or the menu key opens it under the focused item.
   */
  let contextMenu = $state<{ id: string; x: number; y: number } | null>(null);
  let section: HTMLElement | undefined = $state();
  const contextHolder = (target: EventTarget | null) => {
    const holder =
      target instanceof Element && !target.closest('[role="menu"]')
        ? target.closest<HTMLElement>('[data-album-id]')
        : null;
    return holder && section?.contains(holder) ? holder : null;
  };
  const openContextMenu = (holder: HTMLElement, at?: { x: number; y: number }) => {
    const focused = document.activeElement instanceof HTMLElement && holder.contains(document.activeElement);
    const rect = (focused ? (document.activeElement as HTMLElement) : holder).getBoundingClientRect();
    contextMenu = { id: holder.dataset.albumId as string, ...(at ?? { x: rect.left, y: rect.bottom }) };
  };
  const onContextMenu = (event: MouseEvent) => {
    const holder = contextHolder(event.target);
    if (!holder) {
      return;
    }
    event.preventDefault();
    // The menu key sends no pointer position.
    openContextMenu(holder, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'F10' && event.shiftKey) {
      const holder = contextHolder(document.activeElement);
      if (holder) {
        event.preventDefault();
        openContextMenu(holder);
      }
      return;
    }
    if (!(event.key === 'Escape' && dragged)) {
      return;
    }

    endDrag();
    announce($t('frameleaf_albums_move_cancelled'));
  };

  const draggedParent = $derived(dragged?.parentId ? find(dragged.parentId) : undefined);
</script>

{#snippet menu(album: AlbumResponseDto)}
  {@const owner = isOwner(album, currentUserId)}
  {@const editor = canEdit(album, currentUserId)}
  {@const isAlbum = album.kind === AlbumKind.Album}
  <!--
    The item menu in the prototype's order (Collections.jsx `menuFor`, lines 298-372), on the
    Frameleaf Menu. "Move earlier" / "Move later" (FL-52 custom order) sit with "Move to…", the
    prototype's other organising command, and use the same icon-and-label item.
  -->
  <Menu
    label={$t('frameleaf_albums_actions_for', { values: { name: nameOf(album) } })}
    align="end"
    bind:at={
      () => (contextMenu?.id === album.id ? contextMenu : null),
      (point) => {
        if (!point && contextMenu?.id === album.id) {
          contextMenu = null;
        }
      }
    }
  >
    {#snippet trigger()}<Icon icon={mdiDotsHorizontal} size="18" aria-hidden={true} />{/snippet}
    <MenuItem onSelect={() => goto(openRoute(album))}>
      <Icon icon={mdiFolderOpenOutline} size="18" aria-hidden={true} />{$t('open')}
    </MenuItem>
    {#if editor}
      <MenuItem onSelect={() => void actions?.edit(album)}>
        <Icon icon={mdiPencilOutline} size="18" aria-hidden={true} />{$t('edit')}
      </MenuItem>
    {/if}
    {#if editor && !isSpace(album)}
      <MenuItem onSelect={() => openCreate(AlbumKind.Album, album.id)}>
        <Icon icon={mdiPlus} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_album')}
      </MenuItem>
    {/if}
    {#if owner && !isSpace(album)}
      <MenuItem onSelect={() => actions?.openMove(album)}>
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
      <MenuItem onSelect={() => void actions?.openReevaluate(album)}>
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
      <MenuItem onSelect={() => actions?.share(album)}>
        <Icon icon={owner ? mdiAccountPlusOutline : mdiAccountMultipleOutline} size="18" aria-hidden={true} />
        {owner ? $t('share') : $t('frameleaf_albums_members')}
      </MenuItem>
    {/if}
    {#if owner}
      <MenuItem onSelect={() => actions?.link(album)}>
        <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />{$t('frameleaf_albums_create_link')}
      </MenuItem>
    {/if}
    <MenuItem disabled={album.assetCount === 0 && !album.statsPending} onSelect={() => handleDownloadAlbum(album)}>
      <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />{$t('download')}
    </MenuItem>
    {#if owner && isAlbum}
      <MenuItem onSelect={() => actions?.toggleLock(album)}>
        <Icon icon={album.isLocked ? mdiLockOpenVariantOutline : mdiLockOutline} size="18" aria-hidden={true} />
        {album.isLocked ? $t('frameleaf_albums_unlock') : $t('frameleaf_albums_lock')}
      </MenuItem>
    {/if}
    <div class="menu-separator" role="separator"></div>
    {#if owner}
      <MenuItem onSelect={() => actions?.remove(album)}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden={true} />{$t('delete')}
      </MenuItem>
    {:else}
      <MenuItem onSelect={() => actions?.leave(album)}>
        <Icon icon={mdiLogoutVariant} size="18" aria-hidden={true} />{$t('leave')}
      </MenuItem>
    {/if}
  </Menu>
{/snippet}

{#snippet tile(album: AlbumResponseDto, layout: 'grid' | 'list')}
  {#if revealsAll || revealed.has(album.id)}
    {#if album.parentId}
      <small class="album-path"
        >{albumAncestorsIn(byId, album)
          .map(({ albumName }) => albumName)
          .join(' / ')}</small
      >
    {/if}
    <AlbumTile
      {album}
      {currentUserId}
      {layout}
      draggable={canDrag(album)}
      dragging={dragged?.id === album.id}
      acceptsReorder={acceptsReorder(album)}
      acceptsNest={acceptsNest(album)}
      moved={movedId === album.id}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      onReorderDrop={(albumId) => dropBefore(albumId, album)}
      onNestDrop={(albumId) => void dropOnCollection(albumId, album)}
    >
      {#snippet actions()}{@render menu(album)}{/snippet}
    </AlbumTile>
  {:else}
    {#if album.parentId}<small class="album-path" aria-hidden="true">&nbsp;</small>{/if}
    <div class="tile-placeholder {layout}" data-testid="album-placeholder" aria-hidden="true"></div>
  {/if}
{/snippet}

{#snippet albums(list: AlbumResponseDto[], emptyText: string)}
  {#if view.view === 'grid'}
    <div class="grid">
      {#each list as album (album.id)}
        <div
          class="cell"
          data-album-id={album.id}
          class:tile-tinted={!!albumColorStyle(album.color)}
          style={albumColorStyle(album.color)}
          use:watchNear={album.id}
          animate:listFlip={{ count: list.length }}
          in:listEnter={{ count: list.length }}
          out:listLeave={{ count: list.length }}
        >
          {@render tile(album, 'grid')}
        </div>
      {/each}
      {#if list.length === 0 && emptyText}
        <p class="shelf-empty">{emptyText}</p>
      {/if}
    </div>
  {:else}
    <div class="list" role="list">
      {#each list as album (album.id)}
        <div
          role="listitem"
          data-album-id={album.id}
          class:tile-tinted={!!albumColorStyle(album.color)}
          style={albumColorStyle(album.color)}
          use:watchNear={album.id}
          animate:listFlip={{ count: list.length }}
          in:listEnter={{ count: list.length }}
          out:listLeave={{ count: list.length }}
        >
          {@render tile(album, 'list')}
        </div>
      {/each}
      {#if list.length === 0 && emptyText}
        <p class="shelf-empty">{emptyText}</p>
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:document onkeydown={onKeydown} oncontextmenu={onContextMenu} />

<section class="albums" aria-labelledby={headingId} bind:this={section}>
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

  <div class="status" class:has-message={!!status}><Status message={status} {busy} /></div>

  {#each arrangement.shelves as shelf (shelf.collection.id)}
    {@const editor = canEdit(shelf.collection, currentUserId)}
    <!-- The shelf's icon wears the collection's colour (README point 22: "They also show in Albums"). -->
    <div
      class="shelf-tint"
      data-album-id={shelf.collection.id}
      class:tinted={!!albumColorStyle(shelf.collection.color)}
      style={albumColorStyle(shelf.collection.color)}
    >
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
    </div>
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
        <!-- SHARING-P9: the prototype's plain "Shared spaces · N" heading; only waiting invitations add a link. -->
        {#if spaceInvitations > 0}
          <div class="spaces-links">
            <a class="invitations" href={Route.sharing()}>
              {$t('frameleaf_albums_spaces_invitations', { values: { count: spaceInvitations } })}
            </a>
          </div>
        {/if}
      </div>
      {#if arrangement.spaces.length > 0}
        {@render albums(arrangement.spaces, '')}
      {:else}
        <div class="shelf-empty spaces-empty">
          <p>{$t('frameleaf_spaces_empty_title')}</p>
          <!-- With no space yet, one line on what a space is. -->
          <p class="spaces-hint">{$t('frameleaf_spaces_intro')}</p>
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

  <!--
    Take an album out of its collection: a bar that rises at the foot of the window while such an
    album is being dragged, wherever the page is scrolled to. Pointer only; keyboard and touch use
    Move to… in the album's menu.
  -->
  <div
    class="root-drop fl-material fl-material-capsule"
    class:visible={!!draggedParent}
    class:over={overRoot}
    aria-hidden="true"
    ondragover={onRootDragOver}
    ondragenter={onRootDragOver}
    ondragleave={() => (overRoot = false)}
    ondrop={onRootDrop}
  >
    {#if dragged && draggedParent}
      <Icon icon={mdiFolderMoveOutline} size={ICON_SIZE.lg} />
      {$t('frameleaf_albums_drop_take_out', { values: { name: nameOf(dragged), collection: nameOf(draggedParent) } })}
    {/if}
  </div>
</section>

<AlbumActions
  bind:this={actions}
  {tree}
  onRefresh={refresh}
  onStale={() => (status = $t('frameleaf_albums_stale'))}
  {announce}
/>

<style>
  /*
   * An album or collection with a colour draws its fallback icon (no cover yet) in that colour, in
   * the light or dark shade (AlbumMark's custom properties).
   */
  .shelf-tint {
    display: contents;
  }
  .tile-tinted :global(.cover-empty),
  .shelf-tint.tinted :global(.mosaic-icon) {
    color: var(--mark-light);
  }
  :global([data-theme='dark']) .tile-tinted :global(.cover-empty),
  :global([data-theme='dark']) .shelf-tint.tinted :global(.mosaic-icon) {
    color: var(--mark-dark);
  }
  /*
   * The Albums page rhythm of apple-style.css:941-984 ("tighter rhythm, denser grid, like Photos'
   * Albums"), over collections.css: page padding, 20px under the filters, 28px between shelves and
   * sections, 17px section titles and a 164px (132px compact) grid. The gaps between rows of
   * controls and between cards are the spacing tokens, never under the prototype's own.
   */
  /* With the page area's 8px, the gutter every library page uses (24px desktop, 16px phone). */
  .albums {
    padding: 18px var(--fl-page-inline, var(--fl-space-4)) 64px;
    color: var(--fl-text);
  }
  /* The line under the filters takes no room while it has nothing to say (it stays a live region). */
  .status {
    margin-block: -8px 16px;
    font-size: var(--fl-font-small);
  }
  .status:not(.has-message) {
    height: 0;
    margin-block: 0;
    overflow: hidden;
  }
  .cell {
    position: relative;
    min-width: 0;
  }
  /* Exactly a tile's height (AlbumTile: cover, 8px, name, gap, the 28px meta row), so the scrollbar never jumps. */
  .tile-placeholder.grid {
    aspect-ratio: 1;
    margin-block-end: calc(8px + 1.3 * var(--fl-font-size) + var(--fl-space-1) + 28px);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .tile-placeholder.list {
    height: calc(max(3rem, 1.3 * var(--fl-font-size) + var(--fl-space-1) + 28px) + 0.75rem + 1px);
    border-bottom: 1px solid var(--fl-border);
    box-sizing: border-box;
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
    gap: var(--fl-space-4) var(--fl-space-5);
    margin-bottom: var(--fl-space-3);
  }
  /* One page-title size on every page (28px, 22px on phones). */
  .heading h1 {
    margin: 0;
    font: var(--fl-type-display);
    letter-spacing: -0.02em;
  }
  @media (max-width: 767px) {
    .heading h1 {
      font-size: var(--fl-font-title);
    }
  }
  .heading p {
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-2);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-inline-start: 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-muted);
    min-width: 15rem;
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  /* The field is the whole capsule, so the capsule wears the one focus ring in the input's place. */
  .search input:focus-visible {
    outline: none;
  }
  .search:has(input:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  /* The prototype's segmented pill (collections.css .al-view): raised track, the chosen view lifted. */
  /* 44px overall like every control beside it (48 on touch): the track's 3px inset plus 38px segments. */
  .view {
    display: inline-flex;
    box-sizing: border-box;
    gap: 2px;
    padding: 3px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
  }
  .view button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    padding: 0 0.625rem;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-muted);
  }
  @media (pointer: coarse) {
    .view button {
      min-height: 42px;
    }
  }
  .view button:hover {
    color: var(--fl-text);
  }
  .view button[aria-pressed='true'] {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: 0 0 var(--fl-space-5);
  }
  /* collections.css .al-filters: filled raised pills, the chosen one in the text colour. */
  .filters button {
    padding: 0 0.875rem;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .filters button:hover {
    color: var(--fl-text);
  }
  .filters button[aria-selected='true'] {
    background: var(--fl-text);
    color: var(--fl-canvas);
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
    gap: var(--fl-space-5) var(--fl-space-3);
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
    gap: var(--fl-space-2);
    margin: 0 0 var(--fl-space-3);
    padding-inline-start: 4px;
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
    margin-block-end: var(--fl-space-2);
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
  .spaces-empty .spaces-hint {
    flex-basis: 100%;
    text-align: center;
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
    position: sticky;
    bottom: calc(var(--fl-space-4) + var(--fl-tabbar-space, 0px));
    z-index: var(--fl-z-dock);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    width: fit-content;
    max-width: min(36rem, 100%);
    min-height: var(--fl-control-height-touch);
    margin-block-start: var(--fl-space-4);
    padding: var(--fl-space-3) var(--fl-space-5);
    border: 1px dashed var(--fl-border);
    color: var(--fl-on-material-muted);
    font-size: var(--fl-font-callout);
    text-align: center;
    /* Out of the way until an album that lives in a collection is being dragged. */
    opacity: 0;
    translate: 0 100%;
    pointer-events: none;
    transition:
      translate var(--fl-duration) var(--fl-spring),
      scale var(--fl-motion) var(--fl-snappy),
      opacity var(--fl-duration-fade) var(--fl-ease),
      border-color var(--fl-motion-fast) var(--fl-ease);
  }
  .root-drop.visible {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
  .root-drop.over {
    border-color: var(--fl-accent);
    border-style: solid;
    color: var(--fl-text);
    scale: 1.02;
  }
  @media (max-width: 700px) {
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
    /* collections.css @700px: the New menu keeps to the right edge, under the search's end. */
    .new-menu {
      margin-inline-start: auto;
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
  /* FL-707 P1: one top padding above every library-side page heading (28px, 16px on phones);
     the page area already adds 8px. */
  .albums {
    padding-top: calc(var(--fl-page-top) - 8px);
  }
</style>
