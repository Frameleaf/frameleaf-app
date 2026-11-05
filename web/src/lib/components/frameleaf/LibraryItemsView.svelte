<script lang="ts">
  import { debounce } from 'lodash-es';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { onMount, onDestroy, untrack, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { DiscoveryQuery, DiscoveryFilterSection } from '$lib/components/discovery/query';
  import type { IdsFilter } from '@frameleaf/sdk';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import BoardsGrid from '$lib/components/frameleaf/BoardsGrid.svelte';
  import { boardsView } from '$lib/frameleaf/boards-view.svelte';
  import { boardsCollectionUi } from '$lib/frameleaf/boards-collection-ui.svelte';
  import { THUMBNAIL_SIZE_MAX, THUMBNAIL_SIZE_MIN, THUMBNAIL_SIZE_STEP } from '$lib/frameleaf/library-grid';
  import ResultsToolbar from '$lib/components/frameleaf/ResultsToolbar.svelte';
  import LibraryLayoutSwitch from '$lib/components/frameleaf/LibraryLayoutSwitch.svelte';
  import LibraryFilterPanel from '$lib/components/frameleaf/LibraryFilterPanel.svelte';
  import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
  import BookmarkInspector from '$lib/components/frameleaf/BookmarkInspector.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import BulkAlbumDialog from '$lib/components/frameleaf/BulkAlbumDialog.svelte';
  import BulkTagDialog from '$lib/components/frameleaf/BulkTagDialog.svelte';
  import ThumbnailSizeControl from '$lib/components/frameleaf/ThumbnailSizeControl.svelte';
  import WorkFileNamesToggle from '$lib/components/frameleaf/WorkFileNamesToggle.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { LibrarySearchSession } from '$lib/frameleaf/library-search-session.svelte';
  import {
    effectiveLibraryItemSort,
    libraryItemSearchRequest,
    LIBRARY_ITEM_SORTS,
    type LibraryItemSort,
  } from '$lib/frameleaf/library-item-search';
  import {
    organizeLibraryItems,
    ownsLibrarySelection,
    rateLibraryItems,
    setLibraryItemsScope,
    trashLibraryItems,
  } from '$lib/frameleaf/library-item-organization';
  import {
    BOARD_SHAPE_LABEL_KEYS,
    boardShapeOf,
    colorChoiceOf,
    colorFilterText,
    looseColorFilter,
    minimumWidthOf,
  } from '$lib/frameleaf/library-filters';
  import ColorFilter from '$lib/components/frameleaf/ColorFilter.svelte';
  import DimensionFilters from '$lib/components/frameleaf/DimensionFilters.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import SearchSaveDialog from '$lib/components/frameleaf/SearchSaveDialog.svelte';
  import BoardsEaglePausedBanner from '$lib/components/frameleaf/eagle/BoardsEaglePausedBanner.svelte';
  import { eagleImportUi } from '$lib/frameleaf/eagle/eagle-import-status.svelte';
  import { activeFilterFields } from '$lib/components/discovery/query';
  import { withFilterCondition } from '$lib/frameleaf/search-filters';
  import { shouldIgnoreEvent } from '$lib/actions/shortcut';
  import { downloadArchive, ignoreCancelledDownload } from '$lib/utils/asset-utils';
  import { downloadBoardsItems, LIBRARY_FILE_LIMIT } from '$lib/frameleaf/boards-download';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import {
    mdiAspectRatio,
    mdiCheckboxMultipleMarkedOutline,
    mdiChevronDown,
    mdiClose,
    mdiContentSaveOutline,
    mdiFolderMultipleOutline,
    mdiFolderPlusOutline,
    mdiImageOutline,
    mdiImport,
    mdiLinkVariant,
    mdiLinkVariantPlus,
    mdiMagnify,
    mdiPaletteOutline,
    mdiPaletteSwatchOutline,
    mdiPlus,
    mdiPuzzleOutline,
    mdiShapeOutline,
    mdiSort,
    mdiStar,
    mdiStarOffOutline,
    mdiStarOutline,
    mdiTagOffOutline,
    mdiTagOutline,
    mdiThumbDownOutline,
    mdiTrayArrowUp,
    mdiVideoOutline,
    mdiViewDashboardOutline,
    mdiViewGridOutline,
  } from '@mdi/js';
  import type { BulkActionContext } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { libraryGridPreferences, designLibraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { Icon, Theme as AppTheme, themeManager, toastManager } from '@frameleaf/ui';
  import {
    AssetTypeEnum,
    getAllTags,
    LibraryItemSearchKind,
    LibraryScope,
    LibraryViewScope,
    LibraryAssetItemKind,
    type ColorFilter as ColorCondition,
    type TagResponseDto,
  } from '@frameleaf/sdk';

  let {
    title,
    query,
    onQueryChange,
    header,
    context = '/pro',
    workspace = 'design',
    album,
    bulkContext,
    onSaveLink,
    kinds,
    onGetExtension,
    bookmark,
    onKindsChange,
  }: {
    title: string;
    query: DiscoveryQuery;
    onQueryChange: (query: DiscoveryQuery) => void;
    /** The page's own heading; it gets the result count while something narrows the results. */
    header?: Snippet<[number | null, Snippet | undefined]>;
    context?: string;
    workspace?: 'personal' | 'design';
    album?: import('@frameleaf/sdk').AlbumResponseDto;
    bulkContext?: Omit<BulkActionContext, 'assets' | 'count' | 'currentUserId' | 'snapshot'>;
    /**
     * Opens the save-link flow, with the address when one was pasted. Without it, "Save a link" is not
     * offered and a pasted address is left alone.
     */
    onSaveLink?: (url?: string) => void;
    /** Only these kinds of item (Boards' Links view). */
    kinds?: import('@frameleaf/sdk').LibraryItemSearchKind[];
    /** Opens "Get the browser extension". Without it, the first-run state does not offer it. */
    onGetExtension?: () => void;
    /** A saved link to open in the inspector when the view first loads (Boards' `?bookmark=<id>`). */
    bookmark?: string;
    /**
     * Boards' Type menu chose Links or left it (the page keeps `kinds` in its address). Without it the
     * choice is kept here.
     */
    onKindsChange?: (
      kinds: import('@frameleaf/sdk').LibraryItemSearchKind[] | undefined,
      query: DiscoveryQuery,
    ) => void;
  } = $props();
  let viewElement = $state<HTMLElement>();
  let mainElement = $state<HTMLElement>();
  /**
   * The floating selection bar centres over the items, between the rail and the side panel
   * (`--fl-left` / `--fl-right`, as LibraryView publishes them), so it never runs under Details or
   * the Information panel.
   */
  $effect(() => {
    const host = viewElement;
    const area = mainElement;
    if (!host || !area || typeof ResizeObserver !== 'function') {
      return;
    }
    const measure = () => {
      const box = area.getBoundingClientRect();
      host.style.setProperty('--fl-left', `${Math.max(0, Math.round(box.left))}px`);
      host.style.setProperty('--fl-right', `${Math.max(0, Math.round(innerWidth - box.right))}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    observer.observe(document.documentElement);
    measure();
    return () => observer.disconnect();
  });
  /** Boards (`/pro` and a Boards collection): the prototype's own toolbar, grid and Details. */
  const isBoards = $derived(workspace === 'design');
  /** Boards opens its own save-link and extension dialogs unless the host passes its own. */
  let linkDialog = $state<{ url?: string } | null>(null);
  let extensionOpen = $state(false);
  const saveLink = $derived(
    onSaveLink ?? (workspace === 'design' ? (url?: string) => (linkDialog = { url }) : undefined),
  );
  const getExtension = $derived(onGetExtension ?? (workspace === 'design' ? () => (extensionOpen = true) : undefined));
  const session = new LibrarySessionStore({ workspace });
  const results = new LibrarySearchSession();
  const preferences = workspace === 'design' ? designLibraryGridPreferences : libraryGridPreferences;
  let mounted = $state(false);
  let generation = $state(0);
  let failed = $state(false);
  let organizationFailed = $state(false);
  let organizing = $state(false);
  let filterSection = $state<DiscoveryFilterSection | null>(null);
  let inspectorOpen = $state(true);
  let activeBookmark = $state<string | null>(null);
  /** The link a deep link opened. Its inspector loads it by id even before the grid reaches it. */
  let linkedBookmark = $state<string | null>(null);
  let sort = $state<LibraryItemSort>('added');
  let popover = $state<'color' | 'shape' | 'view' | null>(null);
  let colorTrigger: HTMLButtonElement | undefined = $state();
  let shapeTrigger: HTMLButtonElement | undefined = $state();
  let viewTrigger: HTMLButtonElement | undefined = $state();
  /** The picture or video open in Boards' Details: a click opens it there, not the full viewer. */
  let activeAsset = $state<string | null>(null);
  /** Boards' Type menu, where the page does not keep `kinds` itself; null is "every kind". */
  let localKinds = $state<LibraryItemSearchKind[] | null | undefined>(undefined);
  $effect(() => {
    void kinds;
    untrack(() => (localKinds = undefined));
  });
  const effectiveKinds = $derived(localKinds === undefined ? kinds : (localKinds ?? undefined));
  /** The account's tags, for Boards' Tags menu. */
  let tagChoices = $state<TagResponseDto[]>([]);
  /** Boards' search field: what is typed, sent to the search a moment after typing stops. */
  let searchText = $state('');
  let dialog = $state<'album' | 'tags' | 'save' | 'download' | null>(null);
  let lastExternal = '';
  let requestIdentity = '';
  const assets = $derived(
    results.items.flatMap((item) =>
      item.kind === LibraryAssetItemKind.Asset && 'ownerId' in item.asset ? [item.asset] : [],
    ),
  );
  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));
  const mixedSelected = $derived(session.selection.some((id) => id.startsWith('bookmark:')));
  /** Boards acts on every selection with its own bar; elsewhere it takes over only for saved links. */
  const boardsBar = $derived(session.selection.length > 0 && (workspace === 'design' || mixedSelected));
  const selectedAssetIds = $derived(assets.filter((asset) => session.selection.includes(asset.id)).map(({ id }) => id));
  const ownsSelection = $derived(
    authManager.authenticated && ownsLibrarySelection(results.items, session.selection, authManager.user.id),
  );
  const sortChoice = $derived(effectiveLibraryItemSort(session.query, sort));
  const colorText = $derived(colorFilterText(session.query.filter.color));
  const shapeLabel = $derived.by(() => {
    const filter = session.query.filter;
    const shape = boardShapeOf(filter.aspectRatio);
    const width = minimumWidthOf(filter.width);
    const parts = [
      shape !== 'any' && shape !== 'custom' ? $t(BOARD_SHAPE_LABEL_KEYS[shape]) : null,
      typeof width === 'number' && width > 0 ? $t('frameleaf_boards_min_width_short', { values: { width } }) : null,
      filter.hasTransparency?.eq === true ? $t('frameleaf_boards_transparent_short') : null,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' · ') : null;
  });
  const shapeActive = $derived(
    !!session.query.filter.aspectRatio ||
      !!session.query.filter.width ||
      !!session.query.filter.hasTransparency ||
      !!session.query.filter.durationMs,
  );
  /**
   * Filters the page itself states (the workspace, the collection) are not the person's own narrowing:
   * they get no chip and no count in the toolbar either (FL-670).
   */
  /** The collection's own condition, with no other album rule beside it (those keep their chip). */
  const isOnly = (condition: IdsFilter | undefined, id: string) =>
    !condition?.none?.length &&
    ((condition?.any?.length === 1 && condition.any[0] === id && !condition.all?.length) ||
      (condition?.all?.length === 1 && condition.all[0] === id && !condition.any?.length));
  const scopeFields = $derived(
    album && isOnly(session.query.filter.albumIds, album.id) ? ['libraryScope', 'albumIds'] : ['libraryScope'],
  );
  const narrowingFields = $derived(activeFilterFields(session.query).filter((field) => !scopeFields.includes(field)));
  const narrowed = $derived(narrowingFields.length > 0 || session.query.text.trim() !== '');
  const emptyKind = $derived.by(() => {
    if (session.query.filter.color) {
      return 'color';
    }
    if (narrowingFields.some((field) => field !== 'hasAlbums') || session.query.text.trim() !== '') {
      return 'search';
    }
    if (album) {
      return 'collection';
    }
    return session.query.filter.hasAlbums?.eq === false ? 'unfiled' : 'first';
  });
  const looseAlready = $derived.by(() => {
    const choice = colorChoiceOf(session.query.filter.color);
    return !choice || (choice.tolerance === 'broad' && !choice.mainOnly);
  });
  const selectedBookmark = $derived(
    session.selection.length > 0 && !isBoards
      ? session.selection.find((id) => id.startsWith('bookmark:'))?.slice(9)
      : activeBookmark,
  );
  /** Boards' Details shows the item opened by a click; elsewhere, the selected one. */
  const selectedAsset = $derived(
    isBoards
      ? (timelineAssets.find((asset) => asset.id === activeAsset) ?? null)
      : (timelineAssets.find((asset) => session.selection.includes(asset.id)) ?? null),
  );
  const orderedKeys = $derived(
    results.items.map((item) =>
      item.kind === LibraryAssetItemKind.Asset ? item.asset.id : `bookmark:${item.bookmark.id}`,
    ),
  );
  const canOrganize = $derived(
    authManager.authenticated &&
      results.items.every(
        (item) =>
          item.kind === LibraryAssetItemKind.Asset ||
          !session.selection.includes(`bookmark:${item.bookmark.id}`) ||
          item.bookmark.ownerId === authManager.user.id,
      ),
  );
  const bookmarkRecord = $derived(
    results.items.find((item) => item.kind !== LibraryAssetItemKind.Asset && item.bookmark.id === selectedBookmark),
  );
  const request = $derived.by(() => {
    try {
      return libraryItemSearchRequest(session.query, sort, effectiveKinds);
    } catch {
      return null;
    }
  });

  const requestKey = $derived(JSON.stringify(request));

  const refresh = debounce(() => generation++, 250);
  const restrict = () => {
    results.reset();
    session.clearSelection();
    activeBookmark = null;
    activeAsset = null;
    refresh();
  };
  const unsubscribers = [
    websocketEvents.on('on_upload_success', refresh),
    websocketEvents.on('on_asset_update', refresh),
    websocketEvents.on('on_asset_restore', refresh),
    websocketEvents.on('on_asset_delete', restrict),
    websocketEvents.on('on_asset_hidden', restrict),
    websocketEvents.on('on_asset_trash', restrict),
    websocketEvents.on('AssetLocalEffectsV1', refresh),
    eventManager.on({
      AssetUpdate: refresh,
      AssetsDelete: restrict,
      AssetsArchive: refresh,
      AssetsUnarchive: refresh,
      AssetsTag: refresh,
      AlbumAddAssets: refresh,
      AlbumRemoveAssets: refresh,
      AlbumUserUpdate: restrict,
      AlbumUserDelete: restrict,
      AlbumShare: restrict,
    }),
  ];
  onDestroy(() => {
    refresh.cancel();
    for (const stop of unsubscribers) {
      stop();
    }
  });
  onMount(() => {
    mounted = true;
    const visible = () => {
      if (!document.hidden) {
        refresh();
      }
    };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  });
  $effect(() => {
    if (!mounted || !authManager.authenticated) {
      return;
    }
    const owner = authManager.user.id;
    untrack(() => {
      session.restore(undefined, owner, context);
      session.patchView({ sort: 'imported-desc', grouping: 'all' });
      session.setQuery(query);
      lastExternal = JSON.stringify(query);
    });
  });
  $effect(() => {
    const incoming = JSON.stringify(query);
    if (!mounted) {
      return;
    }
    untrack(() => {
      if (incoming !== lastExternal) {
        lastExternal = incoming;
        session.setQuery(query);
      }
    });
  });
  $effect(() => {
    const state = JSON.stringify(session.query);
    void session.layout;
    void session.selection;
    if (!mounted || !authManager.authenticated) {
      return;
    }
    untrack(() => {
      session.persist();
      if (state !== lastExternal) {
        onQueryChange(session.query);
      }
    });
  });
  const load = async () => {
    const current = authManager.captureSession();
    failed = false;
    try {
      await results.loadNextPage({ language: 'en' });
    } catch {
      if (current()) {
        failed = true;
      }
    }
  };
  $effect(() => {
    const key = requestKey;
    void generation;
    void album;
    if (!mounted || !authManager.authenticated) {
      return;
    }
    untrack(() => {
      const body = request;
      results.reset(body ? { kind: 'library', terms: body } : null);
      const identity = key;
      if (identity !== requestIdentity) {
        // The first request opens the link a deep link names; any later change of request closes it.
        linkedBookmark = requestIdentity === '' ? (bookmark ?? null) : null;
        activeBookmark = linkedBookmark;
        if (linkedBookmark) {
          inspectorOpen = true;
        }
      }
      requestIdentity = identity;
      failed = !body;
      if (body) {
        void load();
      }
    });
  });
  onDestroy(
    onLibraryAccessChange(() => {
      results.reset();
      session.clearSelection();
      activeBookmark = null;
      dialog = null;
      generation++;
    }),
  );
  onDestroy(() => results.destroy());
  const reload = () => {
    generation++;
  };
  const setFilter = (field: string, condition: object | undefined) =>
    session.setQuery(withFilterCondition(session.query, field, condition as Parameters<typeof withFilterCondition>[2]));
  /** A colour turns on "Closest colour first", as the prototype does when a colour is applied. */
  const applyColor = (color: ColorCondition | undefined) => {
    setFilter('color', color);
    if (color) {
      sort = 'color';
    } else if (sort === 'color') {
      sort = 'added';
    }
  };
  const chooseColor = (color: ColorCondition) => {
    applyColor(color);
    filterSection = null;
  };
  const closePopover = () => {
    const trigger = popover === 'color' ? colorTrigger : popover === 'shape' ? shapeTrigger : undefined;
    popover = null;
    trigger?.focus();
  };
  /** Closes a popover on Escape or a press outside its own control, and focuses its first control. */
  const dismissable = (node: HTMLElement) => {
    const outside = (event: PointerEvent) => {
      if (!node.parentElement?.contains(event.target as Node)) {
        popover = null;
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePopover();
      }
    };
    document.addEventListener('pointerdown', outside, { capture: true });
    node.addEventListener('keydown', escape);
    queueMicrotask(() => node.querySelector<HTMLElement>('button, input, select')?.focus());
    return {
      destroy: () => {
        document.removeEventListener('pointerdown', outside, { capture: true });
        node.removeEventListener('keydown', escape);
      },
    };
  };
  const clearNarrowing = () => {
    const filter = Object.fromEntries(
      Object.entries(session.query.filter).filter(([field]) => scopeFields.includes(field)),
    );
    session.setQuery({ ...session.query, text: '', filter });
  };
  /* ---- Boards' toolbar (prototype ProWorkspace.jsx `.pro-toolbar`) ---- */
  type BoardsType = 'all' | 'image' | 'video' | 'link';
  const BOARDS_TYPES: {
    id: BoardsType;
    labelKey:
      'frameleaf_boards_all_items' | 'frameleaf_boards_images' | 'frameleaf_boards_videos' | 'frameleaf_boards_links';
    icon: string;
  }[] = [
    { id: 'all', labelKey: 'frameleaf_boards_all_items', icon: mdiViewDashboardOutline },
    { id: 'image', labelKey: 'frameleaf_boards_images', icon: mdiImageOutline },
    { id: 'video', labelKey: 'frameleaf_boards_videos', icon: mdiVideoOutline },
    { id: 'link', labelKey: 'frameleaf_boards_links', icon: mdiLinkVariant },
  ];
  const typeChoice = $derived.by((): BoardsType => {
    if (effectiveKinds?.includes(LibraryItemSearchKind.Bookmark)) {
      return 'link';
    }
    const type = (session.query.filter.type as { eq?: string } | undefined)?.eq;
    return type === AssetTypeEnum.Image ? 'image' : type === AssetTypeEnum.Video ? 'video' : 'all';
  });
  const setType = (choice: BoardsType) => {
    const next = withFilterCondition(
      session.query,
      'type',
      choice === 'image' ? { eq: AssetTypeEnum.Image } : choice === 'video' ? { eq: AssetTypeEnum.Video } : undefined,
    );
    const nextKinds = choice === 'link' ? [LibraryItemSearchKind.Bookmark] : undefined;
    if (onKindsChange) {
      onKindsChange(nextKinds, next);
      return;
    }
    localKinds = nextKinds ?? null;
    session.setQuery(next);
  };
  /** At least this many stars, or -1 for Rejected. */
  const ratingChoice = $derived.by(() => {
    const rating = session.query.filter.rating as { gte?: number; eq?: number | null } | undefined;
    return rating?.eq === -1 ? -1 : (rating?.gte ?? 0);
  });
  const setRating = (minimum: number) =>
    setFilter('rating', minimum === -1 ? { eq: -1 } : minimum > 0 ? { gte: minimum } : undefined);
  const tagChoice = $derived.by(() => {
    const ids = session.query.filter.tagIds as IdsFilter | undefined;
    const id = ids?.any?.length === 1 && !ids.all?.length && !ids.none?.length ? ids.any[0] : undefined;
    return id ? (tagChoices.find((tag) => tag.id === id) ?? null) : null;
  });
  const setTag = (tag: TagResponseDto | null) => setFilter('tagIds', tag ? { any: [tag.id] } : undefined);
  $effect(() => {
    if (!isBoards || !mounted || !authManager.authenticated) {
      return;
    }
    const current = authManager.captureSession();
    void Promise.resolve(getAllTags())
      .then((tags) => {
        if (current() && Array.isArray(tags)) {
          tagChoices = [...tags].sort((a, b) => a.value.localeCompare(b.value));
        }
      })
      .catch(() => {
        // The menu then offers only "Any tag"; tags still show on each item's Details.
      });
  });
  const sendSearch = debounce((text: string) => {
    if (text !== session.query.text) {
      session.setQuery({ ...session.query, text });
    }
  }, 300);
  onDestroy(() => sendSearch.cancel());
  $effect(() => {
    const text = session.query.text;
    untrack(() => {
      if (document.activeElement?.id !== searchId) {
        searchText = text;
      }
    });
  });
  const searchId = $props.id();
  /** Boards' Select starts a selection with the first item, as the prototype does. */
  const startSelecting = () => {
    const first = orderedKeys[0];
    if (first) {
      session.select(first);
    }
  };
  /** Opens an item in Details (Boards: a click on a tile). */
  const openInDetails = (key: string) => {
    if (key.startsWith('bookmark:')) {
      activeAsset = null;
      activeBookmark = key.slice(9);
    } else {
      activeBookmark = null;
      activeAsset = key;
    }
    inspectorOpen = true;
  };
  const closeDetails = () => {
    const key = activeAsset ?? (activeBookmark ? `bookmark:${activeBookmark}` : undefined);
    activeAsset = null;
    activeBookmark = null;
    if (key) {
      document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(key)}"] button`)?.focus();
    }
  };
  /** Details' "Move to trash" (prototype `.pro-inspector-actions`): this one item, then Details closes. */
  const trashOne = (asset: { id: string }) => {
    const owner = authManager.user.id;
    const current = authManager.captureSession();
    activeAsset = null;
    void trashLibraryItems(results.items, [asset.id], owner, current)
      .then(() => {
        toastManager.primary($t('frameleaf_boards_trashed', { values: { count: 1 } }));
        reload();
      })
      .catch(() => {
        organizationFailed = true;
      });
  };
  const openLarge = (asset: { id: string }) => {
    const full = assets.find((item) => item.id === asset.id);
    if (full) {
      void navigateToAsset(full);
    }
  };
  const upload = () =>
    void openFileUploadDialog({
      libraryScope: workspace === 'design' ? LibraryScope.Design : undefined,
      albumId: album?.id,
    });
  /** Pasting a web address saves it as a link; pasted images are uploaded by the app-wide drop target. */
  const onPaste = (event: ClipboardEvent) => {
    if (!saveLink || shouldIgnoreEvent(event) || !event.clipboardData || event.clipboardData.files.length > 0) {
      return;
    }
    const text = event.clipboardData.getData('text/plain').trim();
    if (/^https?:\/\/\S+$/i.test(text)) {
      event.preventDefault();
      saveLink(text);
    }
  };
  /** Runs one change over the selection; it stops quietly if the account or the page changed under it. */
  const runSelection = async (
    change: (keys: string[], owner: string, current: () => boolean) => Promise<void>,
    done?: (count: number) => void,
  ) => {
    const keys = [...session.selection];
    const owner = authManager.user.id;
    const current = authManager.captureSession();
    const version = generation;
    dialog = null;
    organizing = true;
    organizationFailed = false;
    try {
      await change(keys, owner, () => current() && generation === version);
      if (current() && generation === version) {
        session.clearSelection();
        done?.(keys.length);
        reload();
      }
    } catch {
      if (current() && generation === version) {
        organizationFailed = true;
      }
    } finally {
      if (current()) {
        organizing = false;
      }
    }
  };
  const collectionName = $derived(album?.albumName || $t('unnamed_album'));
  const organize = (payload: BulkPayload, operation: 'add' | 'remove' = 'add') => {
    const name = collectionName;
    return runSelection(
      (keys, owner, current) => organizeLibraryItems(results.items, keys, owner, payload, current, operation),
      operation === 'remove'
        ? (count) => toastManager.primary($t('frameleaf_boards_removed_from', { values: { count, name } }))
        : undefined,
    );
  };
  const rate = (rating: number | null) =>
    runSelection((keys, owner, current) => rateLibraryItems(results.items, keys, owner, rating, current));
  const setScope = (scope: LibraryScope) =>
    runSelection((keys, owner, current) => setLibraryItemsScope(results.items, keys, owner, scope, current));
  const trash = () =>
    runSelection(
      (keys, owner, current) => trashLibraryItems(results.items, keys, owner, current),
      (count) => toastManager.primary($t('frameleaf_boards_trashed', { values: { count } })),
    );
  const downloadName = $derived(album?.albumName || 'frameleaf');
  const selectedBookmarkIds = $derived(
    session.selection.filter((key) => key.startsWith('bookmark:')).map((key) => key.slice(9)),
  );
  /** Boards asks what goes in the .zip (FL-660); elsewhere a download starts at once. */
  const download = () => {
    if (selectedAssetIds.length === 0) {
      return;
    }
    if (workspace === 'design') {
      dialog = 'download';
      return;
    }
    void downloadArchive(downloadName, { assetIds: [...selectedAssetIds] }).catch(ignoreCancelledDownload);
  };
  /** The library file lists only the account's own items, up to the server's limit. */
  const libraryAvailable = $derived(
    ownsSelection && selectedAssetIds.length + selectedBookmarkIds.length <= LIBRARY_FILE_LIMIT,
  );
  const downloadSelection = (includeLibrary: boolean) =>
    void downloadBoardsItems({
      fileName: downloadName,
      assetIds: [...selectedAssetIds],
      bookmarkIds: [...selectedBookmarkIds],
      includeLibrary,
    });
  const closeBookmark = () => {
    const key = selectedBookmark ? `bookmark:${selectedBookmark}` : undefined;
    activeBookmark = null;
    session.clearSelection();
    if (key) {
      document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(key)}"] button`)?.focus();
    }
  };
</script>

<svelte:window onpaste={onPaste} />

{#snippet addMenu()}
  <!-- Boards' Add menu (prototype screen 33): upload, save a link, a new collection, Eagle, the extension. -->
  <!-- Prototype ProWorkspace.jsx: Add is the page's one primary action. -->
  <div class="fl-items-add">
    <Menu label={$t('add')} align="end">
      {#snippet trigger()}<Icon icon={mdiPlus} size="18" aria-hidden={true} /><span aria-hidden="true">{$t('add')}</span
        >{/snippet}
      <MenuItem onSelect={upload}
        ><Icon icon={mdiTrayArrowUp} size="18" aria-hidden={true} />{$t('frameleaf_boards_upload')}</MenuItem
      >
      {#if saveLink}<MenuItem onSelect={() => saveLink?.()}
          ><Icon icon={mdiLinkVariantPlus} size="18" aria-hidden={true} />{$t('frameleaf_boards_save_link')}</MenuItem
        >{/if}
      <MenuItem onSelect={() => boardsCollectionUi.newCollection(album?.id ?? null)}
        ><Icon icon={mdiFolderPlusOutline} size="18" aria-hidden={true} />{album
          ? $t('frameleaf_boards_new_collection_inside')
          : $t('frameleaf_boards_new_collection')}</MenuItem
      >
      <MenuItem onSelect={() => eagleImportUi.show()}
        ><Icon icon={mdiImport} size="18" aria-hidden={true} />{$t('frameleaf_eagle_import_open')}</MenuItem
      >
      {#if getExtension}<MenuItem onSelect={getExtension}
          ><Icon icon={mdiPuzzleOutline} size="18" aria-hidden={true} />{$t('frameleaf_boards_get_extension')}</MenuItem
        >{/if}
    </Menu>
  </div>
{/snippet}

<section
  bind:this={viewElement}
  class="frameleaf fl-items-view"
  class:is-boards={isBoards}
  data-theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}
  aria-label={title}
>
  <div class="fl-items-main" bind:this={mainElement}>
    <header class="fl-items-heading" class:has-header={!!header}>
      {#if header}{@render header(narrowed ? results.count : null, isBoards ? addMenu : undefined)}{:else}<div>
          {#if isBoards}
            <!-- Phones: the rail is the "Collections and filters" sheet (prototype `.pro-browse`, screen 22). -->
            <button
              type="button"
              class="fl-boards-browse"
              aria-haspopup="dialog"
              aria-expanded={sidebarStore.isOpen}
              aria-controls="sidebar"
              onclick={() => sidebarStore.toggle()}
            >
              <Icon icon={mdiFolderMultipleOutline} size="18" aria-hidden={true} />
              {$t('frameleaf_boards_collections_and_filters')}
              <Icon icon={mdiChevronDown} size="16" aria-hidden={true} />
            </button>
          {/if}
          <h1>{title}</h1>
          <!-- Prototype screen 01: the count is the title's subtitle (FL-670). -->
          <p class="fl-items-description" aria-live="polite" data-testid="frameleaf-items-count">
            {results.count === null ? '' : $t('items_count', { values: { count: results.count } })}
          </p>
        </div>{/if}
      {#if !(isBoards && header)}
        <div class="fl-items-heading-actions">
          {#if isBoards}
            {@render addMenu()}
          {:else}
            <LibraryLayoutSwitch {session} />
          {/if}
        </div>
      {/if}
    </header>
    {#if workspace === 'design'}<BoardsEaglePausedBanner />{/if}
    <!--
    One row under the heading, in the page's gutter (prototype screens 01 and 02): the filters and sort,
    then Filter and the details toggle. The count is in the heading, or the collection header's summary.
  -->
    {#if isBoards}
      {@render boardsToolbar()}
    {:else}<div class="fl-items-toolbar">
        <ResultsToolbar
          {session}
          leading={controls}
          onOpenFilterPanel={(section) => (filterSection = section)}
          filterPanelOpen={filterSection !== null}
          onCloseFilterPanel={() => (filterSection = null)}
          {inspectorOpen}
          onToggleInspector={() => (inspectorOpen = !inspectorOpen)}
          unappliedFields={scopeFields}
        />
      </div>{/if}
    {#snippet controls()}<div class="fl-items-controls" role="toolbar" aria-label={$t('frameleaf_boards_filters')}>
        {@render colorChip()}
        {@render shapeChip()}
        <Button
          pressed={session.query.filter.hasAlbums?.eq === false}
          onclick={() =>
            setFilter('hasAlbums', session.query.filter.hasAlbums?.eq === false ? undefined : { eq: false })}
          >{$t('frameleaf_pro_unfiled')}</Button
        >
        {#if narrowed}<Button variant="quiet" onclick={() => (dialog = 'save')}
            ><Icon icon={mdiContentSaveOutline} size="16" aria-hidden />{$t('frameleaf_boards_save_smart')}</Button
          >{/if}
        <span class="fl-items-spacer"></span>
        {@render sortControl()}
        <Button onclick={() => refresh()}>{$t('refresh')}</Button>
        {#if session.layout === 'work'}<WorkFileNamesToggle {preferences} />{/if}
        {#if results.countCapped}<span role="status">{$t('frameleaf_pro_count_capped')}</span>{/if}
      </div>{/snippet}
    {#snippet colorChip()}
      <div class="fl-items-popover-host">
        <button
          type="button"
          class="fl-items-chip"
          class:is-on={!!colorText}
          bind:this={colorTrigger}
          aria-expanded={popover === 'color'}
          aria-haspopup="dialog"
          onclick={() => (popover = popover === 'color' ? null : 'color')}
        >
          {#if session.query.filter.color && colorText}
            <span class="fl-items-chip-swatch" style:background={session.query.filter.color.hex} aria-hidden="true"
            ></span>
            {$t(colorText.key, { values: colorText.values })}
          {:else}
            <Icon icon={mdiPaletteOutline} size="16" aria-hidden />
            {$t('frameleaf_boards_colour')}
          {/if}
          <Icon icon={mdiChevronDown} size="14" aria-hidden />
        </button>
        {#if popover === 'color'}
          <div class="fl-items-popover" role="dialog" aria-label={$t('frameleaf_boards_colour_find')} use:dismissable>
            <ColorFilter
              color={session.query.filter.color}
              onChange={(color) => {
                applyColor(color);
                closePopover();
              }}
              onCancel={closePopover}
            />
          </div>
        {/if}
      </div>
    {/snippet}
    {#snippet shapeChip()}
      <div class="fl-items-popover-host">
        <button
          type="button"
          class="fl-items-chip"
          class:is-on={shapeActive}
          bind:this={shapeTrigger}
          aria-expanded={popover === 'shape'}
          aria-haspopup="dialog"
          onclick={() => (popover = popover === 'shape' ? null : 'shape')}
        >
          <Icon icon={mdiAspectRatio} size="16" aria-hidden />
          {shapeLabel ?? $t('frameleaf_boards_size_and_shape')}
          <Icon icon={mdiChevronDown} size="14" aria-hidden />
        </button>
        {#if popover === 'shape'}
          <div
            class="fl-items-popover"
            role="dialog"
            aria-label={$t('frameleaf_boards_size_and_shape')}
            use:dismissable
          >
            <DimensionFilters filter={session.query.filter} onChange={setFilter} onDone={closePopover} />
          </div>
        {/if}
      </div>
    {/snippet}
    {#snippet boardsToolbar()}
      <!-- Prototype ProWorkspace.jsx `.pro-toolbar`: search, Colour, Type, Rating, Size and shape, Tags; then sort, view and Select. -->
      <div class="fl-boards-toolbar" role="toolbar" aria-label={$t('frameleaf_boards_filters')}>
        <label class="fl-boards-search" title={$t('frameleaf_boards_search_hint')}>
          <Icon icon={mdiMagnify} size="16" aria-hidden />
          <input
            id={searchId}
            type="search"
            placeholder={$t('frameleaf_boards_search')}
            aria-label={$t('frameleaf_boards_search')}
            autocomplete="off"
            bind:value={searchText}
            oninput={() => sendSearch(searchText.trim())}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                sendSearch(searchText.trim());
                sendSearch.flush();
              }
            }}
          />
        </label>
        {@render colorChip()}
        <div class="fl-items-chip-menu" class:is-on={typeChoice !== 'all'}>
          <Menu label={$t('type')}>
            {#snippet trigger()}<Icon icon={mdiShapeOutline} size="16" aria-hidden={true} /><span
                >{typeChoice === 'all'
                  ? $t('type')
                  : $t(BOARDS_TYPES.find(({ id }) => id === typeChoice)!.labelKey)}</span
              >{/snippet}
            {#each BOARDS_TYPES as type (type.id)}
              <MenuItem checked={typeChoice === type.id} onSelect={() => setType(type.id)}
                ><Icon icon={type.icon} size="18" aria-hidden={true} />{$t(type.labelKey)}</MenuItem
              >
            {/each}
          </Menu>
        </div>
        <div class="fl-items-chip-menu" class:is-on={ratingChoice !== 0}>
          <Menu label={$t('frameleaf_boards_rating')}>
            {#snippet trigger()}<Icon icon={mdiStarOutline} size="16" aria-hidden={true} /><span
                >{ratingChoice === -1
                  ? $t('frameleaf_search_rating_rejected')
                  : ratingChoice > 0
                    ? $t('frameleaf_boards_rating_min_short', { values: { count: ratingChoice } })
                    : $t('frameleaf_boards_rating')}</span
              >{/snippet}
            {#each [0, 3, 4, 5] as minimum (minimum)}
              <MenuItem checked={ratingChoice === minimum} onSelect={() => setRating(minimum)}
                ><Icon icon={minimum ? mdiStar : mdiStarOffOutline} size="18" aria-hidden={true} />{minimum
                  ? $t('frameleaf_boards_rating_at_least', { values: { count: minimum } })
                  : $t('frameleaf_boards_rating_any')}</MenuItem
              >
            {/each}
            <MenuItem checked={ratingChoice === -1} onSelect={() => setRating(-1)}
              ><Icon icon={mdiThumbDownOutline} size="18" aria-hidden={true} />{$t(
                'frameleaf_search_rating_rejected',
              )}</MenuItem
            >
          </Menu>
        </div>
        {@render shapeChip()}
        <div class="fl-items-chip-menu" class:is-on={!!tagChoice}>
          <Menu label={$t('tags')}>
            {#snippet trigger()}<Icon icon={mdiTagOutline} size="16" aria-hidden={true} /><span
                >{tagChoice ? tagChoice.value : $t('tags')}</span
              >{/snippet}
            <MenuItem checked={!tagChoice} onSelect={() => setTag(null)}
              ><Icon icon={mdiTagOffOutline} size="18" aria-hidden={true} />{$t('frameleaf_boards_tags_any')}</MenuItem
            >
            {#each tagChoices as tag (tag.id)}
              <MenuItem checked={tagChoice?.id === tag.id} onSelect={() => setTag(tag)}
                ><Icon icon={mdiTagOutline} size="18" aria-hidden={true} />{tag.value}</MenuItem
              >
            {/each}
          </Menu>
        </div>
        <div class="fl-boards-toolbar-end">
          {@render sortControl()}
          <div class="fl-items-popover-host">
            <button
              type="button"
              class="fl-boards-icon-button"
              bind:this={viewTrigger}
              aria-label={$t('frameleaf_boards_view_options')}
              title={$t('frameleaf_boards_view_options')}
              aria-expanded={popover === 'view'}
              aria-haspopup="dialog"
              onclick={() => (popover = popover === 'view' ? null : 'view')}
            >
              <Icon
                icon={boardsView.layout === 'grid' ? mdiViewGridOutline : mdiViewDashboardOutline}
                size="18"
                aria-hidden
              />
            </button>
            {#if popover === 'view'}
              <div
                class="fl-items-popover fl-boards-view-pop"
                role="dialog"
                aria-label={$t('frameleaf_boards_view_options')}
                use:dismissable
              >
                <fieldset class="fl-boards-segmented">
                  <legend>{$t('frameleaf_boards_layout')}</legend>
                  <button
                    type="button"
                    aria-pressed={boardsView.layout === 'board'}
                    onclick={() => (boardsView.layout = 'board')}>{$t('frameleaf_boards_layout_board')}</button
                  >
                  <button
                    type="button"
                    aria-pressed={boardsView.layout === 'grid'}
                    onclick={() => (boardsView.layout = 'grid')}>{$t('frameleaf_boards_layout_grid')}</button
                  >
                </fieldset>
                <label class="fl-boards-field">
                  <span>{$t('frameleaf_library_thumbnail_size')}</span>
                  <input
                    type="range"
                    min={THUMBNAIL_SIZE_MIN}
                    max={THUMBNAIL_SIZE_MAX}
                    step={THUMBNAIL_SIZE_STEP}
                    value={preferences.thumbnailSize}
                    oninput={(event) => (preferences.thumbnailSize = Number(event.currentTarget.value))}
                  />
                </label>
                <label class="fl-boards-check">
                  <input
                    type="checkbox"
                    checked={preferences.showFileNames}
                    onchange={(event) => (preferences.showFileNames = event.currentTarget.checked)}
                  />
                  {$t('frameleaf_library_show_file_names')}
                </label>
                <p class="fl-boards-note">{$t('frameleaf_boards_layout_hint')}</p>
              </div>
            {/if}
          </div>
          {#if session.selection.length === 0}
            <Button onclick={startSelecting} disabled={orderedKeys.length === 0}
              ><Icon icon={mdiCheckboxMultipleMarkedOutline} size="16" aria-hidden />{$t('select')}</Button
            >
          {/if}
        </div>
      </div>
      {#if session.query.filter.color || tagChoice || ratingChoice !== 0 || narrowed}
        <!-- Prototype `.pro-active`: what narrows the items, each with its ×, and "Save as smart collection". -->
        <div class="fl-boards-active" aria-live="polite">
          {#if session.query.filter.color && colorText}
            <span class="fl-boards-pill">
              <span class="fl-items-chip-swatch" style:background={session.query.filter.color.hex} aria-hidden="true"
              ></span>
              {$t(colorText.key, { values: colorText.values })}
              <button
                type="button"
                aria-label={$t('frameleaf_boards_remove_colour_filter')}
                onclick={() => applyColor(undefined)}><Icon icon={mdiClose} size="12" aria-hidden /></button
              >
            </span>
          {/if}
          {#if tagChoice}
            <span class="fl-boards-pill">
              #{tagChoice.value}
              <button type="button" aria-label={$t('frameleaf_boards_remove_tag_filter')} onclick={() => setTag(null)}
                ><Icon icon={mdiClose} size="12" aria-hidden /></button
              >
            </span>
          {/if}
          {#if ratingChoice !== 0}
            <span class="fl-boards-pill">
              {ratingChoice === -1
                ? $t('frameleaf_search_rating_rejected')
                : $t('frameleaf_boards_rating_min_short', { values: { count: ratingChoice } })}
              <button
                type="button"
                aria-label={$t('frameleaf_boards_remove_rating_filter')}
                onclick={() => setRating(0)}><Icon icon={mdiClose} size="12" aria-hidden /></button
              >
            </span>
          {/if}
          {#if narrowed}<Button variant="quiet" onclick={() => (dialog = 'save')}
              ><Icon icon={mdiContentSaveOutline} size="16" aria-hidden />{$t('frameleaf_boards_save_smart')}</Button
            >{/if}
          {#if results.countCapped}<span role="status">{$t('frameleaf_pro_count_capped')}</span>{/if}
        </div>
      {/if}
    {/snippet}
    {#snippet sortControl()}
      <label class="fl-items-sort">
        <Icon icon={mdiSort} size="16" aria-hidden />
        <select
          aria-label={$t('frameleaf_library_sort')}
          value={sortChoice}
          disabled={session.query.mode === 'smart'}
          onchange={(event) => {
            const chosen = event.currentTarget.value;
            const next = LIBRARY_ITEM_SORTS.find((value) => value === chosen);
            if (next) {
              sort = next;
            }
          }}
        >
          <option value="added">{$t('frameleaf_boards_sort_added')}</option>
          <option value="name">{$t('frameleaf_boards_sort_name')}</option>
          <option value="rating">{$t('frameleaf_boards_sort_rating')}</option>
          {#if session.query.filter.color}<option value="color">{$t('frameleaf_pro_color_order')}</option>{/if}
        </select>
      </label>
    {/snippet}
    {#if organizationFailed}<InlineError
        compact
        message={$t('frameleaf_pro_organization_failed')}
        onRetry={() => {
          organizationFailed = false;
          session.clearSelection();
          reload();
        }}
      />{/if}
    <div class="fl-items-panes">
      <div class="fl-items-scroll">
        {#if failed}<InlineError
            message={$t(request ? 'frameleaf_pro_load_failed' : 'frameleaf_pro_filter_unavailable')}
            onRetry={request ? load : undefined}
          />{/if}
        {#if results.loading && results.items.length === 0}<p role="status">{$t('loading')}</p>{/if}
        {#snippet emptyState()}{#if !results.loading && !failed}
            {#if emptyKind === 'first'}
              <div class="fl-items-first" role="status">
                <span class="fl-items-first-icon" aria-hidden="true"
                  ><Icon icon={mdiPaletteSwatchOutline} size="44" /></span
                >
                <h2>{$t('frameleaf_boards_empty_title')}</h2>
                <p>{$t('frameleaf_boards_empty_body')}</p>
                <div class="fl-items-first-actions">
                  {#if getExtension}<Button variant="primary" onclick={getExtension}
                      ><Icon icon={mdiPuzzleOutline} size="16" aria-hidden />{$t(
                        'frameleaf_boards_get_extension',
                      )}</Button
                    >{/if}
                  <Button variant={getExtension ? 'default' : 'primary'} onclick={upload}
                    ><Icon icon={mdiTrayArrowUp} size="16" aria-hidden />{$t('frameleaf_boards_upload')}</Button
                  >
                  {#if saveLink}<Button onclick={() => saveLink?.()}
                      ><Icon icon={mdiLinkVariantPlus} size="16" aria-hidden />{$t(
                        'frameleaf_boards_save_link',
                      )}</Button
                    >{/if}
                </div>
                <p class="fl-items-first-note">{$t('frameleaf_boards_empty_note')}</p>
              </div>
            {:else if emptyKind === 'color'}
              <EmptyState
                compact
                icon={mdiPaletteOutline}
                title={$t('frameleaf_boards_empty_colour_title')}
                message={$t('frameleaf_boards_empty_colour_body')}
                action={looseAlready || !session.query.filter.color
                  ? undefined
                  : {
                      label: $t('frameleaf_boards_empty_colour_loose'),
                      onClick: () => applyColor(looseColorFilter(session.query.filter.color!)),
                    }}
              />
            {:else if emptyKind === 'search'}
              <EmptyState
                compact
                title={$t('frameleaf_boards_empty_search_title')}
                message={$t('frameleaf_boards_empty_search_body')}
                action={{ label: $t('frameleaf_boards_clear_filters'), onClick: clearNarrowing }}
              />
            {:else}
              <EmptyState
                compact
                title={$t(
                  emptyKind === 'unfiled'
                    ? 'frameleaf_boards_empty_unfiled_title'
                    : 'frameleaf_boards_empty_collection_title',
                )}
                message={$t(
                  emptyKind === 'unfiled'
                    ? 'frameleaf_boards_empty_unfiled_body'
                    : 'frameleaf_boards_empty_collection_body',
                )}
              />
            {/if}
          {/if}{/snippet}
        {#if isBoards}
          <BoardsGrid
            items={results.items}
            assets={timelineAssets}
            {session}
            layout={boardsView.layout}
            tileSize={preferences.thumbnailSize}
            showNames={preferences.showFileNames}
            activeKey={inspectorOpen ? (activeAsset ?? (activeBookmark ? `bookmark:${activeBookmark}` : null)) : null}
            onOpen={openInDetails}
            onOpenLarge={openLarge}
            onEndReached={() => void load()}
            empty={emptyState}
          />
        {:else}<ResultsView
            {bulkContext}
            assets={timelineAssets}
            items={results.items}
            {preferences}
            {session}
            onEndReached={() => void load()}
            onOpen={(asset) => {
              const full = assets.find((item) => item.id === asset.id);
              if (full) {
                void navigateToAsset(full);
              }
            }}
            onOpenBookmark={(bookmark) => {
              activeBookmark = bookmark.id;
              inspectorOpen = true;
            }}
            noSelectionBar={boardsBar}
            onSelectAll={() => session.selectAll(orderedKeys)}
            onRemoved={reload}
            empty={emptyState}
          />{/if}
        {#if results.nextCursor}<Button disabled={results.loading} onclick={() => void load()}
            >{$t('frameleaf_library_show_more')}</Button
          >{/if}
      </div>
    </div>
    {#if boardsBar}
      <div
        class="fl-items-selection"
        role="toolbar"
        aria-label={$t('frameleaf_pro_selection', { values: { count: session.selection.length } })}
      >
        <IconButton label={$t('frameleaf_boards_clear_selection')} onclick={() => session.clearSelection()}>
          <Icon icon={mdiClose} size="18" aria-hidden />
        </IconButton>
        <strong aria-live="polite"
          >{$t('frameleaf_pro_selection', { values: { count: session.selection.length } })}</strong
        >
        <span class="fl-items-spacer"></span>
        <Button disabled={organizing || !canOrganize} onclick={() => (dialog = 'album')}
          >{$t('frameleaf_boards_add_to_collection')}</Button
        >
        {#if bulkContext?.albumId}<Button
            disabled={organizing}
            onclick={() => void organize({ albumId: bulkContext!.albumId! }, 'remove')}
            >{$t('frameleaf_boards_remove_from', { values: { name: collectionName } })}</Button
          >{/if}
        <Button disabled={organizing || !canOrganize} onclick={() => (dialog = 'tags')}
          >{$t('frameleaf_boards_tag')}</Button
        >
        {#if ownsSelection && !organizing}
          <Menu label={$t('frameleaf_boards_rate')} align="end">
            {#each [5, 4, 3, 2, 1] as stars (stars)}
              <MenuItem onSelect={() => void rate(stars)}
                >{$t('frameleaf_boards_rate_stars', { values: { count: stars } })}</MenuItem
              >
            {/each}
            <MenuItem onSelect={() => void rate(-1)}>{$t('frameleaf_search_rating_rejected')}</MenuItem>
            <MenuItem onSelect={() => void rate(null)}>{$t('frameleaf_boards_rate_clear')}</MenuItem>
          </Menu>
          {#if workspace === 'design' && selectedAssetIds.length > 0}
            <Menu label={$t('frameleaf_boards_scope_menu')} align="end">
              <MenuItem onSelect={() => void setScope(LibraryScope.Both)}>{$t('frameleaf_boards_scope')}</MenuItem>
              <MenuItem onSelect={() => void setScope(LibraryScope.Design)}
                >{$t('frameleaf_boards_scope_boards_only')}</MenuItem
              >
            </Menu>
          {/if}
        {/if}
        <Button disabled={organizing || selectedAssetIds.length === 0} onclick={download}>{$t('download')}</Button>
        <Button variant="danger" disabled={organizing || !ownsSelection} onclick={() => void trash()}
          >{$t('frameleaf_boards_move_to_trash')}</Button
        >
      </div>
    {/if}
    {#if !isBoards}<footer class="fl-items-footer"><ThumbnailSizeControl {preferences} /></footer>{/if}
  </div>
  {#if filterSection}
    <div class="fl-items-panel">
      <LibraryFilterPanel
        mediaCounts={false}
        query={session.query}
        countQuery={session.query}
        section={filterSection}
        count={results.count}
        onChange={(next) => session.setQuery(next)}
        onClose={() => (filterSection = null)}
      />
    </div>
  {:else if inspectorOpen && selectedBookmark && (bookmarkRecord?.kind === 'bookmark' || selectedBookmark === linkedBookmark)}
    <div class="fl-items-panel">
      <BookmarkInspector
        id={selectedBookmark}
        bookmark={bookmarkRecord?.kind === 'bookmark' ? bookmarkRecord.bookmark : undefined}
        onClose={isBoards ? closeDetails : closeBookmark}
        onChooseColor={chooseColor}
        onChange={reload}
      />
    </div>
  {:else if inspectorOpen && selectedAsset}
    <div class="fl-items-panel">
      <LibraryWorkInspector
        asset={selectedAsset}
        boards={workspace === 'design'}
        selectedCount={session.selection.length}
        onOpen={(asset) => {
          const full = assets.find((item) => item.id === asset.id);
          if (full) {
            void navigateToAsset(full);
          }
        }}
        onClose={() => (isBoards ? closeDetails() : (inspectorOpen = false))}
        onTrash={isBoards ? trashOne : undefined}
        onChooseColor={chooseColor}
      />
    </div>
  {/if}
</section>
{#if dialog === 'album'}<BulkAlbumDialog
    libraryScope={workspace === 'design' ? LibraryViewScope.Design : undefined}
    bind:open={
      () => dialog === 'album',
      (open) => {
        if (!open) {
          dialog = null;
        }
      }
    }
    count={session.selection.length}
    onSubmit={(payload) => void organize(payload)}
  />{/if}
{#if dialog === 'tags'}<BulkTagDialog
    bind:open={
      () => dialog === 'tags',
      (open) => {
        if (!open) {
          dialog = null;
        }
      }
    }
    count={session.selection.length}
    onSubmit={(payload) => void organize(payload)}
  />{/if}
{#if dialog === 'save'}<SearchSaveDialog
    bind:open={
      () => dialog === 'save',
      (open) => {
        if (!open) {
          dialog = null;
        }
      }
    }
    query={session.query}
    defaultName={colorText ? $t(colorText.key, { values: colorText.values }) : ''}
    count={results.countCapped ? null : results.count}
  />{/if}
<ResultsAssetViewer
  {assets}
  emptyRoute={context}
  {album}
  isShared={!!album?.shared}
  onRemove={reload}
  onAssetChange={reload}
/>

{#if linkDialog}{#await import('$lib/components/frameleaf/SaveLinkDialog.svelte') then { default: SaveLinkDialog }}
    <SaveLinkDialog
      bind:open={
        () => linkDialog !== null,
        (open) => {
          if (!open) {
            linkDialog = null;
          }
        }
      }
      url={linkDialog.url}
      albumId={album?.id}
      onSaved={() => generation++}
    />
  {/await}{/if}
{#if extensionOpen}{#await import('$lib/components/frameleaf/BoardsExtensionDialog.svelte') then { default: BoardsExtensionDialog }}
    <BoardsExtensionDialog bind:open={extensionOpen} />
  {/await}{/if}
{#if dialog === 'download'}{#await import('$lib/components/frameleaf/BoardsDownloadDialog.svelte') then { default: BoardsDownloadDialog }}
    <BoardsDownloadDialog
      bind:open={
        () => dialog === 'download',
        (open) => {
          if (!open) {
            dialog = null;
          }
        }
      }
      count={session.selection.length}
      name={album ? collectionName : title}
      {libraryAvailable}
      onDownload={downloadSelection}
    />
  {/await}{/if}

<style>
  /*
   * The page scrolls as one, header and filters included (FL-670): no small scroll area for the grid.
   * Details and the filter panel are a column of their own beside it, the page's full height
   * (prototype `.pro.with-inspector`), so they never scroll away with the items.
   */
  .fl-items-view {
    height: 100%;
    min-height: 0;
    display: flex;
  }
  .fl-items-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .fl-items-heading-actions {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  /* Prototype `.pro-head` and `.pro-toolbar`: the page's 24px gutter on a desktop (16px on phones, below). */
  .fl-items-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    padding: var(--fl-space-6) var(--fl-space-6) var(--fl-space-3);
  }
  .fl-items-add :global(.menu-root > button) {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .fl-items-add :global(.menu-root > button:hover) {
    background: var(--fl-accent-hover);
    border-color: var(--fl-accent-hover);
  }
  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  /* Prototype `.pro-title-row h1`: Boards' page title, the same size as a collection's. */
  .is-boards h1 {
    font-size: var(--fl-font-title);
  }
  .fl-items-description {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-items-toolbar {
    padding-inline: var(--fl-space-6);
  }
  .fl-items-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .fl-items-selection,
  .fl-items-footer {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    padding: var(--fl-space-2) var(--fl-space-4);
  }
  .fl-items-panes {
    display: flex;
    flex: 1 0 auto;
  }
  .fl-items-scroll {
    flex: 1;
    min-width: 0;
    padding: var(--fl-space-4) var(--fl-space-6) var(--fl-space-6);
  }
  .fl-items-panel {
    flex: 0 0 20rem;
    width: 20rem;
    max-width: 100%;
    height: 100%;
    overflow: auto;
    border-inline-start: 1px solid var(--fl-border);
  }
  /* Prototype `.pro-inspector`: 340px on the panel colour. */
  .is-boards .fl-items-panel {
    flex-basis: 340px;
    width: 340px;
    background: var(--fl-panel);
  }
  /* Boards' collection header brings its own top inset; the page keeps the 24px gutter (prototype .pro-head). */
  .is-boards .fl-items-heading.has-header {
    display: block;
  }
  /* Prototype `.pro-toolbar`: one row between hairlines, 12px above and below, the page's 24px gutter. */
  .fl-boards-browse {
    display: none;
  }
  .fl-items-heading,
  .fl-boards-toolbar,
  .fl-boards-active {
    flex-shrink: 0;
  }
  .fl-boards-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3) var(--fl-space-6);
    border-block: 1px solid var(--fl-border);
  }
  .fl-boards-toolbar-end {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    margin-inline-start: auto;
  }
  .fl-boards-search {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    flex: 1 1 220px;
    min-width: 180px;
    max-width: 360px;
    box-sizing: border-box;
    height: 2.75rem;
    padding: 0 var(--fl-space-3);
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .fl-boards-search:focus-within {
    border-color: var(--fl-accent);
  }
  .fl-boards-search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    min-height: 0;
    padding: 0;
    color: var(--fl-text);
    background: none;
    border: 0;
    font: inherit;
  }
  .fl-boards-search input:focus {
    outline: none;
  }
  .fl-boards-search input::-webkit-search-cancel-button {
    cursor: pointer;
  }
  /* The Type, Rating and Tags menus look like the Colour chip beside them. */
  .fl-items-chip-menu :global(.menu-root > button) {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 2.75rem;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .fl-items-chip-menu.is-on :global(.menu-root > button) {
    border-color: var(--fl-accent);
    box-shadow: inset 0 0 0 1px var(--fl-accent);
  }
  .fl-boards-icon-button {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-boards-icon-button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .fl-items-popover.fl-boards-view-pop {
    inset-inline: auto 0;
    width: min(18rem, calc(100vw - 2rem));
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
  }
  .fl-boards-segmented {
    display: flex;
    flex-wrap: wrap;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .fl-boards-segmented legend,
  .fl-boards-field span {
    width: 100%;
    margin-bottom: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-boards-segmented button {
    flex: 1;
    min-height: 2.25rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
  }
  .fl-boards-segmented button + button {
    border-inline-start: 0;
  }
  .fl-boards-segmented button:first-of-type {
    border-radius: var(--fl-radius-control) 0 0 var(--fl-radius-control);
  }
  .fl-boards-segmented button:last-of-type {
    border-radius: 0 var(--fl-radius-control) var(--fl-radius-control) 0;
  }
  .fl-boards-segmented button[aria-pressed='true'] {
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .fl-boards-field {
    display: flex;
    flex-direction: column;
  }
  .fl-boards-field input {
    accent-color: var(--fl-accent);
  }
  .fl-boards-check {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .fl-boards-check input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .fl-boards-note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* Prototype `.pro-active`: the pills under the toolbar. */
  .fl-boards-active {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3) var(--fl-space-6) 0;
  }
  .fl-boards-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--fl-space-1) 6px var(--fl-space-1) 10px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    font-size: var(--fl-font-callout);
  }
  .fl-boards-pill button {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border-radius: 50%;
    color: var(--fl-text);
  }
  .fl-boards-pill button:hover {
    background: var(--fl-border);
  }
  .fl-items-spacer {
    flex: 1;
  }
  .fl-items-popover-host {
    position: relative;
  }
  .fl-items-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 2.75rem;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 999px;
    cursor: pointer;
  }
  .fl-items-chip.is-on {
    border-color: var(--fl-accent);
    box-shadow: inset 0 0 0 1px var(--fl-accent);
  }
  .fl-items-chip:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .fl-items-chip-swatch {
    width: 1rem;
    height: 1rem;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
  }
  .fl-items-popover {
    position: absolute;
    inset-block-start: calc(100% + var(--fl-space-2));
    inset-inline-start: 0;
    z-index: 5;
    width: min(22rem, calc(100vw - 2rem));
    max-height: min(36rem, 70vh);
    overflow: auto;
    padding: var(--fl-space-4);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    box-shadow: var(--fl-shadow-pop, 0 12px 32px rgb(0 0 0 / 0.18));
  }
  /* Prototype `label.sort`: the sort icon sits inside the control's box, with the choice. */
  .fl-items-sort {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    box-sizing: border-box;
    height: 2.75rem;
    padding-inline-start: var(--fl-space-3);
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-items-sort:has(select:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .fl-items-sort select {
    align-self: stretch;
    min-height: 0;
    padding: 0 var(--fl-space-3) 0 var(--fl-space-1);
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .fl-items-first {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--fl-space-3);
    max-width: 34rem;
    margin: 0 auto;
    padding: var(--fl-space-8) var(--fl-space-4);
    text-align: center;
  }
  .fl-items-first h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  .fl-items-first p {
    margin: 0;
    color: var(--fl-muted);
  }
  .fl-items-first-icon {
    display: grid;
    place-items: center;
    width: 4.5rem;
    height: 4.5rem;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 12%, transparent);
    border-radius: 50%;
  }
  .fl-items-first-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
  }
  p.fl-items-first-note {
    font-size: var(--fl-font-small);
  }
  .fl-items-footer {
    justify-content: flex-end;
    border-top: 1px solid var(--fl-border);
  }
  .fl-items-selection {
    position: sticky;
    bottom: 0;
    z-index: 3;
    background: var(--fl-raised);
    border-top: 1px solid var(--fl-border);
  }
  @media (max-width: 700px) {
    .fl-items-heading {
      align-items: start;
      flex-wrap: wrap;
      padding: var(--fl-space-4) var(--fl-space-4) var(--fl-space-3);
    }
    .fl-items-scroll {
      padding: var(--fl-space-4);
    }
    .fl-items-panes {
      position: relative;
    }
    /*
     * P8 (UI review 2026-10-30): the filters, sort, Refresh, Filter and the details switch are one
     * row that scrolls sideways, edge to edge from the 16px gutter, every control 36px tall, instead
     * of wrapping over three rows.
     */
    .fl-items-toolbar {
      padding-inline: 0;
    }
    .fl-items-toolbar :global(.fl-chips) {
      padding-inline: var(--fl-space-4);
    }
    .fl-items-toolbar :global(.fl-toolbar-row) {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-inline: var(--fl-space-4);
      scroll-padding-inline: var(--fl-space-4);
      scrollbar-width: none;
    }
    .fl-items-toolbar :global(.fl-toolbar-row::-webkit-scrollbar) {
      display: none;
    }
    .fl-items-toolbar :global(.fl-toolbar-row > *) {
      flex: none;
    }
    .fl-items-toolbar :global(.fl-toolbar-leading) {
      order: 0;
      flex: none;
    }
    .fl-items-controls {
      flex-wrap: nowrap;
    }
    .fl-items-spacer {
      display: none;
    }
    .fl-boards-browse {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-2);
      min-height: 44px;
      margin-bottom: var(--fl-space-2);
      padding: 0;
      color: var(--fl-text);
      font-weight: 600;
    }
    .fl-boards-toolbar {
      flex-wrap: nowrap;
      overflow-x: auto;
      padding-inline: var(--fl-space-4);
      scrollbar-width: none;
    }
    .fl-boards-toolbar > *,
    .fl-boards-toolbar-end > * {
      flex: none;
    }
    .fl-boards-search {
      flex: 0 0 180px;
    }
    .fl-boards-active {
      padding-inline: var(--fl-space-4);
    }
    .fl-boards-toolbar :global(button),
    .fl-items-chip-menu :global(.menu-root > button),
    .fl-boards-search,
    .fl-boards-icon-button,
    .fl-items-controls :global(button),
    .fl-items-chip,
    .fl-items-sort {
      height: 36px;
      min-height: 36px;
      white-space: nowrap;
    }
    /* A popover cannot hang below a row that scrolls, so it opens over the foot of the screen. */
    .fl-items-popover {
      position: fixed;
      inset: auto var(--fl-space-4) calc(var(--fl-tabbar-space, 0px) + var(--fl-space-4));
      width: auto;
      max-height: 70dvh;
      z-index: 40;
    }
    /* Over the visible screen, wherever the page is scrolled: full width (Boards' 340px included), stopping
       above the tab bar so the last action is never hidden behind it. */
    .fl-items-panel,
    .is-boards .fl-items-panel {
      position: fixed;
      inset: var(--fl-topbar-height-phone, var(--fl-topbar-height)) 0 var(--fl-tabbar-space, 0px);
      flex-basis: auto;
      height: auto;
      max-height: none;
      width: 100%;
      border-inline-start: 0;
      background: var(--fl-panel);
      z-index: 30;
    }
  }
</style>
