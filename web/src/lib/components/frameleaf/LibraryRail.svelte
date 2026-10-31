<script lang="ts">
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import RailSavedSearches from '$lib/components/frameleaf/RailSavedSearches.svelte';
  import Sidebar from '$lib/components/sidebar/Sidebar.svelte';
  import {
    DISCOVERY_QUERY_PARAMETER,
    discoveryUrl,
    emptyDiscoveryQuery,
    parseDiscoveryQueryText,
    readDiscoveryQuery,
  } from '$lib/components/discovery/query';
  import { fromSavedSearch } from '$lib/frameleaf/search-palette';
  import { eagleImportUi, eaglePercent } from '$lib/frameleaf/eagle/eagle-import-status.svelte';
  import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import {
    buildAlbumTree,
    emptyAlbumTree,
    type FrameleafAlbumNode,
    type FrameleafAlbumTree,
  } from '$lib/frameleaf/album-tree';
  import {
    buildPhoneMenuDestinations,
    buildRailSections,
    currentPrimaryDestination,
    FOLDABLE_RAIL_SECTIONS,
    isClientsEnabled,
    isDestinationCurrent,
    readClosedRailSections,
    toggleRailSection,
    type RailDestination,
    type RailSectionId,
  } from '$lib/frameleaf/navigation';
  import { helpPanel } from '$lib/frameleaf/help-panel.svelte';
  import { canAnimate, prefersReducedMotion } from '$lib/frameleaf/motion';
  import { DURATION } from '$lib/frameleaf/tokens';
  import '$lib/frameleaf/tokens.css';
  import { searchContextFor, workspaceHref } from '$lib/frameleaf/search-context';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { albumTreeDropdown, sidebarCollapsed } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetTypeEnum,
    LibraryItemSearchKind,
    LibraryScope,
    LibraryViewScope,
    getAlbumHierarchy,
    type AlbumResponseDto,
    searchLibraryItems,
    type SearchFilter,
    getPartners,
    PartnerDirection,
    type PartnerResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import {
    mdiAccountOutline,
    mdiChevronDoubleLeft,
    mdiChevronDoubleRight,
    mdiChevronDown,
    mdiChevronRight,
    mdiClose,
    mdiFilterVariant,
    mdiHelpCircleOutline,
    mdiImageOutline,
    mdiImport,
    mdiInboxOutline,
    mdiLinkVariant,
    mdiPaletteOutline,
    mdiPlus,
    mdiPuzzleOutline,
    mdiVideoOutline,
    mdiViewDashboardOutline,
  } from '@mdi/js';
  import { debounce } from 'lodash-es';
  import { onMount, onDestroy, untrack, type Snippet } from 'svelte';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

  /**
   * Frameleaf library rail (FL-30).
   *
   * The navigation `UserSidebar` renders. It reuses the production sidebar container, so
   * the mobile overlay, the focus
   * trap, the resize handle and the remembered collapse preference keep working; only
   * the contents are the Frameleaf ones. Destinations come from
   * `$lib/frameleaf/navigation`, the album and collection shape from
   * `$lib/frameleaf/album-tree`.
   *
   * September 24 polish pass (`LibraryRail.jsx`): each labelled section folds away from its
   * heading, remembered per device, and the icon-only rail — which has no headings to reopen a
   * section — always shows everything. Albums and Shared spaces each carry a "+" that opens the
   * Albums page with that create dialog, a request the page consumes so All albums never replays it.
   *
   * As in the prototype, the header ("Library" beside the collapse toggle) and the footer (Library
   * Care, Settings, Support) keep their places and only the list between them scrolls.
   */

  interface Props {
    /** Extra content from the hosting route, rendered below the navigation. */
    children?: Snippet;
  }

  let { children }: Props = $props();

  let tree = $state<FrameleafAlbumTree>(emptyAlbumTree());
  const albumRoots = $derived(
    (tree.roots ?? [...tree.collections, ...tree.albums]).filter(({ kind }) => kind !== 'space'),
  );
  /** Sections folded on this device (`frameleaf.rail.closedSections`, as in the prototype). */
  let closedSections = $state<RailSectionId[]>(readClosedRailSections(browser ? localStorage : undefined));
  const foldSection = (id: RailSectionId) => {
    closedSections = toggleRailSection(closedSections, id, browser ? localStorage : undefined);
  };
  /** The "+" beside a heading: New album, New shared space (`addButton` in LibraryRail.jsx). */
  const SECTION_CREATE: Partial<Record<RailSectionId, { labelKey: Translations; href: string }>> = {
    albums: { labelKey: 'frameleaf_albums_create_album', href: Route.newAlbum({ kind: 'album' }) },
    spaces: { labelKey: 'frameleaf_spaces_new', href: Route.newAlbum({ kind: 'space' }) },
  };

  /** Collections whose open state the user has flipped away from the saved default. */
  const flipped = new SvelteSet<string>();

  let treeRequest = 0;
  /**
   * The workspace the URL names; failing that, a Boards collection opened by its own address
   * (`/albums/<id>`) is still in Boards (FL-670).
   */
  const workspaceScope = $derived(
    searchContextFor(new URL(page.url.href)).query.filter.libraryScope ??
      ((page.data as { album?: AlbumResponseDto } | undefined)?.album?.libraryScope === LibraryScope.Design
        ? LibraryViewScope.Design
        : undefined),
  );
  const scopedHref = (href: string) => workspaceHref(href, workspaceScope, page.url.origin);
  const refreshAlbums = async (scope = workspaceScope) => {
    const version = ++treeRequest;
    const current = authManager.captureSession();
    try {
      const response = await getAlbumHierarchy(scope ? { libraryScope: scope } : {});
      if (version === treeRequest && current() && scope === workspaceScope) {
        tree = buildAlbumTree(response);
      }
    } catch (error) {
      if (version === treeRequest && current()) {
        handleError(error, $t('errors.frameleaf_unable_to_load_albums'));
      }
    }
  };
  $effect(() => {
    const scope = workspaceScope;
    untrack(() => {
      tree = emptyAlbumTree();
      void refreshAlbums(scope);
    });
  });
  onDestroy(() => treeRequest++);
  onDestroy(
    onLibraryAccessChange(() => {
      treeRequest++;
      partnerRequest++;
      tree = emptyAlbumTree();
      partners = [];
      if (authManager.authenticated) {
        void refreshAlbums();
        void refreshPartners();
      }
    }),
  );

  /** People who share their library with this account (the prototype's partner library entry). */
  let partners = $state<PartnerResponseDto[]>([]);
  let partnerRequest = 0;
  onDestroy(() => partnerRequest++);
  const refreshPartners = async () => {
    const version = ++partnerRequest;
    const current = authManager.captureSession();
    try {
      const response = await getPartners({ direction: PartnerDirection.SharedWith });
      if (version === partnerRequest && current()) {
        partners = response;
      }
    } catch {
      // The rail still works without the entry; the Sharing page reports partner errors.
      if (version === partnerRequest && current()) {
        partners = [];
      }
    }
  };

  const refreshAccessAlbums = () => {
    tree = emptyAlbumTree();
    void refreshAlbums();
  };
  onMount(() => {
    void refreshPartners();
    void savedSearchesStore.load();

    return eventManager.on({
      AlbumAddAssets: refreshBoardsCountsSoon,
      AlbumRemoveAssets: refreshBoardsCountsSoon,
      AlbumCreate: () => void refreshAlbums(),
      AlbumUpdate: () => void refreshAlbums(),
      AlbumDelete: refreshAccessAlbums,
      AlbumShare: refreshAccessAlbums,
      AlbumUserUpdate: refreshAccessAlbums,
      AlbumUserDelete: refreshAccessAlbums,
    });
  });

  const preferences = $derived(authManager.authenticated ? authManager.preferences : undefined);

  const sections = $derived(
    buildRailSections({
      search: featureFlagsManager.value.search || workspaceScope === LibraryViewScope.Design,
      map: featureFlagsManager.value.map,
      trash: featureFlagsManager.value.trash,
      // Feature preferences are the account's own display choices, never permissions:
      // hiding a destination here does not revoke data or API access.
      recentlyAdded: !!preferences?.recentlyAdded.sidebarWeb,
      people: !!preferences?.people.enabled && preferences.people.sidebarWeb,
      memories: !!preferences?.memories.enabled && preferences.memories.sidebarWeb,
      tags: !!preferences?.tags.enabled && preferences.tags.sidebarWeb,
      folders: !!preferences?.folders.enabled && preferences.folders.sidebarWeb,
      sharedLinks: !!preferences?.sharedLinks.enabled && preferences.sharedLinks.sidebarWeb,
      // Clients sits in the top bar once the account starts using it, and leaves Tools.
      clients: isClientsEnabled(preferences),
    }),
  );

  /** The list scrolls; the footer's entries stay at the foot of the rail (`sidebar-bottom`). */
  const listSections = $derived(sections.filter(({ id }) => id !== 'footer'));
  // Once the server or the person has a supporter key, "Support Frameleaf" thanks them instead
  // (owner 2026-10-16, option c). It still opens the same page.
  const footerDestinations = $derived(
    (sections.find(({ id }) => id === 'footer')?.destinations ?? []).map((destination) =>
      destination.id === 'support' && authManager.isPurchased
        ? { ...destination, labelKey: 'frameleaf_support_thanks' as Translations }
        : destination,
    ),
  );

  const pathname = $derived(page.url.pathname);
  /** UI review 2026-10-30 #8: Boards, Clients, Studio and Activity head the phone menu, then Help. */
  const phoneSections = $derived(buildPhoneMenuDestinations({ clients: isClientsEnabled(preferences) }));
  const openHelp = () => {
    sidebarStore.reset();
    helpPanel.open = true;
  };
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  // The icon-only rail applies on desktop only; the mobile sidebar is a full overlay.
  const wantsIconOnly = $derived($sidebarCollapsed && mediaQueryManager.isFullSidebar);
  /**
   * Collapsing is one gesture (review finding 126): the rail narrows over `--fl-duration` while its
   * labels fade, and only once it is narrow do the rows become icon-only. Taking the labels out at
   * once made the text vanish before the rail had moved. Opening has nothing to wait for. Under
   * Reduce Motion, and wherever nothing animates, the change is immediate.
   */
  let railElement = $state<HTMLElement>();
  let iconOnly = $state(untrack(() => wantsIconOnly));
  let collapsing = $state(false);
  $effect(() => {
    if (!wantsIconOnly) {
      collapsing = false;
      iconOnly = false;
      return;
    }
    if (untrack(() => iconOnly)) {
      return;
    }
    if (prefersReducedMotion() || !canAnimate(untrack(() => railElement))) {
      iconOnly = true;
      return;
    }
    collapsing = true;
    const timer = setTimeout(() => {
      iconOnly = true;
      collapsing = false;
    }, DURATION.spring);
    return () => clearTimeout(timer);
  });
  const isSectionOpen = (id: RailSectionId) =>
    iconOnly || !FOLDABLE_RAIL_SECTIONS.includes(id) || !closedSections.includes(id);

  const isAlbumCurrent = (node: FrameleafAlbumNode) => pathname.startsWith(Route.viewAlbum({ id: node.id }));
  // A shared space has its own page and is still browsed through the album view, so either is "here".
  const isSpaceCurrent = (node: FrameleafAlbumNode) =>
    isAlbumCurrent(node) || pathname.startsWith(Route.viewSharedSpace({ id: node.id }));
  const isCollectionCurrent = (collection: FrameleafAlbumNode): boolean =>
    isAlbumCurrent(collection) || collection.children.some((child) => isCollectionCurrent(child));

  // The saved album-tree preference is the default for every collection; a collection
  // the user opens or closes keeps its own state for this session.
  const isCollectionOpen = (id: string) => (flipped.has(id) ? !$albumTreeDropdown : $albumTreeDropdown);
  const toggleCollection = (id: string) => {
    if (flipped.has(id)) {
      flipped.delete(id);
    } else {
      flipped.add(id);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Boards (FL-622): the rail of the Design workspace                    */
  /* ------------------------------------------------------------------ */

  /**
   * In Boards (`/pro`, and a collection opened from it) the rail is Boards' own (prototype
   * `ProWorkspace` rail, README point 1): All items, Images, Videos, Links and Unfiled with counts,
   * the collections as a tree with their own icons, colours and counts, the smart collections
   * saved from the filter bar, and "Get the browser extension" at the foot. On narrower screens the
   * drawer becomes the "Collections and filters" bottom sheet (README point 13).
   */
  const boards = $derived(workspaceScope === LibraryViewScope.Design);
  /** The phone menu's current section (Boards here, also on a Boards collection). */
  const currentSection = $derived(currentPrimaryDestination(pathname, boards));
  type BoardsItemId = 'all' | 'images' | 'videos' | 'links' | 'unfiled';
  /** The parameter Boards' Links view sets: the server's `kinds` on library item search. */
  const BOARDS_KINDS_PARAMETER = 'kinds';
  const boardsFilter = (filter: SearchFilter = {}): SearchFilter => ({
    libraryScope: LibraryViewScope.Design,
    ...filter,
  });
  const boardsHref = (filter: SearchFilter) => discoveryUrl({ ...emptyDiscoveryQuery(), filter: boardsFilter(filter) });
  const BOARDS_ITEMS: {
    id: BoardsItemId;
    labelKey: Translations;
    icon: string;
    href: string;
    filter: SearchFilter;
    kinds?: LibraryItemSearchKind[];
  }[] = [
    { id: 'all', labelKey: 'frameleaf_boards_all_items', icon: mdiViewDashboardOutline, href: '/pro', filter: {} },
    {
      id: 'images',
      labelKey: 'frameleaf_boards_images',
      icon: mdiImageOutline,
      href: boardsHref({ type: { eq: AssetTypeEnum.Image } }),
      filter: { type: { eq: AssetTypeEnum.Image } },
      kinds: [LibraryItemSearchKind.Asset],
    },
    {
      id: 'videos',
      labelKey: 'frameleaf_boards_videos',
      icon: mdiVideoOutline,
      href: boardsHref({ type: { eq: AssetTypeEnum.Video } }),
      filter: { type: { eq: AssetTypeEnum.Video } },
      kinds: [LibraryItemSearchKind.Asset],
    },
    {
      id: 'links',
      labelKey: 'frameleaf_boards_links',
      icon: mdiLinkVariant,
      href: `/pro?${new URLSearchParams({ [BOARDS_KINDS_PARAMETER]: LibraryItemSearchKind.Bookmark })}`,
      filter: {},
      kinds: [LibraryItemSearchKind.Bookmark],
    },
    {
      id: 'unfiled',
      labelKey: 'frameleaf_pro_unfiled',
      icon: mdiInboxOutline,
      href: boardsHref({ hasAlbums: { eq: false } }),
      filter: { hasAlbums: { eq: false } },
    },
  ];

  const onBoardsPage = $derived(/^\/pro(?:\/|$)/.test(pathname));
  /** Which of All items, Images, Videos, Links and Unfiled `/pro` is showing, if one. */
  const boardsCurrent = $derived.by((): BoardsItemId | undefined => {
    if (!onBoardsPage) {
      return;
    }
    const url = new URL(page.url.href);
    if (url.searchParams.get(BOARDS_KINDS_PARAMETER) === LibraryItemSearchKind.Bookmark) {
      return 'links';
    }
    const filter = readDiscoveryQuery(url).filter as SearchFilter;
    const type = (filter.type as { eq?: string } | undefined)?.eq;
    if (type === AssetTypeEnum.Image) {
      return 'images';
    }
    if (type === AssetTypeEnum.Video) {
      return 'videos';
    }
    if (filter.hasAlbums?.eq === false) {
      return 'unfiled';
    }
    if (smartCurrent || filter.albumIds) {
      return;
    }
    return 'all';
  });

  /** Item counts beside All items … Unfiled; a count that cannot be read is simply left out. */
  let boardsCounts = $state<Partial<Record<BoardsItemId, number>>>({});
  let countsRequest = 0;
  const refreshBoardsCounts = async () => {
    const version = ++countsRequest;
    const current = authManager.captureSession();
    const results = await Promise.all(
      BOARDS_ITEMS.map(async (item) => {
        try {
          const response = await searchLibraryItems({
            libraryItemSearchDto: {
              filter: boardsFilter(item.filter),
              limit: 1,
              ...(item.kinds && { kinds: item.kinds }),
            },
          });
          return [item.id, response.count] as const;
        } catch {
          return [item.id, undefined] as const;
        }
      }),
    );
    if (version === countsRequest && current()) {
      boardsCounts = Object.fromEntries(results.filter(([, count]) => count !== undefined));
    }
  };
  const refreshBoardsCountsSoon = debounce(() => {
    if (boards && authManager.authenticated) {
      void refreshBoardsCounts();
    }
  }, 1000);
  $effect(() => {
    if (boards) {
      untrack(() => void refreshBoardsCounts());
    } else {
      countsRequest++;
      boardsCounts = {};
    }
  });
  onDestroy(() => {
    countsRequest++;
    refreshBoardsCountsSoon.cancel();
  });
  onDestroy(websocketEvents.on('on_upload_success', refreshBoardsCountsSoon));
  onDestroy(websocketEvents.on('on_asset_delete', refreshBoardsCountsSoon));
  onDestroy(websocketEvents.on('on_asset_trash', refreshBoardsCountsSoon));

  /** Smart collections: the saved searches made in Boards (saved from its filter bar). */
  const smartCollections = $derived(
    savedSearchesStore.list.flatMap((item) => {
      const query = fromSavedSearch(item);
      return query && query.filter.libraryScope === LibraryViewScope.Design
        ? [{ name: item.name, query, href: discoveryUrl(query), color: !!query.filter.color }]
        : [];
    }),
  );
  const smartCurrent = $derived.by(() => {
    if (!onBoardsPage) {
      return;
    }
    const raw = page.url.searchParams.get(DISCOVERY_QUERY_PARAMETER);
    const parsed = raw ? parseDiscoveryQueryText(raw) : undefined;
    if (!parsed?.ok) {
      return;
    }
    const shown = JSON.stringify(parsed.query);
    return smartCollections.find(({ query }) => JSON.stringify(query) === shown)?.name;
  });

  let extensionOpen = $state(false);
  /** An Eagle import carrying on with its dialog hidden (prototype `EagleStatus`). */
  const eagleRunning = $derived(
    eagleImportUi.run && (eagleImportUi.run.state === 'running' || eagleImportUi.run.state === 'stopping')
      ? eagleImportUi.run
      : undefined,
  );

  /**
   * Narrower screens: the drawer is a bottom sheet in Boards. The sheet is the production sidebar
   * restyled (it keeps the focus trap, Escape and click-outside), keyed on the document so the
   * layout's own column is left alone everywhere else.
   */
  $effect(() => {
    if (!browser) {
      return;
    }
    const root = document.documentElement;
    if (boards) {
      root.dataset.flBoardsRail = '';
    } else {
      delete root.dataset.flBoardsRail;
    }
    return () => {
      delete root.dataset.flBoardsRail;
    };
  });
</script>

{#snippet railLink(label: string, icon: string | FrameleafAlbumNode, href: string, current: boolean, nested: boolean)}
  <a
    {href}
    class="fl-link"
    class:fl-nested={nested && !iconOnly}
    class:fl-current={current}
    aria-current={current ? 'page' : undefined}
    title={iconOnly || nested ? label : undefined}
    aria-label={iconOnly ? label : undefined}
    data-sveltekit-preload-data="hover"
  >
    {#if typeof icon === 'string'}
      <Icon {icon} size="1.25em" aria-hidden={true} class="fl-icon" />
    {:else}
      <AlbumMark icon={icon.icon} color={icon.color} size="1.25em" class="fl-icon" />
    {/if}
    {#if !iconOnly}<span class="fl-label">{label}</span>{/if}
    {#if boards && typeof icon !== 'string' && !iconOnly}<small class="fl-count">{icon.itemCount}</small>{/if}
  </a>
{/snippet}

{#snippet destinationLink(destination: RailDestination)}
  {@render railLink(
    $t(destination.labelKey),
    destination.icon,
    destination.href,
    isDestinationCurrent(new URL(page.url.href), destination),
    false,
  )}
{/snippet}

{#snippet albumBranch(node: FrameleafAlbumNode)}
  {#if node.children.length > 0 || node.kind === 'collection'}
    <div class="nested-branch">
      <div class="fl-branch" class:fl-current={isCollectionCurrent(node)}>
        <!-- The twisty only opens the branch; the node keeps its own page,
                   so every album and node stays reachable from the rail. -->
        <button
          type="button"
          class="fl-twisty"
          aria-label={$t(
            isCollectionOpen(node.id) ? 'frameleaf_rail_collapse_collection' : 'frameleaf_rail_expand_collection',
            { values: { name: node.name } },
          )}
          aria-expanded={isCollectionOpen(node.id)}
          onclick={() => toggleCollection(node.id)}
        >
          <!-- One chevron that turns, in step with the section headings. -->
          <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} class="fl-chevron" />
        </button>
        <a
          href={scopedHref(Route.viewAlbum({ id: node.id }))}
          class="fl-link"
          aria-current={isAlbumCurrent(node) ? 'page' : undefined}
          data-sveltekit-preload-data="hover"
        >
          <AlbumMark icon={node.icon} color={node.color} size="1.25em" class="fl-icon" />
          <span class="fl-label" title={node.name}>{node.name}</span>
          {#if boards}<small class="fl-count">{node.itemCount}</small>{/if}
        </a>
      </div>
      {#if isCollectionOpen(node.id)}
        {#each node.children as album (album.id)}
          {@render albumBranch(album)}
        {/each}
      {/if}
    </div>
  {:else}
    {@render albumLink(node)}
  {/if}
{/snippet}

{#snippet albumLink(node: FrameleafAlbumNode)}
  {@render railLink(node.name, node, scopedHref(Route.viewAlbum({ id: node.id })), isAlbumCurrent(node), true)}
{/snippet}

{#snippet spaceLink(node: FrameleafAlbumNode)}
  {@render railLink(node.name, node, Route.viewSharedSpace({ id: node.id }), isSpaceCurrent(node), true)}
{/snippet}

{#snippet boardsList()}
  <!-- Narrower screens: the drawer is the "Collections and filters" sheet, with its own close. -->
  <div class="fl-boards-sheet-head">
    <h2>{$t('frameleaf_boards_collections_and_filters')}</h2>
    <button type="button" class="fl-rail-toggle" aria-label={$t('close')} onclick={() => sidebarStore.reset()}>
      <Icon icon={mdiClose} size="18" aria-hidden={true} />
    </button>
  </div>
  <nav class="fl-section" aria-label={$t('frameleaf_boards_items')}>
    {#each BOARDS_ITEMS as item (item.id)}
      {@const current = boardsCurrent === item.id}
      <a
        href={item.href}
        class="fl-link"
        class:fl-current={current}
        aria-current={current ? 'page' : undefined}
        title={iconOnly ? $t(item.labelKey) : undefined}
        aria-label={iconOnly ? $t(item.labelKey) : undefined}
        data-sveltekit-preload-data="hover"
      >
        <Icon icon={item.icon} size="1.25em" aria-hidden={true} class="fl-icon" />
        {#if !iconOnly}
          <span class="fl-label">{$t(item.labelKey)}</span>
          {#if boardsCounts[item.id] !== undefined}<small class="fl-count">{boardsCounts[item.id]}</small>{/if}
        {/if}
      </a>
    {/each}
  </nav>

  {#if iconOnly}
    <div class="fl-heading fl-heading-rule" aria-hidden="true"></div>
  {:else}
    <div class="fl-heading">
      <h2>{$t('frameleaf_boards_collections')}</h2>
      <a
        class="fl-action"
        href={scopedHref(Route.newAlbum({ kind: 'album' }))}
        title={$t('frameleaf_boards_new_collection')}
        aria-label={$t('frameleaf_boards_new_collection')}
        data-sveltekit-preload-data="hover"
      >
        <Icon icon={mdiPlus} size="1em" aria-hidden={true} />
      </a>
    </div>
  {/if}
  <div class="fl-section" role="group" aria-label={$t('frameleaf_boards_collections')}>
    {#if iconOnly}
      {#each albumRoots as node (node.id)}
        {@render railLink(
          node.name,
          node,
          scopedHref(Route.viewAlbum({ id: node.id })),
          isCollectionCurrent(node),
          false,
        )}
      {/each}
    {:else}
      {#each albumRoots as node (node.id)}
        {@render albumBranch(node)}
      {:else}
        <p class="fl-empty">{$t('frameleaf_boards_no_collections')}</p>
      {/each}
    {/if}
  </div>

  {#if smartCollections.length > 0}
    {#if iconOnly}
      <div class="fl-heading fl-heading-rule" aria-hidden="true"></div>
    {:else}
      <div class="fl-heading"><h2>{$t('frameleaf_boards_smart_collections')}</h2></div>
    {/if}
    <nav class="fl-section" aria-label={$t('frameleaf_boards_smart_collections')}>
      {#each smartCollections as smart (smart.name)}
        {@const current = smartCurrent === smart.name}
        <a
          href={smart.href}
          class="fl-link"
          class:fl-current={current}
          aria-current={current ? 'page' : undefined}
          title={iconOnly ? smart.name : undefined}
          aria-label={iconOnly ? smart.name : undefined}
        >
          <Icon
            icon={smart.color ? mdiPaletteOutline : mdiFilterVariant}
            size="1.25em"
            aria-hidden={true}
            class="fl-icon"
          />
          {#if !iconOnly}<span class="fl-label">{smart.name}</span>{/if}
        </a>
      {/each}
    </nav>
  {/if}
{/snippet}

{#snippet railHeader({ collapsed, toggle }: { collapsed: boolean; toggle: () => void })}
  <!--
    LibraryRail.jsx `rail-header`: the "Library" label and the double-chevron toggle (desktop). The
    landmark is already named "Library navigation", so the label is for the eye only.
  -->
  <div
    class="frameleaf fl-rail-header"
    class:fl-icon-only={collapsed && iconOnly}
    class:is-collapsing={collapsing}
    data-theme={appTheme}
  >
    {#if !iconOnly && boards}
      <!-- Boards' rail title with its "Free" badge (prototype .pro-rail-title). -->
      <span class="fl-rail-title fl-rail-text fl-boards-title">
        <span aria-hidden="true">{$t('frameleaf_pro_title')}</span>
        <span class="fl-free" title={$t('frameleaf_boards_free_hint')}>{$t('frameleaf_boards_free')}</span>
      </span>
    {:else if !iconOnly}
      <span class="fl-rail-title fl-rail-text" aria-hidden="true">{$t('library')}</span>
    {/if}
    <button
      type="button"
      class="fl-rail-toggle"
      aria-expanded={!collapsed}
      aria-label={collapsed ? $t('frameleaf_rail_expand') : $t('frameleaf_rail_collapse')}
      title={collapsed ? $t('frameleaf_rail_expand') : $t('frameleaf_rail_collapse')}
      onclick={toggle}
    >
      <Icon icon={collapsed ? mdiChevronDoubleRight : mdiChevronDoubleLeft} size="18" aria-hidden={true} />
    </button>
  </div>
{/snippet}

{#snippet railFooter()}
  <div
    class="frameleaf fl-rail-footer"
    class:fl-icon-only={iconOnly}
    class:is-collapsing={collapsing}
    data-theme={appTheme}
  >
    {#if boards}
      {#if eagleRunning}
        {@const percent = eaglePercent(eagleRunning)}
        <button
          type="button"
          class="fl-link fl-eagle-status"
          title={iconOnly ? $t('frameleaf_eagle_status_running') : undefined}
          aria-label={iconOnly ? $t('frameleaf_eagle_status_running') : undefined}
          aria-haspopup="dialog"
          onclick={() => eagleImportUi.show()}
        >
          <Icon icon={mdiImport} size="1.25em" aria-hidden={true} class="fl-icon" />
          {#if !iconOnly}
            <span class="fl-label fl-eagle-label">
              {$t('frameleaf_eagle_status_running')}
              <span
                class="fl-eagle-bar"
                role="progressbar"
                aria-label={$t('frameleaf_eagle_status_label')}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}><span style:width="{percent}%"></span></span
              >
            </span>
            <small class="fl-count">{percent}%</small>
          {/if}
        </button>
      {/if}
      <button
        type="button"
        class="fl-link"
        title={iconOnly ? $t('frameleaf_eagle_import_open') : undefined}
        aria-label={iconOnly ? $t('frameleaf_eagle_import_open') : undefined}
        aria-haspopup="dialog"
        onclick={() => eagleImportUi.show()}
      >
        <Icon icon={mdiImport} size="1.25em" aria-hidden={true} class="fl-icon" />
        {#if !iconOnly}<span class="fl-label">{$t('frameleaf_eagle_import_open')}</span>{/if}
      </button>
      <button
        type="button"
        class="fl-link"
        title={iconOnly ? $t('frameleaf_boards_get_extension') : undefined}
        aria-label={iconOnly ? $t('frameleaf_boards_get_extension') : undefined}
        aria-haspopup="dialog"
        onclick={() => (extensionOpen = true)}
      >
        <Icon icon={mdiPuzzleOutline} size="1.25em" aria-hidden={true} class="fl-icon" />
        {#if !iconOnly}<span class="fl-label">{$t('frameleaf_boards_get_extension')}</span>{/if}
      </button>
    {/if}
    {#each footerDestinations as destination (destination.id)}
      {@render destinationLink(destination)}
    {/each}
  </div>
{/snippet}

<Sidebar ariaLabel={$t('frameleaf_rail_navigation')} header={railHeader} footer={railFooter}>
  <div
    bind:this={railElement}
    class="frameleaf fl-rail"
    class:fl-icon-only={iconOnly}
    class:is-collapsing={collapsing}
    data-theme={appTheme}
  >
    <!-- Phones only (≤700px): the top bar has no section tabs, so the sections open from here. -->
    {#if !iconOnly}
      <div class="fl-phone-sections" role="group" aria-label={$t('frameleaf_primary_navigation')}>
        {#each phoneSections as section (section.id)}
          {@render railLink($t(section.labelKey), section.icon, section.href, currentSection === section.id, false)}
        {/each}
        <button type="button" class="fl-link" aria-haspopup="dialog" onclick={openHelp}>
          <Icon icon={mdiHelpCircleOutline} size="1.25em" aria-hidden={true} class="fl-icon" />
          <span class="fl-label">{$t('frameleaf_help_panel_open')}</span>
        </button>
      </div>
    {/if}
    {#if boards}
      {@render boardsList()}
    {:else}
      {#each listSections as section (section.id)}
        {#if section.labelKey && iconOnly}
          <!-- `.sidebar.rail-collapsed .nav-heading`: the icon-only rail keeps a hairline per section. -->
          <div class="fl-heading fl-heading-rule" aria-hidden="true"></div>
        {:else if section.labelKey}
          {@const create = SECTION_CREATE[section.id]}
          <div class="fl-heading">
            <!-- The heading folds its section away (LibraryRail.jsx `heading`). -->
            <h2>
              <button
                type="button"
                class="fl-heading-toggle"
                aria-expanded={isSectionOpen(section.id)}
                aria-controls="fl-rail-section-{section.id}"
                onclick={() => foldSection(section.id)}
              >
                {$t(section.labelKey)}
                <Icon icon={mdiChevronDown} size="14" aria-hidden={true} class="fl-heading-chevron" />
              </button>
            </h2>
            {#if create}
              <a
                class="fl-action"
                href={scopedHref(create.href)}
                title={$t(create.labelKey)}
                aria-label={$t(create.labelKey)}
                data-sveltekit-preload-data="hover"
              >
                <Icon icon={mdiPlus} size="1em" aria-hidden={true} />
              </a>
            {/if}
          </div>
        {/if}

        <!--
        The section folds with its chevron: the wrapper's one grid row runs between 1fr and 0fr, and
        a closed section is inert and hidden once the fold has finished, so it keeps no tab stops.
      -->
        <div class="fl-fold" data-open={isSectionOpen(section.id)}>
          <div
            class="fl-section"
            id="fl-rail-section-{section.id}"
            inert={!isSectionOpen(section.id)}
            aria-hidden={isSectionOpen(section.id) ? undefined : 'true'}
          >
            {#each section.destinations as destination (destination.id)}
              {@render destinationLink(destination)}

              {#if destination.id === 'allAlbums' && !iconOnly}
                {#each albumRoots as node (node.id)}
                  {@render albumBranch(node)}
                {/each}
              {/if}
              {#if destination.id === 'allAlbums'}
                <!-- LibraryRail.jsx: saved searches follow the album tree, before Shared links. -->
                <RailSavedSearches {iconOnly} />
              {/if}
            {/each}

            {#if section.id === 'spaces'}
              {#if !iconOnly}
                {#each tree.spaces as space (space.id)}
                  {@render spaceLink(space)}
                {/each}
              {/if}
              <!-- LibraryRail.jsx: each partner's library follows the spaces ("Jamie's library"). -->
              {#each partners as partner (partner.id)}
                {@render railLink(
                  $t('frameleaf_rail_partner_library', { values: { name: partner.name } }),
                  mdiAccountOutline,
                  Route.viewPartner({ id: partner.id }),
                  pathname.startsWith(Route.viewPartner({ id: partner.id })),
                  false,
                )}
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    {/if}

    {@render children?.()}
  </div>
</Sidebar>

{#if extensionOpen}{#await import('$lib/components/frameleaf/BoardsExtensionDialog.svelte') then { default: BoardsExtensionDialog }}
    <BoardsExtensionDialog bind:open={extensionOpen} />
  {/await}{/if}
<!-- Import from Eagle (FL-653), opened from the rail or Boards' Add menu; loaded only when used. -->
{#if eagleImportUi.open}{#await import('$lib/components/frameleaf/eagle/BoardsEagleImportDialog.svelte') then { default: BoardsEagleImportDialog }}
    <BoardsEagleImportDialog />
  {/await}{/if}

<style>
  .nested-branch .nested-branch {
    margin-inline-start: 12px;
  }
  /* S-28: the rail follows styles.css:291-357 and 1674-1729 (flat full-width rows, 34px, 22px
     inset, 11px uppercase headings over a hairline, the accent tint with an inset bar). */
  .fl-rail,
  .fl-rail-footer {
    display: flex;
    flex-direction: column;
    background: var(--fl-panel);
    font-size: 13px;
  }
  /* `.sidebar-bottom`: Library Care, Settings and Support stay at the foot of the rail. */
  .fl-rail-footer {
    flex-shrink: 0;
    gap: 0.125rem;
    padding-top: 10px;
    border-top: 1px solid var(--fl-border);
  }
  .fl-rail-footer.fl-icon-only {
    padding-top: 8px;
  }
  .fl-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin: 8px 0 0;
    padding: 10px 22px 6px 21px;
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
  }
  .fl-heading-rule {
    height: 1px;
    margin: 10px 12px;
    padding: 0;
  }
  .fl-heading h2 {
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0.7px;
    text-transform: uppercase;
    margin: 0;
  }
  .fl-rail-header {
    display: none;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    height: 44px;
    padding: 0 12px 0 22px;
    color: var(--fl-muted);
    background: var(--fl-panel);
  }
  .fl-rail-title {
    min-width: 0;
    overflow: hidden;
    font-size: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-rail-header.fl-icon-only {
    justify-content: center;
    padding-inline: 0;
  }
  /*
   * While the rail narrows, everything that is text fades and the icons stay where they are; the
   * rows turn icon-only when the width has arrived. Nothing here can be pressed in the meantime.
   */
  .fl-rail :global(.fl-label),
  .fl-rail-footer :global(.fl-label),
  .fl-heading,
  .fl-twisty,
  .fl-rail-title,
  .fl-rail :global(.fl-rail-text) {
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .is-collapsing :global(.fl-label),
  .is-collapsing .fl-heading,
  .is-collapsing .fl-twisty,
  .is-collapsing :global(.fl-rail-text) {
    opacity: 0;
    pointer-events: none;
  }
  .is-collapsing {
    overflow: hidden;
    white-space: nowrap;
  }
  /* Narrower screens open and close the drawer from the top bar's menu button. */
  @media (min-width: 850px) {
    .fl-rail-header {
      display: flex;
    }
  }
  .fl-rail-toggle {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: transparent;
    color: var(--fl-muted);
  }
  .fl-rail-toggle:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-heading-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
  }
  .fl-heading-toggle:hover {
    color: var(--fl-text);
  }
  /* styles.css `.rail-heading-toggle svg`: the chevron shows on hover or focus, and stays while
     its section is folded away. */
  .fl-heading-toggle :global(.fl-heading-chevron) {
    opacity: 0;
    transition:
      opacity var(--fl-motion-fast) var(--fl-ease),
      rotate var(--fl-duration-pop) var(--fl-spring);
  }
  .fl-heading-toggle:is(:hover, :focus-visible) :global(.fl-heading-chevron),
  .fl-heading-toggle[aria-expanded='false'] :global(.fl-heading-chevron) {
    opacity: 1;
  }
  .fl-heading-toggle[aria-expanded='false'] :global(.fl-heading-chevron) {
    rotate: -90deg;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-heading-toggle :global(.fl-heading-chevron) {
      transition: none;
    }
  }
  .fl-fold {
    display: grid;
    flex-shrink: 0;
    grid-template-rows: 1fr;
    transition: grid-template-rows var(--fl-duration-pop) var(--fl-spring);
  }
  .fl-fold[data-open='false'] {
    grid-template-rows: 0fr;
  }
  .fl-section {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-height: 0;
    overflow: hidden;
    transition:
      opacity var(--fl-motion) var(--fl-ease),
      visibility 0s linear;
  }
  .fl-fold[data-open='false'] .fl-section {
    opacity: 0;
    visibility: hidden;
    /* Stays painted until the fold has closed over it. */
    transition:
      opacity var(--fl-motion) var(--fl-ease),
      visibility 0s linear var(--fl-duration-pop);
  }
  /* The rows clip their section while it folds and the rail clips at its edge, so the focus ring is drawn inside. */
  .fl-rail :global(a:focus-visible),
  .fl-rail :global(button:focus-visible),
  .fl-rail-footer :global(a:focus-visible) {
    outline-offset: var(--fl-focus-inset);
  }
  .fl-rail :global(.fl-chevron) {
    transition: rotate var(--fl-duration-pop) var(--fl-spring);
  }
  .fl-twisty[aria-expanded='true'] :global(.fl-chevron) {
    rotate: 90deg;
  }
  :global([dir='rtl']) .fl-twisty[aria-expanded='true'] :global(.fl-chevron) {
    rotate: -90deg;
  }
  /* `.nav-heading .button`: a bare 24px "+" beside the heading. */
  .fl-action {
    display: inline-flex;
    text-decoration: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    min-height: 24px;
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: none;
    color: var(--fl-muted);
  }
  .fl-action:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-link {
    display: flex;
    align-items: center;
    gap: 11px;
    min-height: 34px;
    width: 100%;
    padding: 7px 22px;
    border: 0;
    /* `.sidebar button { border-radius: 0 }`: flat, full-width rows. */
    border-radius: 0;
    background: transparent;
    color: var(--fl-text);
    text-align: start;
    text-decoration: none;
    transition: background var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-icon-only .fl-link {
    justify-content: center;
    min-height: 36px;
    padding: 8px 0;
  }
  .fl-link:hover {
    background: var(--fl-raised);
  }
  .fl-current,
  .fl-current:hover {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-panel) 86%);
    box-shadow: inset 3px 0 var(--fl-accent);
  }
  :global([dir='rtl']) .fl-current {
    box-shadow: inset -3px 0 var(--fl-accent);
  }
  .fl-nested {
    padding-inline-start: 42px;
  }
  .fl-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-branch {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding-inline-start: 14px;
    border-radius: var(--fl-radius-sm);
  }
  .fl-branch .fl-link {
    padding-inline-start: 0.25rem;
  }
  .fl-twisty {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: transparent;
    color: var(--fl-muted);
  }
  .fl-twisty:hover {
    background: var(--fl-raised);
  }
  .fl-rail :global(.fl-icon),
  .fl-rail-footer :global(.fl-icon) {
    flex-shrink: 0;
  }
  .fl-rail :global(.fl-chevron) {
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  /* Phones: the ☰ drawer ends above the frosted tab bar (template `.sidebar.mobile-open`,
     bottom inset = tab bar height + safe area), so its footer stays reachable. */
  @media (max-width: 700px) {
    :global(#sidebar) {
      margin-bottom: var(--fl-tabbar-height, 0px);
    }
  }
  @media (pointer: coarse) {
    .fl-link {
      min-height: 48px;
    }
  }

  /* UI review 2026-10-30 #8: the phone menu's sections, above the library's own (phones only). */
  .fl-phone-sections {
    display: none;
  }
  @media (max-width: 700px) {
    .fl-phone-sections {
      display: flex;
      flex-direction: column;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--fl-border);
    }
  }
  .fl-phone-sections button.fl-link {
    border: 0;
    background: none;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }

  /* ---- Boards ---- */
  .fl-count {
    margin-inline-start: auto;
    padding-inline-start: 0.5rem;
    color: var(--fl-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .fl-eagle-label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .fl-eagle-bar {
    display: block;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--fl-raised);
  }
  .fl-eagle-bar > span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
  }
  .fl-boards-title {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-text);
    font-weight: 600;
  }
  .fl-free {
    padding: 1px 7px;
    border: 1px solid color-mix(in srgb, var(--fl-accent), transparent 55%);
    border-radius: 999px;
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-accent), transparent 85%);
    /* UI review 2026-10-30 P5: at least 12px. */
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .fl-empty {
    margin: 0;
    padding: 6px 22px;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .fl-rail-footer button.fl-link {
    font: inherit;
    cursor: pointer;
  }
  .fl-boards-sheet-head {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 12px 8px 22px;
  }
  .fl-boards-sheet-head h2 {
    margin: 0;
    color: var(--fl-text);
    font-size: 15px;
    font-weight: 600;
  }
  /*
   * Below the sidebar breakpoint the Boards drawer is a bottom sheet ("Collections and filters",
   * prototype screen 22): full width from the foot of the screen, rounded at the top, over the
   * tab bar. Only while open; a closed drawer is inert and keeps its zero width.
   */
  @media (min-width: 701px) and (max-width: 849px) {
    :global(html[data-fl-boards-rail] #sidebar:not([inert])) {
      position: fixed;
      inset: auto 0 0 0;
      z-index: 60;
      width: 100% !important;
      max-height: min(80dvh, 40rem);
      margin-bottom: 0;
      padding-bottom: calc(14px + env(safe-area-inset-bottom, 0px));
      border: 0;
      border-top: 1px solid var(--fl-border);
      border-radius: var(--fl-radius-sheet, 16px) var(--fl-radius-sheet, 16px) 0 0;
      box-shadow: var(--fl-shadow-4, 0 -8px 30px rgb(0 0 0 / 25%));
    }
    .fl-boards-sheet-head {
      display: flex;
    }
  }
</style>
