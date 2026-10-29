<script lang="ts">
  import { debounce } from 'lodash-es';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { onMount, onDestroy, untrack, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { DiscoveryQuery, DiscoveryFilterSection } from '$lib/components/discovery/query';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
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
  import { activeFilterFields } from '$lib/components/discovery/query';
  import { withFilterCondition } from '$lib/frameleaf/search-filters';
  import { shouldIgnoreEvent } from '$lib/actions/shortcut';
  import { downloadArchive, ignoreCancelledDownload } from '$lib/utils/asset-utils';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import {
    mdiAspectRatio,
    mdiChevronDown,
    mdiClose,
    mdiContentSaveOutline,
    mdiLinkVariantPlus,
    mdiPaletteOutline,
    mdiPaletteSwatchOutline,
    mdiPuzzleOutline,
    mdiSort,
    mdiTrayArrowUp,
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
    LibraryScope,
    LibraryViewScope,
    LibraryAssetItemKind,
    type ColorFilter as ColorCondition,
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
  }: {
    title: string;
    query: DiscoveryQuery;
    onQueryChange: (query: DiscoveryQuery) => void;
    header?: Snippet;
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
  } = $props();
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
  let popover = $state<'color' | 'shape' | null>(null);
  let colorTrigger: HTMLButtonElement | undefined = $state();
  let shapeTrigger: HTMLButtonElement | undefined = $state();
  let dialog = $state<'album' | 'tags' | 'save' | null>(null);
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
  /** Filters the page itself states (the workspace, the collection) are not the person's own narrowing. */
  const scopeFields = $derived(album ? ['libraryScope', 'albumIds'] : ['libraryScope']);
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
    session.selection.length > 0
      ? session.selection.find((id) => id.startsWith('bookmark:'))?.slice(9)
      : activeBookmark,
  );
  const selectedAsset = $derived(timelineAssets.find((asset) => session.selection.includes(asset.id)) ?? null);
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
      return libraryItemSearchRequest(session.query, sort, kinds);
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
  const download = () => {
    if (selectedAssetIds.length > 0) {
      void downloadArchive(album?.albumName || 'frameleaf', { assetIds: [...selectedAssetIds] }).catch(
        ignoreCancelledDownload,
      );
    }
  };
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

<section
  class="frameleaf fl-items-view"
  data-theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}
  aria-label={title}
>
  <header class="fl-items-heading">
    {#if header}{@render header()}{:else}<div>
        <h1>{title}</h1>
        <p class="fl-items-description">{$t('frameleaf_pro_description')}</p>
      </div>{/if}
    <LibraryLayoutSwitch {session} />
  </header>
  <ResultsToolbar
    {session}
    count={results.count}
    onOpenFilterPanel={(section) => (filterSection = section)}
    filterPanelOpen={filterSection !== null}
    onCloseFilterPanel={() => (filterSection = null)}
    {inspectorOpen}
    onToggleInspector={() => (inspectorOpen = !inspectorOpen)}
  />
  <div class="fl-items-controls" role="toolbar" aria-label={$t('frameleaf_boards_filters')}>
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
        <div class="fl-items-popover" role="dialog" aria-label={$t('frameleaf_boards_size_and_shape')} use:dismissable>
          <DimensionFilters filter={session.query.filter} onChange={setFilter} onDone={closePopover} />
        </div>
      {/if}
    </div>
    <Button
      pressed={session.query.filter.hasAlbums?.eq === false}
      onclick={() => setFilter('hasAlbums', session.query.filter.hasAlbums?.eq === false ? undefined : { eq: false })}
      >{$t('frameleaf_pro_unfiled')}</Button
    >
    {#if narrowed}<Button variant="quiet" onclick={() => (dialog = 'save')}
        ><Icon icon={mdiContentSaveOutline} size="16" aria-hidden />{$t('frameleaf_boards_save_smart')}</Button
      >{/if}
    <span class="fl-items-spacer"></span>
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
    <Button onclick={() => refresh()}>{$t('refresh')}</Button>
    {#if session.layout === 'work'}<WorkFileNamesToggle {preferences} />{/if}
    {#if results.countCapped}<span role="status">{$t('frameleaf_pro_count_capped')}</span>{/if}
  </div>
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
      <ResultsView
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
      >
        {#snippet empty()}{#if !results.loading && !failed}
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
      </ResultsView>
      {#if results.nextCursor}<Button disabled={results.loading} onclick={() => void load()}
          >{$t('frameleaf_library_show_more')}</Button
        >{/if}
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
          onClose={closeBookmark}
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
          onClose={() => (inspectorOpen = false)}
          onChooseColor={chooseColor}
        />
      </div>
    {/if}
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
  <footer class="fl-items-footer"><ThumbnailSizeControl {preferences} /></footer>
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

<style>
  .fl-items-view {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .fl-items-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4);
  }
  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }
  .fl-items-description {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-items-controls,
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
    flex: 1;
    min-height: 0;
  }
  .fl-items-scroll {
    flex: 1;
    min-width: 0;
    overflow: auto;
    padding: var(--fl-space-4);
  }
  .fl-items-panel {
    flex: 0 0 20rem;
    width: 20rem;
    max-width: 100%;
    overflow: auto;
    border-inline-start: 1px solid var(--fl-border);
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
  .fl-items-chip:focus-visible,
  .fl-items-sort select:focus-visible {
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
  .fl-items-sort {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    color: var(--fl-muted);
  }
  .fl-items-sort select {
    min-height: 2.75rem;
    padding: 0 var(--fl-space-2);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
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
    background: var(--fl-raised);
    border-top: 1px solid var(--fl-border);
  }
  @media (max-width: 700px) {
    .fl-items-heading {
      align-items: start;
      flex-wrap: wrap;
    }
    .fl-items-panes {
      position: relative;
    }
    .fl-items-panel {
      position: absolute;
      inset: 0;
      width: 100%;
      background: var(--fl-panel);
      z-index: 2;
    }
  }
</style>
