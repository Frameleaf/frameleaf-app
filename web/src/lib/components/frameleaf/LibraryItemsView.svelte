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
  import { libraryItemSearchRequest } from '$lib/frameleaf/library-item-search';
  import { organizeLibraryItems } from '$lib/frameleaf/library-item-organization';
  import type { BulkActionContext } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { libraryGridPreferences, designLibraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { LibraryViewScope, LibraryAssetItemKind, type ColorFilter } from '@frameleaf/sdk';

  let {
    title,
    query,
    onQueryChange,
    header,
    context = '/pro',
    workspace = 'design',
    album,
    bulkContext,
  }: {
    title: string;
    query: DiscoveryQuery;
    onQueryChange: (query: DiscoveryQuery) => void;
    header?: Snippet;
    context?: string;
    workspace?: 'personal' | 'design';
    album?: import('@frameleaf/sdk').AlbumResponseDto;
    bulkContext?: Omit<BulkActionContext, 'assets' | 'count' | 'currentUserId' | 'snapshot'>;
  } = $props();
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
  let colorOrder = $state(false);
  let dialog = $state<'album' | 'tags' | null>(null);
  let lastExternal = '';
  let requestIdentity = '';
  const assets = $derived(
    results.items.flatMap((item) =>
      item.kind === LibraryAssetItemKind.Asset && 'ownerId' in item.asset ? [item.asset] : [],
    ),
  );
  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));
  const mixedSelected = $derived(session.selection.some((id) => id.startsWith('bookmark:')));
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
      return libraryItemSearchRequest(
        session.query,
        colorOrder && session.query.filter.color && session.query.mode !== 'smart' ? 'color' : 'added',
      );
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
        activeBookmark = null;
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
  const chooseColor = (color: ColorFilter) => {
    session.setQuery({ ...session.query, filter: { ...session.query.filter, color } });
    filterSection = 'media';
  };
  const organize = async (payload: BulkPayload, operation: 'add' | 'remove' = 'add') => {
    const keys = [...session.selection];
    const owner = authManager.user.id;
    const current = authManager.captureSession();
    const version = generation;
    dialog = null;
    organizing = true;
    organizationFailed = false;
    try {
      await organizeLibraryItems(
        results.items,
        keys,
        owner,
        payload,
        () => current() && generation === version,
        operation,
      );
      if (current() && generation === version) {
        session.clearSelection();
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
  const closeBookmark = () => {
    const key = selectedBookmark ? `bookmark:${selectedBookmark}` : undefined;
    activeBookmark = null;
    session.clearSelection();
    if (key) {
      document.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(key)}"] button`)?.focus();
    }
  };
</script>

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
    sorts={['imported-desc']}
    onOpenFilterPanel={(section) => (filterSection = section)}
    filterPanelOpen={filterSection !== null}
    onCloseFilterPanel={() => (filterSection = null)}
    {inspectorOpen}
    onToggleInspector={() => (inspectorOpen = !inspectorOpen)}
  />
  <div class="fl-items-controls">
    <Button
      pressed={session.query.filter.hasAlbums?.eq === false}
      onclick={() => {
        const filter = { ...session.query.filter };
        if (filter.hasAlbums?.eq === false) {
          delete filter.hasAlbums;
        } else {
          filter.hasAlbums = { eq: false };
        }
        session.setQuery({ ...session.query, filter });
      }}>{$t('frameleaf_pro_unfiled')}</Button
    >
    {#if session.query.filter.color && session.query.mode !== 'smart'}<Button
        pressed={colorOrder}
        onclick={() => (colorOrder = !colorOrder)}>{$t('frameleaf_pro_color_order')}</Button
      >{/if}
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
        noSelectionBar={mixedSelected}
        onSelectAll={() => session.selectAll(orderedKeys)}
        onRemoved={reload}
      >
        {#snippet empty()}{#if !results.loading && !failed}<p class="fl-items-empty">
              {$t('frameleaf_pro_empty')}
            </p>{/if}{/snippet}
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
    {:else if inspectorOpen && selectedBookmark && bookmarkRecord?.kind === 'bookmark'}
      <div class="fl-items-panel">
        <BookmarkInspector
          id={selectedBookmark}
          bookmark={bookmarkRecord.bookmark}
          onClose={closeBookmark}
          onChange={reload}
        />
      </div>
    {:else if inspectorOpen && selectedAsset}
      <div class="fl-items-panel">
        <LibraryWorkInspector
          asset={selectedAsset}
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
  {#if mixedSelected}
    <div
      class="fl-items-selection"
      role="toolbar"
      aria-label={$t('frameleaf_pro_selection', { values: { count: session.selection.length } })}
    >
      <span>{$t('frameleaf_pro_selection', { values: { count: session.selection.length } })}</span>
      <Button disabled={organizing || !canOrganize} onclick={() => (dialog = 'album')}
        >{$t('frameleaf_bulk_add_to_album')}</Button
      >
      <Button disabled={organizing || !canOrganize} onclick={() => (dialog = 'tags')}>{$t('tags')}</Button>
      {#if bulkContext?.albumId}<Button
          disabled={organizing}
          onclick={() => void organize({ albumId: bulkContext!.albumId! }, 'remove')}
          >{$t('frameleaf_bulk_remove_from_album')}</Button
        >{/if}
      <Button disabled={organizing} onclick={() => session.clearSelection()}>{$t('clear')}</Button>
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
<ResultsAssetViewer
  {assets}
  emptyRoute={context}
  {album}
  isShared={!!album?.shared}
  onRemove={reload}
  onAssetChange={reload}
/>

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
  .fl-items-empty {
    color: var(--fl-muted);
    padding: var(--fl-space-8);
    text-align: center;
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
