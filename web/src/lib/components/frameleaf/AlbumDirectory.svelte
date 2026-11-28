<script lang="ts" module>
  /** Stable id for the page heading so the layout's skip link can target it. */
  export const albumDirectoryHeadingId = 'frameleaf-albums-heading';
</script>

<script lang="ts">
  import { afterNavigate, goto, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumActions from '$lib/components/frameleaf/AlbumActions.svelte';
  import AlbumCleanupBanner from '$lib/components/frameleaf/album-cleanup/AlbumCleanupBanner.svelte';
  import AlbumTile from '$lib/components/frameleaf/AlbumTile.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import FolderAlbumsNotice from '$lib/components/frameleaf/FolderAlbumsNotice.svelte';
  import { listEnter, listFlip, listLeave } from '$lib/components/frameleaf/people/list-motion';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    albumDirectoryFilters,
    albumDirectoryGroups,
    albumDirectorySorts,
    albumAncestorsIn,
    albumsById,
    directoryAlbums,
    browseAlbumDirectory,
    ownerOf,
    canDropOnCollection,
    canEdit,
    canMerge,
    canTakeOut,
    isOwner,
    arrangeInGroup,
    moveInOrder,
    normalizeAlbumDirectoryView,
    orderBandOf,
    orderGroupOf,
    placeBefore,
    type AlbumDirectoryFilter,
    type AlbumDirectoryGroup,
    type AlbumDirectorySort,
    type AlbumDirectoryViewMode,
  } from '$lib/frameleaf/album-directory';
  import { albumColorStyle } from '$lib/frameleaf/album-tree';
  import { pendingPins, recentAlbumIds, togglePinned } from '$lib/frameleaf/pinned-albums';
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
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AlbumKind,
    AssetMediaSize,
    getAlbumStats,
    type AlbumResponseDto,
    type AlbumTreeResponseDto,
  } from '@frameleaf/sdk';
  import { debounce } from 'lodash-es';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountPlusOutline,
    mdiArrowDown,
    mdiArrowCollapseUp,
    mdiArrowUp,
    mdiAutoFix,
    mdiCallMerge,
    mdiCheckboxMultipleMarkedOutline,
    mdiChevronDown,
    mdiChevronRight,
    mdiClose,
    mdiDeleteOutline,
    mdiDotsHorizontal,
    mdiDownloadOutline,
    mdiFolderMoveOutline,
    mdiFolderMultipleOutline,
    mdiFolderOpenOutline,
    mdiFolderOutline,
    mdiFormatListGroup,
    mdiImageAlbum,
    mdiImageMultipleOutline,
    mdiLinkVariant,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiLogoutVariant,
    mdiMagnify,
    mdiPencilOutline,
    mdiPin,
    mdiPinOff,
    mdiPlus,
    mdiRefresh,
    mdiSortAscending,
    mdiSortDescending,
    mdiSortVariant,
    mdiUpload,
    mdiViewGridOutline,
    mdiViewListOutline,
  } from '@mdi/js';
  import { hasRouterStarted } from '$lib/utils/router-started';
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { MediaQuery, SvelteSet } from 'svelte/reactivity';

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
  /**
   * At 700px and under the tools fill the page's width and sort is at their start edge, so its menu opens
   * from that edge; hung from the end of a 48px trigger it would open off the screen.
   */
  const stacked = new MediaQuery('max-width: 700px');

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

  const everything = $derived(directoryAlbums(tree));
  /**
   * FL-1836: the level being looked at, from the address (`?in=<id>`), so Back and a shared link return to
   * it. A collection or an album holding albums opens here; anything else opens its album page.
   */
  const insideId = $derived(page.url.searchParams.get('in'));
  const insideSize = $derived(insideId ? everything.filter(({ parentId }) => parentId === insideId).length : 0);
  const insideKnown = $derived(!!insideId && everything.some(({ id }) => id === insideId));
  /** Group by chosen while inside this collection: it wins over the automatic None below. */
  let groupChosenHere = $state(false);
  /** Inside a small collection the albums are few enough to show without sections, unless asked. */
  const group = $derived<AlbumDirectoryGroup>(insideKnown && insideSize < 24 && !groupChosenHere ? 'none' : view.group);
  /** Inside a small collection the Show pills are left out, so no filter from elsewhere may hide its albums. */
  const pillsHidden = $derived(insideKnown && insideSize < 13);
  const browse = $derived(
    browseAlbumDirectory(tree, {
      inside: insideId,
      filter: pillsHidden && !search.trim() ? 'all' : view.filter,
      sort: view.sort,
      order: view.order,
      group,
      hideEmpty: view.hideEmpty,
      collectionsFirst: view.collectionsFirst,
      search,
      userId: currentUserId,
      opened: $recentAlbumIds,
      locale: $locale ?? undefined,
    }),
  );
  const here = $derived(browse.here);
  /** How many tiles a section shows before "Show all": two rows at a desktop width. */
  const PREVIEW = 12;
  const expanded = new SvelteSet<string>();
  /** Folding and "Show all" belong to the level they were chosen on. */
  const foldKey = (sectionId: string) => `${insideId ?? ''}|${sectionId}`;
  const shownAll = (sectionId: string, count: number) => expanded.has(foldKey(sectionId)) || count <= PREVIEW + 2;
  const insideCount = (album: AlbumResponseDto) => browse.inside.get(album.id) ?? 0;
  const holdsAlbums = (album: AlbumResponseDto) => album.kind === AlbumKind.Collection || insideCount(album) > 0;
  const browseHref = (id: string | null) => (id ? `${Route.albums()}?in=${encodeURIComponent(id)}` : Route.albums());
  // A new level starts with no search and its sections folded back to two rows.
  $effect(() => {
    void insideId;
    untrack(() => {
      search = '';
      expanded.clear();
      groupChosenHere = false;
      // a selection acts on what is on screen: albums chosen on another level are not
      selected.clear();
    });
  });
  // While a pin is still being saved the menu already says what it will be.
  const pinned = $derived(new Set($pendingPins ?? authManager.preferences.albums.pinned));
  const showFolders = $derived(everything.some((album) => !!album.folderAlbum));
  const filters = $derived(albumDirectoryFilters.filter((filter) => filter !== 'folders' || showFolders));
  /**
   * FL-1412 (M13): with no album, collection or space at all there is nothing to search, sort, filter or
   * select, so the page shows its empty state and only the New menu (the way to every kind of album).
   */
  const nothingYet = $derived(everything.length === 0);
  /** A tile asks for its path on every update: with thousands of albums, one lookup table for them all. */
  const byId = $derived(albumsById(tree));
  const find = (id: string) => byId.get(id);

  const isSpace = (album: AlbumResponseDto) => album.kind === AlbumKind.Space;
  // Every kind opens in the library view; a shared space too (owner, 2026-11-05). FL-1836: a collection or an
  // album holding albums opens here first, one level down.
  const openRoute = (album: AlbumResponseDto) =>
    holdsAlbums(album) ? browseHref(album.id) : Route.viewAlbum({ id: album.id });
  /** Someone tabbing to a waiting album gets the real tile, with focus moved onto it. */
  const revealFocused = async (id: string) => {
    revealed.add(id);
    await tick();
    document.querySelector<HTMLElement>(`[data-album-id="${CSS.escape(id)}"] a[href]`)?.focus();
  };
  const nameOf = (album: AlbumResponseDto | undefined) => album?.albumName || $t('unnamed_album');

  const filterLabels: Record<AlbumDirectoryFilter, () => string> = {
    all: () => $t('all'),
    owned: () => $t('frameleaf_albums_filter_owned'),
    shared: () => $t('shared'),
    smart: () => $t('frameleaf_albums_filter_smart'),
    folders: () => $t('frameleaf_albums_filter_folders'),
  };
  const groupLabels: Record<AlbumDirectoryGroup, () => string> = {
    kind: () => $t('frameleaf_albums_group_kind'),
    source: () => $t('frameleaf_albums_group_source'),
    year: () => $t('frameleaf_albums_group_year'),
    month: () => $t('frameleaf_albums_group_month'),
    owner: () => $t('frameleaf_albums_group_owner'),
    none: () => $t('frameleaf_albums_group_none'),
  };
  const monthFormat = $derived(
    // eslint-disable-next-line no-restricted-syntax -- month and year only: no day or time for the account's format
    new Intl.DateTimeFormat($locale ?? undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  );
  /** A section's heading, from its id (`browseAlbumDirectory`). */
  const groupLabel = (id: string, albums: AlbumResponseDto[]) => {
    const colon = id.indexOf(':');
    const key = colon === -1 ? id : id.slice(0, colon);
    const value = colon === -1 ? '' : id.slice(colon + 1);
    if (value === 'none') {
      return $t('frameleaf_albums_section_no_photos');
    }
    switch (key) {
      case 'kind': {
        return {
          collections: $t('frameleaf_albums_section_collections'),
          albums: $t('frameleaf_albums_section_albums'),
          smart: $t('frameleaf_albums_section_smart'),
          spaces: $t('frameleaf_albums_spaces'),
        }[value];
      }
      case 'source': {
        return {
          made: $t('frameleaf_albums_section_made'),
          folders: $t('frameleaf_albums_section_folders'),
          shared: $t('frameleaf_albums_section_shared'),
          smart: $t('frameleaf_albums_section_smart'),
          spaces: $t('frameleaf_albums_spaces'),
        }[value];
      }
      case 'year': {
        return value;
      }
      case 'month': {
        return monthFormat.format(new Date(`${value}-01T00:00:00Z`));
      }
      case 'owner': {
        return value === 'me'
          ? $t('frameleaf_albums_section_you')
          : $t('frameleaf_albums_section_shared_by', {
              values: { name: (albums[0] && ownerOf(albums[0])?.name) || $t('unknown') },
            });
      }
    }
    return '';
  };
  /** The Order button says what it does for the sort chosen. */
  const orderLabel = $derived.by(() => {
    const asc = view.order === 'asc';
    switch (view.sort) {
      case 'title': {
        return asc ? $t('frameleaf_albums_order_az') : $t('frameleaf_albums_order_za');
      }
      case 'items': {
        return asc ? $t('frameleaf_albums_order_fewest') : $t('frameleaf_albums_order_most');
      }
      case 'opened': {
        return asc ? $t('frameleaf_albums_order_least_recent') : $t('frameleaf_albums_order_newest');
      }
      default: {
        return asc ? $t('frameleaf_albums_order_oldest') : $t('frameleaf_albums_order_newest');
      }
    }
  });
  const sortLabels: Record<AlbumDirectorySort, () => string> = {
    date: () => $t('frameleaf_albums_sort_date'),
    title: () => $t('frameleaf_albums_sort_title'),
    opened: () => $t('frameleaf_albums_sort_opened'),
    modified: () => $t('frameleaf_albums_sort_modified'),
    items: () => $t('frameleaf_albums_sort_items'),
    custom: () => $t('frameleaf_albums_sort_custom'),
  };

  const summary = $derived(
    [
      $t('frameleaf_albums_count', { values: { count: browse.totals.albums } }),
      browse.totals.collections > 0
        ? $t('frameleaf_albums_collection_count', { values: { count: browse.totals.collections } })
        : null,
      browse.totals.spaces > 0 ? $t('frameleaf_albums_space_count', { values: { count: browse.totals.spaces } }) : null,
      browse.totals.emptyHidden > 0
        ? $t('frameleaf_albums_empty_hidden', { values: { count: browse.totals.emptyHidden } })
        : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );

  const setView = (patch: Partial<typeof view>) => {
    $albumDirectoryView = { ...view, ...patch };
  };
  const setFilter = (filter: AlbumDirectoryFilter) => setView({ filter });
  // Name runs A to Z by default; every other sort, newest or most first.
  const setSort = (sort: AlbumDirectorySort) => setView({ sort, order: sort === 'title' ? 'asc' : 'desc' });
  const setGroup = (next: AlbumDirectoryGroup) => {
    groupChosenHere = !!insideId;
    setView({ group: next });
  };
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
    const next = (index + step + filters.length) % filters.length;
    setFilter(filters[next]);
    (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>('[role=tab]')[next]?.focus();
  };

  const refresh = async () => {
    await onRefresh();
  };

  /** New albums, and a library's first load, get their numbers in the background: ask again until they arrive. */
  const STATS_POLL_MS = 3000;
  const STATS_POLL_LIMIT = 20;
  /** The most ids one stats request takes. */
  const STATS_IDS_LIMIT = 5000;
  let statsPolls = 0;
  /** Bumped when the numbers have not arrived yet, to wait and ask once more. */
  let statsTick = $state(0);
  let polledFor = new Set<string>();
  const pendingStatIds = $derived(everything.filter((album) => album.statsPending).map((album) => album.id));
  $effect(() => {
    // Every new tree restarts the wait, so a slow answer never overlaps the next question.
    void tree;
    void statsTick;
    if (pendingStatIds.length === 0) {
      statsPolls = 0;
      polledFor = new Set();
      return;
    }
    // An album that has only just started waiting gets the full wait.
    if (pendingStatIds.some((id) => !polledFor.has(id))) {
      statsPolls = 0;
    }
    polledFor = new Set(pendingStatIds);
    if (statsPolls >= STATS_POLL_LIMIT) {
      return;
    }
    const ids = pendingStatIds;
    let left = false;
    const timer = setTimeout(() => {
      statsPolls += 1;
      // FL-1802: ask for the waiting albums' numbers alone (FL-1791); the whole tree is read again only
      // once some have arrived. A server or answer without them falls back to reading the tree.
      // an async call, so a failure to even start the request is caught below like any other
      void (async () => getAlbumStats({ albumStatsDto: { albumIds: ids.slice(0, STATS_IDS_LIMIT) } }))()
        .then(({ albums }) => {
          const stillWaiting = new Set(albums.filter((album) => album.statsPending).map((album) => album.id));
          return ids.slice(0, STATS_IDS_LIMIT).some((id) => !stillWaiting.has(id));
        })
        .catch(() => true)
        .then((arrived) => {
          if (left) {
            return;
          }
          if (arrived) {
            void refresh();
          } else {
            statsTick += 1;
          }
        });
    }, STATS_POLL_MS);
    return () => {
      left = true;
      clearTimeout(timer);
    };
  });

  /** FL-1802: a move or a bulk change announces every album it saved; one read answers the burst. */
  const refreshSoon = debounce(() => void refresh(), 250);
  onMount(() => {
    const stop = eventManager.on({
      AlbumCreate: refreshSoon,
      AlbumUpdate: refreshSoon,
      AlbumDelete: refreshSoon,
      AlbumUserDelete: refreshSoon,
      AlbumShare: refreshSoon,
    });
    return () => {
      stop();
      refreshSoon.cancel();
    };
  });

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
  /** Arranging needs the whole group on screen, in its own order: nothing filtered, hidden, folded or cut short. */
  const reorderable = $derived(
    view.sort === 'custom' &&
      (view.filter === 'all' || pillsHidden) &&
      group === 'none' &&
      !browse.searching &&
      !view.collectionsFirst &&
      browse.hiddenHere === 0 &&
      !browse.cycleHere &&
      (browse.listed.length <= PREVIEW + 2 || expanded.has(foldKey('none'))),
  );

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
    const previous = orderGroupOf(tree, album.id);
    const next = arrangeInGroup(tree, album.id, (ids) => moveInOrder(ids, album.id, direction));
    if (previous && next) {
      void saveOrder(album, next.parentId, next.ids, previous.ids);
    }
  };
  const canStep = (album: AlbumResponseDto, direction: -1 | 1) =>
    !!orderBandOf(tree, album.id) && !!moveInOrder(orderBandOf(tree, album.id)!.band, album.id, direction);

  /** The run a dragged item may be arranged in, worked out once per drag rather than once per tile. */
  const draggedBand = $derived(
    reorderable && dragged ? new Set(orderBandOf(tree, dragged.id)?.band) : new Set<string>(),
  );
  /** A dragged item may land on another item of its run, which it then goes just before. */
  const acceptsReorder = (target: AlbumResponseDto) =>
    !!dragged && dragged.id !== target.id && draggedBand.has(target.id);
  const dropBefore = (albumId: string, target: AlbumResponseDto) => {
    const album = find(albumId);
    endDrag();
    const previous = orderGroupOf(tree, albumId);
    const next = arrangeInGroup(tree, albumId, (ids) => placeBefore(ids, albumId, target.id));
    if (album && previous && next) {
      void saveOrder(album, next.parentId, next.ids, previous.ids);
    }
  };
  /**
   * Outside custom order a plain album takes an album dropped on it, which goes inside it (albums nest
   * in albums, approved design 2026-11-04): never itself, a smart album, or one already inside the dragged one.
   */
  const acceptsNest = (target: AlbumResponseDto) =>
    !!dragged &&
    !acceptsReorder(target) &&
    (target.kind === AlbumKind.Album || target.kind === AlbumKind.Collection) &&
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
  /**
   * FL-1836: a step of the path bar takes a dragged album: "Albums" is the top level, any other step that
   * collection or album.
   */
  let overPath = $state<string | null | undefined>(undefined);
  const acceptsPathDrop = (target: AlbumResponseDto | null) =>
    !!dragged &&
    (target
      ? !target.isSmart &&
        canDropOnCollection(dragged, target, currentUserId) &&
        albumAncestorsIn(byId, target).every(({ id }) => id !== dragged?.id)
      : canTakeOut(dragged, currentUserId));
  const onPathDragOver = (event: DragEvent, target: AlbumResponseDto | null) => {
    if (!(acceptsPathDrop(target) && isAlbumDrag(event))) {
      return;
    }
    event.preventDefault();
    overPath = target?.id ?? null;
  };
  const onPathDrop = async (event: DragEvent, target: AlbumResponseDto | null) => {
    const albumId = getAlbumDragData(event);
    const album = albumId ? find(albumId) : undefined;
    const ok = acceptsPathDrop(target);
    endDrag();
    overPath = undefined;
    if (album && ok) {
      event.preventDefault();
      await move(album, target?.id ?? null);
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
  /** The menu for every chosen album, opened by a right-click on one of them. */
  let bulkMenuAt = $state<{ x: number; y: number } | null>(null);
  const openContextMenu = (holder: HTMLElement, at?: { x: number; y: number }) => {
    const focused = document.activeElement instanceof HTMLElement && holder.contains(document.activeElement);
    const rect = (focused ? (document.activeElement as HTMLElement) : holder).getBoundingClientRect();
    const id = holder.dataset.albumId as string;
    const point = at ?? { x: rect.left, y: rect.bottom };
    // On one of several chosen albums the menu acts on them all; on any other album, on that one.
    if (selecting && selected.size > 1 && selected.has(id)) {
      bulkMenuAt = point;
      return;
    }
    contextMenu = { id, ...point };
  };
  /** Ctrl- or Cmd-click on an album tile starts choosing with it, or adds or removes it. */
  const onClickCapture = (event: MouseEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.button !== 0 || !(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest('[role="menu"], .menu-root > button')) {
      return;
    }
    const holder = event.target.closest<HTMLElement>('.cell[data-album-id], [role="listitem"][data-album-id]');
    const album = holder && section?.contains(holder) ? find(holder.dataset.albumId as string) : undefined;
    if (!album || !selectable(album)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    selecting = true;
    toggleSelected(album);
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
    if (event.key === 'Escape' && selecting && !dragged && !document.querySelector('dialog[open], [role="menu"]')) {
      stopSelecting();
      return;
    }
    if (!(event.key === 'Escape' && dragged)) {
      return;
    }

    endDrag();
    announce($t('frameleaf_albums_move_cancelled'));
  };

  const draggedParent = $derived(dragged?.parentId ? find(dragged.parentId) : undefined);

  /* ---- choose several albums and act on them together ---- */
  let selecting = $state(false);
  const selected = new SvelteSet<string>();
  /** Spaces stay out: they are never moved, merged or locked from here. */
  const selectable = (album: AlbumResponseDto) => !isSpace(album);
  const toggleSelected = (album: AlbumResponseDto) =>
    selected.has(album.id) ? selected.delete(album.id) : selected.add(album.id);
  const stopSelecting = () => {
    selecting = false;
    selected.clear();
  };
  // An album merged or deleted (here or elsewhere) leaves the selection with the directory.
  $effect(() => {
    for (const id of selected) {
      if (!byId.has(id)) {
        selected.delete(id);
      }
    }
  });
  const selectedAlbums = $derived(
    [...selected].map((id) => byId.get(id)).filter((album): album is AlbumResponseDto => !!album),
  );
  /** What "Select all" takes: the albums on screen, never those in a folded section or past "Show more". */
  const visibleSelectable = $derived(
    browse.groups
      .filter(({ id }) => group === 'none' || !isCollapsed(foldKey(id)))
      .flatMap(({ id, albums }) => (shownAll(id, albums.length) ? albums : albums.slice(0, PREVIEW)))
      .filter((album) => selectable(album)),
  );
  const allVisibleSelected = $derived(
    visibleSelectable.length > 0 && visibleSelectable.every(({ id }) => selected.has(id)),
  );
  const toggleAll = () => {
    if (allVisibleSelected) {
      selected.clear();
    } else {
      for (const { id } of visibleSelectable) {
        selected.add(id);
      }
    }
  };
  const any = $derived(selectedAlbums.length > 0);
  const allOwned = $derived(any && selectedAlbums.every((album) => isOwner(album, currentUserId)));
  const allMergeable = $derived(any && selectedAlbums.every((album) => canMerge(album, currentUserId)));
  const allLockable = $derived(allOwned && selectedAlbums.every((album) => album.kind === AlbumKind.Album));
  const anyInside = $derived(selectedAlbums.some((album) => canTakeOut(album, currentUserId)));
  const moveSelectedToTop = async () => {
    for (const album of selectedAlbums) {
      if (canTakeOut(album, currentUserId)) {
        await move(album, null);
      }
    }
  };
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
    {#if canMerge(album, currentUserId)}
      <MenuItem onSelect={() => actions?.openMerge(album)}>
        <Icon icon={mdiCallMerge} size="18" aria-hidden={true} />{$t('frameleaf_albums_merge_with')}
      </MenuItem>
    {/if}
    <MenuItem onSelect={() => void togglePinned(album.id, (id) => byId.has(id))}>
      <Icon icon={pinned.has(album.id) ? mdiPinOff : mdiPin} size="18" aria-hidden={true} />
      {pinned.has(album.id) ? $t('frameleaf_albums_unpin') : $t('frameleaf_albums_pin')}
    </MenuItem>
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
  {#if selecting && selectable(album)}
    <!-- While choosing, a click anywhere on the tile picks it; the checkbox is the control itself. -->
    <label class="pick" class:checked={selected.has(album.id)}>
      <input
        type="checkbox"
        checked={selected.has(album.id)}
        onchange={() => toggleSelected(album)}
        aria-label={$t('frameleaf_albums_select_album', { values: { name: nameOf(album) } })}
      />
    </label>
  {/if}
  {#if revealsAll || revealed.has(album.id)}
    <AlbumTile
      {album}
      {currentUserId}
      {layout}
      href={openRoute(album)}
      inside={insideCount(album)}
      total={browse.items.get(album.id)}
      where={browse.searching ? find(browse.parents.get(album.id) ?? '')?.albumName : undefined}
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
    <div class="tile-placeholder {layout}" data-testid="album-placeholder">
      <!-- FL-1297: a waiting album stays in the screen reader's list and the tab order. -->
      <a class="placeholder-link" href={openRoute(album)} onfocus={() => void revealFocused(album.id)}>
        {nameOf(album)}
      </a>
    </div>
  {/if}
{/snippet}

{#snippet albums(list: AlbumResponseDto[], emptyText: string)}
  {#if view.view === 'grid'}
    <div class="grid">
      {#each list as album (album.id)}
        <div
          class="cell"
          class:selected={selecting && selected.has(album.id)}
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
          class="row"
          class:selected={selecting && selected.has(album.id)}
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

<section class="albums" aria-labelledby={headingId} bind:this={section} onclickcapture={onClickCapture}>
  <AlbumCleanupBanner />
  <header class="head">
    {#if here}
      <!-- FL-1836: inside a collection the path stands where the title was; every step takes a dragged album. -->
      <nav class="path" aria-label={$t('frameleaf_albums_path')}>
        <ol>
          <li>
            <a
              class="crumb"
              href={browseHref(null)}
              class:over={overPath === null}
              ondragover={(event) => onPathDragOver(event, null)}
              ondragenter={(event) => onPathDragOver(event, null)}
              ondragleave={() => (overPath = undefined)}
              ondrop={(event) => void onPathDrop(event, null)}
            >
              <Icon icon={mdiImageAlbum} size="16" aria-hidden={true} />
              {$t('albums')}
            </a>
          </li>
          {#each browse.path as step (step.id)}
            <li>
              <Icon icon={mdiChevronRight} size="16" aria-hidden={true} />
              <a
                class="crumb"
                href={browseHref(step.id)}
                aria-current={step.id === here.id ? 'page' : undefined}
                class:over={overPath === step.id}
                ondragover={(event) => onPathDragOver(event, step)}
                ondragenter={(event) => onPathDragOver(event, step)}
                ondragleave={() => (overPath = undefined)}
                ondrop={(event) => void onPathDrop(event, step)}
              >
                {nameOf(step)}
              </a>
            </li>
          {/each}
        </ol>
      </nav>
    {:else}
      <div
        class="heading"
        class:over={overPath === null}
        role="presentation"
        ondragover={(event) => onPathDragOver(event, null)}
        ondragenter={(event) => onPathDragOver(event, null)}
        ondragleave={() => (overPath = undefined)}
        ondrop={(event) => void onPathDrop(event, null)}
      >
        <h1 id={headingId}>{$t('albums')}</h1>
        <p>{summary}</p>
      </div>
    {/if}
    <div class="tools">
      {#if !nothingYet}
        <label class="search">
          <Icon icon={mdiMagnify} size="17" />
          <input
            type="search"
            bind:value={search}
            placeholder={here ? $t('frameleaf_albums_search_here') : $t('frameleaf_albums_search_all')}
            aria-label={$t('search_albums')}
          />
        </label>
      {/if}
      <!-- The prototype's primary "New" menu (Collections.jsx:702-735). -->
      <div class="new-menu">
        <Menu label={$t('frameleaf_albums_new')} align="end">
          {#snippet trigger()}
            <Icon icon={mdiPlus} size="18" aria-hidden={true} />
            <span>{$t('frameleaf_albums_new')}</span>
          {/snippet}
          <MenuItem onSelect={() => openCreate(AlbumKind.Album, here && !isSpace(here) ? here.id : null)}>
            <Icon icon={mdiImageAlbum} size="18" aria-hidden={true} />{$t('frameleaf_albums_new_album')}
          </MenuItem>
          <MenuItem onSelect={() => openCreate(AlbumKind.Album, here && !isSpace(here) ? here.id : null, true)}>
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

  <!-- FL-1837: the one-time offer of one album for each event folder, between the header and the toolbar at
       the top level, as the approved design places it. Kept mounted while inside a collection, so its Undo and
       its answer survive a visit there and back. -->
  <div class="notice-slot" hidden={!!here}>
    <FolderAlbumsNotice onChanged={refresh} />
  </div>

  {#if here}
    {@const editor = canEdit(here, currentUserId)}
    <!-- FL-1836: what this collection holds, where it came from, and what can be done with it. -->
    <div class="here" data-album-id={here.id}>
      <a class="here-cover" href={Route.viewAlbum({ id: here.id })} tabindex="-1" aria-hidden="true">
        {#if here.albumThumbnailAssetId}
          <img
            src={getAssetMediaUrl({ id: here.albumThumbnailAssetId, size: AssetMediaSize.Thumbnail })}
            alt=""
            draggable="false"
          />
        {:else}
          <Icon icon={mdiFolderMultipleOutline} size="32" />
        {/if}
      </a>
      <div class="here-text">
        <h1 id={headingId}>{nameOf(here)}</h1>
        <p>
          {here.kind === AlbumKind.Collection
            ? $t('frameleaf_albums_here_collection')
            : $t('frameleaf_albums_here_album')}
          · {$t('frameleaf_albums_here_inside', { values: { count: insideCount(here) } })}
          {#if (browse.items.get(here.id) ?? here.assetCount) > 0}
            · {$t('frameleaf_albums_items', { values: { count: browse.items.get(here.id) ?? here.assetCount } })}
          {/if}
        </p>
        {#if here.folderAlbum}
          <p class="here-folder">
            <Icon icon={mdiFolderOutline} size="15" aria-hidden={true} />
            {$t('frameleaf_albums_made_from_folder')}
            <code>{here.folderAlbum.folderPath}</code>
          </p>
        {/if}
        <div class="here-actions">
          <a class="primary-link fl-control" href={Route.viewAlbum({ id: here.id })}>
            <Icon icon={mdiImageMultipleOutline} size="17" aria-hidden={true} />
            {$t('frameleaf_albums_view_all_photos')}
          </a>
          {#if editor && !isSpace(here)}
            <button type="button" class="fl-control" onclick={() => openCreate(AlbumKind.Album, here.id)}>
              <Icon icon={mdiPlus} size="17" aria-hidden={true} />{$t('frameleaf_albums_new_album_here')}
            </button>
          {/if}
          {#if isOwner(here, currentUserId) && !isSpace(here)}
            <button type="button" class="fl-control" onclick={() => actions?.openMove(here)}>
              <Icon icon={mdiFolderMoveOutline} size="17" aria-hidden={true} />{$t('frameleaf_albums_move_to')}
            </button>
          {/if}
          <div class="here-menu">{@render menu(here)}</div>
        </div>
      </div>
    </div>
  {/if}

  {#if !nothingYet}
    <!-- FL-1836: one toolbar. What to show on the left; how to arrange it on the right. -->
    <div class="toolbar">
      <div
        class="filters"
        role="tablist"
        aria-label={$t('frameleaf_albums_show')}
        hidden={pillsHidden && !browse.searching}
      >
        {#each filters as filter, index (filter)}
          <button
            type="button"
            class="fl-control"
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
      <div class="controls">
        <div class="sort">
          <Menu label={$t('frameleaf_albums_group')} align={stacked.current ? 'start' : 'end'}>
            {#snippet trigger()}
              <Icon icon={mdiFormatListGroup} size="17" aria-hidden={true} />
              <span aria-hidden="true"
                ><span class="muted">{$t('frameleaf_albums_group_by')}</span> {groupLabels[group]()}</span
              >
            {/snippet}
            {#each albumDirectoryGroups as option (option)}
              <MenuItem checked={group === option} onSelect={() => setGroup(option)}>{groupLabels[option]()}</MenuItem>
            {/each}
          </Menu>
        </div>
        <!-- The prototype's sort menu (Collections.jsx:672-683), plus "Custom order" (FL-52). -->
        <div class="sort">
          <Menu label={$t('frameleaf_albums_sort')} align={stacked.current ? 'start' : 'end'}>
            {#snippet trigger()}
              <Icon icon={mdiSortVariant} size="17" aria-hidden={true} />
              <span aria-hidden="true">{sortLabels[view.sort]()}</span>
            {/snippet}
            {#each albumDirectorySorts as sort (sort)}
              <MenuItem checked={view.sort === sort} onSelect={() => setSort(sort)}>{sortLabels[sort]()}</MenuItem>
            {/each}
            <div class="menu-separator" role="separator"></div>
            <MenuItem
              checked={view.collectionsFirst}
              onSelect={() => setView({ collectionsFirst: !view.collectionsFirst })}
            >
              {$t('frameleaf_albums_collections_first')}
            </MenuItem>
            <MenuItem checked={view.hideEmpty} onSelect={() => setView({ hideEmpty: !view.hideEmpty })}>
              {$t('frameleaf_albums_hide_empty')}
            </MenuItem>
          </Menu>
        </div>
        {#if view.sort !== 'custom'}
          <button
            type="button"
            class="order fl-control"
            aria-label={$t('frameleaf_albums_order', { values: { order: orderLabel } })}
            title={$t('frameleaf_albums_order_change')}
            onclick={() => setView({ order: view.order === 'asc' ? 'desc' : 'asc' })}
          >
            <Icon icon={view.order === 'asc' ? mdiSortAscending : mdiSortDescending} size="17" aria-hidden={true} />
            <span>{orderLabel}</span>
          </button>
        {/if}
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
        <!-- After the view switch (FL-1411): the prototype's order with the app's Select added. -->
        <button
          type="button"
          class="select-toggle fl-control"
          aria-pressed={selecting}
          aria-label={selecting ? $t('done') : $t('select')}
          onclick={() => (selecting ? stopSelecting() : (selecting = true))}
        >
          <Icon icon={selecting ? mdiClose : mdiCheckboxMultipleMarkedOutline} size="17" aria-hidden={true} />
          <span>{selecting ? $t('done') : $t('select')}</span>
        </button>
      </div>
    </div>
    {#if spaceInvitations > 0 && !here}
      <!-- SHARING-P9: waiting invitations are not memberships, so they get a line of their own. -->
      <p class="invitations-line">
        <a class="invitations" href={Route.sharing()}>
          {$t('frameleaf_albums_spaces_invitations', { values: { count: spaceInvitations } })}
        </a>
      </p>
    {/if}
    {#if browse.searching}
      <p class="search-note">
        {here
          ? $t('frameleaf_albums_search_results_here', { values: { count: browse.listed.length, name: nameOf(here) } })
          : $t('frameleaf_albums_search_results_all', { values: { count: browse.listed.length } })}
      </p>
    {/if}
  {/if}

  <div class="status" class:has-message={!!status}><Status message={status} {busy} /></div>

  {#each browse.groups as section (section.id)}
    {@const label = groupLabel(section.id, section.albums)}
    {@const key = foldKey(section.id)}
    {@const folded = group !== 'none' && isCollapsed(key)}
    {@const all = shownAll(section.id, section.albums.length)}
    <section class="group" aria-label={label || $t('albums')}>
      {#if group !== 'none'}
        <!-- FL-1836: the same heading for every section, whatever the grouping. -->
        <header class="group-head">
          <h2>
            <button type="button" class="fold" aria-expanded={!folded} onclick={() => toggleCollapsed(key)}>
              <Icon icon={mdiChevronDown} size="18" aria-hidden={true} />
              <span class="fold-label">{label}</span>
              <span class="count">{section.albums.length}</span>
            </button>
          </h2>
          {#if !folded && section.albums.length > PREVIEW + 2}
            <button
              type="button"
              class="link"
              onclick={() => (expanded.has(key) ? expanded.delete(key) : expanded.add(key))}
            >
              {all
                ? $t('frameleaf_albums_show_less')
                : $t('frameleaf_albums_show_all', { values: { count: section.albums.length } })}
            </button>
          {/if}
        </header>
      {/if}
      {#if !folded}
        {@render albums(all ? section.albums : section.albums.slice(0, PREVIEW), '')}
        {#if !all}
          <button type="button" class="more" onclick={() => expanded.add(key)}>
            {$t('frameleaf_albums_show_more', {
              values: { count: section.albums.length - PREVIEW, group: label || $t('albums') },
            })}
          </button>
        {/if}
      {/if}
    </section>
  {/each}

  {#if browse.empty}
    <!-- FL-1412 (M13): the one empty-page pattern. Only a first album leads somewhere, and its button is
         the quiet one: the header's New is this page's one filled button (BRAND.md). With nothing at all
         the controls are gone, so a search or filter left on from before never speaks for the page. -->
    {#if browse.searching && !nothingYet}
      <EmptyState
        icon={mdiImageAlbum}
        title={$t('frameleaf_albums_empty_search_title')}
        message={$t('frameleaf_albums_empty_search_text')}
      />
    {:else if here || browse.hiddenHere > 0}
      <!-- Only empty albums here, and they are hidden: "No albums yet" would be wrong, so say so and offer them. -->
      <EmptyState
        icon={mdiImageAlbum}
        title={$t('frameleaf_albums_empty_here_title')}
        message={$t('frameleaf_albums_empty_here_text')}
        secondaryAction={browse.hiddenHere > 0
          ? { label: $t('frameleaf_albums_show_empty'), onClick: () => setView({ hideEmpty: false }) }
          : undefined}
      />
    {:else if view.filter === 'shared' && !nothingYet}
      <EmptyState
        icon={mdiImageAlbum}
        title={$t('frameleaf_albums_empty_shared_title')}
        message={$t('frameleaf_albums_empty_shared_text')}
      />
    {:else if view.filter === 'smart' && !nothingYet}
      <EmptyState
        icon={mdiImageAlbum}
        title={$t('frameleaf_albums_empty_smart_title')}
        message={$t('frameleaf_albums_empty_smart_text')}
      />
    {:else}
      <EmptyState
        icon={mdiImageAlbum}
        title={$t('frameleaf_albums_empty_title')}
        message={$t('frameleaf_albums_empty_text')}
        secondaryAction={{ label: $t('frameleaf_albums_create_album'), onClick: () => openCreate(AlbumKind.Album) }}
      />
    {/if}
  {/if}

  {#if selecting}
    <div class="bulk-menu">
      <Menu
        label={$t('frameleaf_albums_bulk_actions')}
        hideTrigger
        bind:at={() => bulkMenuAt, (point) => (bulkMenuAt = point)}
      >
        <MenuItem disabled={!allOwned} onSelect={() => actions?.openMoveMany(selectedAlbums)}>
          <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_move_to')}
        </MenuItem>
        <MenuItem disabled={!allMergeable} onSelect={() => actions?.openMergeInto(selectedAlbums)}>
          <Icon icon={mdiCallMerge} size="18" aria-hidden={true} />{$t('frameleaf_albums_merge_into')}
        </MenuItem>
        {#if !allLockable || selectedAlbums.some((album) => !album.isLocked)}
          <MenuItem disabled={!allLockable} onSelect={() => actions?.lockMany(selectedAlbums, true)}>
            <Icon icon={mdiLockOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_lock')}
          </MenuItem>
        {/if}
        {#if allLockable && selectedAlbums.some((album) => album.isLocked)}
          <MenuItem onSelect={() => actions?.lockMany(selectedAlbums, false)}>
            <Icon icon={mdiLockOpenVariantOutline} size="18" aria-hidden={true} />{$t('frameleaf_albums_unlock')}
          </MenuItem>
        {/if}
        <div class="menu-separator" role="separator"></div>
        <MenuItem disabled={!allOwned} onSelect={() => actions?.removeMany(selectedAlbums)}>
          <Icon icon={mdiDeleteOutline} size="18" aria-hidden={true} />{$t('delete')}
        </MenuItem>
      </Menu>
    </div>
    <div
      class="bulk-bar fl-material fl-material-capsule"
      role="toolbar"
      aria-label={$t('frameleaf_albums_bulk_actions')}
    >
      <span class="bulk-count" role="status">
        {$t('frameleaf_albums_selected_count', { values: { count: selectedAlbums.length } })}
      </span>
      <button type="button" onclick={toggleAll} disabled={visibleSelectable.length === 0}>
        {allVisibleSelected ? $t('frameleaf_albums_select_none') : $t('select_all')}
      </button>
      <button type="button" disabled={!allOwned} onclick={() => actions?.openMoveMany(selectedAlbums)}>
        <Icon icon={mdiFolderMoveOutline} size="17" aria-hidden={true} />{$t('frameleaf_albums_move_to')}
      </button>
      <button type="button" disabled={!anyInside} onclick={() => void moveSelectedToTop()}>
        <Icon icon={mdiArrowCollapseUp} size="17" aria-hidden={true} />{$t('frameleaf_albums_move_top')}
      </button>
      <button type="button" disabled={!allMergeable} onclick={() => actions?.openMergeInto(selectedAlbums)}>
        <Icon icon={mdiCallMerge} size="17" aria-hidden={true} />{$t('frameleaf_albums_merge_into')}
      </button>
      {#if !allLockable || selectedAlbums.some((album) => !album.isLocked)}
        <button type="button" disabled={!allLockable} onclick={() => actions?.lockMany(selectedAlbums, true)}>
          <Icon icon={mdiLockOutline} size="17" aria-hidden={true} />{$t('frameleaf_albums_lock')}
        </button>
      {/if}
      {#if allLockable && selectedAlbums.some((album) => album.isLocked)}
        <button type="button" onclick={() => actions?.lockMany(selectedAlbums, false)}>
          <Icon icon={mdiLockOpenVariantOutline} size="17" aria-hidden={true} />{$t('frameleaf_albums_unlock')}
        </button>
      {/if}
      <button type="button" disabled={!allOwned} onclick={() => actions?.removeMany(selectedAlbums)}>
        <Icon icon={mdiDeleteOutline} size="17" aria-hidden={true} />{$t('delete')}
      </button>
      <button type="button" class="bulk-done" onclick={stopSelecting}>{$t('done')}</button>
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
  .tile-tinted :global(.cover-empty) {
    color: var(--mark-light);
  }
  :global([data-theme='dark']) .tile-tinted :global(.cover-empty) {
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
  .row {
    position: relative;
  }
  /* Choosing: the whole tile is the checkbox's label; the box sits on the cover's corner. */
  .pick {
    position: absolute;
    inset: 0;
    z-index: 2;
    cursor: pointer;
    border-radius: var(--fl-radius-card);
  }
  .pick input {
    position: absolute;
    /* 8px into the cover, which starts 8px down to leave room for a collection's stack (FL-1836) */
    inset-block-start: calc(2 * var(--fl-space-2));
    inset-inline-start: var(--fl-space-2);
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--fl-accent);
    cursor: pointer;
  }
  .pick:has(input:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .cell.selected .pick,
  .row.selected .pick {
    box-shadow: inset 0 0 0 2px var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 10%, transparent);
  }
  /* Its height is the shared control floor (44px, 48px on touch), like the controls beside it. */
  .select-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  .select-toggle[aria-pressed='true'] {
    background: var(--fl-text);
    color: var(--fl-canvas);
    border-color: var(--fl-text);
  }
  .bulk-bar {
    position: sticky;
    bottom: calc(var(--fl-space-4) + var(--fl-tabbar-space, 0px));
    z-index: var(--fl-z-dock);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-2);
    width: fit-content;
    max-width: 100%;
    margin-block-start: var(--fl-space-4);
    padding: var(--fl-space-2) var(--fl-space-3);
  }
  /* Only the popup shows, at the pointer; the menu has no trigger. */
  .bulk-menu {
    position: absolute;
  }
  .bulk-count {
    padding-inline: var(--fl-space-2);
    font-weight: 600;
    font-size: var(--fl-font-callout);
  }
  .bulk-bar button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 40px;
    padding: 0 0.75rem;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: inherit;
    font-size: var(--fl-font-callout);
  }
  .bulk-bar button:hover:not(:disabled) {
    background: var(--fl-raised);
  }
  .bulk-bar button:disabled {
    opacity: 0.45;
  }
  .bulk-bar .bulk-done {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  /*
   * A tile's height with a one-line name (AlbumTile: cover, 8px, name, gap, the 28px meta row). A name that
   * takes its second line grows its row when the tile is built, which happens before it reaches the view.
   */
  .placeholder-link {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
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
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4) var(--fl-space-5);
    margin-bottom: var(--fl-space-6);
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
  /* FL-1390: with a mouse the capsule is the control height, as Sort, Select and New beside it are. */
  @media (pointer: fine) {
    .search {
      min-height: var(--fl-control-height);
    }
    .search input {
      align-self: stretch;
      min-height: 0;
      padding-block: 0;
    }
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
    /* The track is the control height: its buttons are that less its 3px padding either side. */
    min-height: calc(var(--fl-control-height) - 6px);
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
    margin: 0;
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
  /*
   * FL-1390: with a mouse a filter chip is the prototype's 32px (collections.css `.al-filters button`).
   * On a narrow window the row scrolls sideways and would clip the chips' 44px click area, so 6px above
   * and below the chips are inside the row; the margins keep the row where it was.
   */
  @media (pointer: fine) {
    .filters button {
      min-height: var(--fl-chip-height);
    }
    .filters {
      --fl-chip-reach: calc((var(--fl-control-target) - var(--fl-chip-height)) / 2);
      padding-block: var(--fl-chip-reach);
      margin-block: calc(-1 * var(--fl-chip-reach));
    }
  }
  .menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
  /* Pills throughout, as the search, Select and the view switch are (collections.css `.al-tools`). */
  .sort :global(.menu-root > button),
  .new-menu :global(.menu-root > button) {
    border-radius: var(--fl-radius-pill);
  }
  /* The prototype's primary New menu trigger (Collections.jsx:702, Menu primary). */
  .new-menu :global(.menu-root > button) {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    /* Select's spacing; 4px less before the plus, whose glyph is inset that much in its box. */
    gap: 0.375rem;
    padding-inline: 0.625rem 0.875rem;
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
  /*
   * FL-1836 (approved 2026-11-27): path bar, the card for the collection being looked inside, one toolbar,
   * and one heading style for every section. 8px between controls, 12px between stacked rows, 24px
   * between sections.
   */
  .heading.over,
  .crumb.over {
    border-radius: var(--fl-radius-card);
    box-shadow: 0 0 0 2px var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent), transparent 88%);
  }
  .path ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1);
    margin: 0;
    margin-inline-start: calc(-1 * var(--fl-space-3));
    padding: 0;
    list-style: none;
  }
  .path li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-width: 0;
    color: var(--fl-muted);
  }
  .crumb {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    max-width: 26rem;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    border-radius: var(--fl-radius-pill);
    color: var(--fl-muted);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumb:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .crumb[aria-current='page'] {
    color: var(--fl-text);
    font-weight: 600;
  }
  .here {
    display: flex;
    align-items: center;
    gap: var(--fl-space-6);
    margin-bottom: var(--fl-space-6);
    padding: var(--fl-space-6);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-xl, var(--fl-radius-card));
    background: var(--fl-panel);
  }
  .here-cover {
    display: grid;
    place-items: center;
    flex: none;
    width: 132px;
    height: 132px;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .here-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .here-text {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .here-text h1 {
    margin: 0;
    font: var(--fl-type-display);
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  .here-text p {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .here-folder {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .here-folder code {
    padding: 2px var(--fl-space-2);
    border-radius: var(--fl-radius-control, var(--fl-radius));
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .here-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-2);
  }
  .here-actions > a,
  .here-actions > button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-text);
    text-decoration: none;
  }
  .here-actions > .primary-link {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3) var(--fl-space-4);
    margin-bottom: var(--fl-space-6);
    padding-bottom: var(--fl-space-4);
    border-bottom: 1px solid var(--fl-border);
  }
  .filters[hidden] {
    display: none;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    margin-inline-start: auto;
  }
  .order {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  .muted {
    color: var(--fl-muted);
  }
  .invitations-line,
  .search-note {
    margin: calc(-1 * var(--fl-space-3)) 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .invitations {
    color: var(--fl-text);
    font-weight: 600;
  }
  .group {
    margin-bottom: var(--fl-space-8);
  }
  .group-head {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    min-height: 44px;
    margin-bottom: var(--fl-space-3);
    background: var(--fl-canvas);
  }
  .fold {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 36px;
    padding: 0 var(--fl-space-2) 0 0;
    border: 0;
    background: none;
    color: var(--fl-text);
  }
  .fold :global(svg) {
    color: var(--fl-muted);
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  .fold[aria-expanded='false'] :global(svg) {
    transform: rotate(-90deg);
  }
  .group-head h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
  }
  .fold {
    font: inherit;
  }
  .notice-slot[hidden] {
    display: none;
  }
  .count {
    min-width: 24px;
    padding: 2px var(--fl-space-2);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-align: center;
  }
  .link {
    min-height: 36px;
    padding: 0 var(--fl-space-3);
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: none;
    color: var(--fl-accent);
    font-weight: 600;
  }
  .link:hover {
    background: var(--fl-raised);
  }
  .more {
    display: block;
    width: 100%;
    min-height: 40px;
    margin-top: var(--fl-space-4);
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: none;
    color: var(--fl-muted);
  }
  .more:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
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
  /*
   * FL-1411 (M12): two rows on a phone, never three. Search has the first; sort, view, Select and New share
   * the second, which fits only when sort and Select show their icon alone. Both keep their accessible name.
   */
  @media (max-width: 520px) {
    .sort :global(.menu-root > button),
    .select-toggle {
      justify-content: center;
      min-width: var(--fl-control-height);
      padding-inline: 0;
    }
    .sort :global(.menu-root > button > span),
    .select-toggle > span {
      display: none;
    }
  }
  @media (max-width: 520px) and (pointer: coarse) {
    .sort :global(.menu-root > button),
    .select-toggle {
      min-width: var(--fl-control-height-touch);
    }
  }
  /* The narrowest phones (320px): New gives up its name too, or it would be alone on a third row. */
  @media (max-width: 340px) {
    .new-menu :global(.menu-root > button) {
      justify-content: center;
      min-width: var(--fl-control-height-touch);
      padding-inline: 0;
    }
    .new-menu :global(.menu-root > button > span) {
      display: none;
    }
  }
  @media (max-width: 700px) {
    .filters button {
      flex: none;
      white-space: nowrap;
    }
    /* On a phone the path is one step back, like the prototype: "‹ Albums". */
    .path li:not(:nth-last-child(2)) {
      display: none;
    }
    .path li > :global(svg),
    .path .crumb > :global(svg) {
      display: none;
    }
    .path .crumb::before {
      content: '‹';
      font-size: 1.4em;
      line-height: 1;
    }
    .here {
      flex-direction: column;
      align-items: flex-start;
      gap: var(--fl-space-4);
      padding: var(--fl-space-4);
    }
    .here-cover {
      width: 96px;
      height: 96px;
    }
    .toolbar {
      flex-direction: column;
      align-items: stretch;
    }
    .controls {
      margin-inline-start: 0;
    }
    .order,
    .muted {
      display: none;
    }
    .head {
      flex-direction: column;
      align-items: stretch;
    }
    .tools {
      flex-wrap: nowrap;
    }
    .tools {
      width: 100%;
    }
    .search {
      min-width: 0;
      flex: 1 1 auto;
    }
    /* collections.css @700px: the New menu keeps to the right edge, under the search's end. */
    .new-menu {
      margin-inline-start: auto;
    }
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      /* FL-1390: a chip's click area reaches past it; it must not make the row scroll up and down. */
      overflow-y: hidden;
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
