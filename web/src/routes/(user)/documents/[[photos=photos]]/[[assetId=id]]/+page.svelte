<script lang="ts">
  import { goto } from '$app/navigation';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import {
    DOCUMENT_PAGE_SIZE,
    DOCUMENT_SEARCH_DEBOUNCE_MS,
    LatestRequest,
    appendDocumentPage,
    isAbortError,
  } from '$lib/frameleaf/documents';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { sessionAccess, trackSessionLockRefresh } from '$lib/frameleaf/session-access.svelte';
  import '$lib/frameleaf/tokens.css';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { searchDocuments, type AssetResponseDto } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner } from '@immich/ui';
  import { mdiMagnify, mdiRefresh } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Documents (FL-63): the photos whose recognized text is visible, found by that text.
   *
   * The design reaches Documents from the rail's Explore section and shows it as a library screen:
   * the grid, the selection bar and the viewer, as every other collection. Where the prototype's
   * sample filtered on a tag, this lists what the text recognition actually read (and what the owner
   * corrected), so a photo is here because of the evidence in it. Opening one shows its text, where
   * each line is, and the owner's review of it in the information panel.
   *
   * Only the signed-in account's own photos are listed, and their Locked photos only while the session
   * is unlocked. The list is paged; typing starts a new search that cancels the one in flight, and a
   * late answer to an old search is dropped. Locking the session again empties the list at once and
   * reloads it without the Locked photos.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let query = $state(untrack(() => data.query));
  let assets: AssetResponseDto[] = $state([]);
  let total = $state(0);
  let nextPage = $state<number | null>(null);
  let isLoading = $state(true);
  let loadFailed = $state(false);

  const request = new LatestRequest();
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));
  const searching = $derived(query.trim().length > 0);

  const load = async (reset: boolean) => {
    if (!reset && (nextPage === null || isLoading)) {
      return;
    }

    const page = reset ? 1 : (nextPage ?? 1);
    const text = query.trim();
    const { signal, isCurrent } = request.start();
    isLoading = true;
    try {
      const response = await searchDocuments({ query: text || undefined, page, size: DOCUMENT_PAGE_SIZE }, { signal });
      if (!isCurrent()) {
        return;
      }
      assets = reset ? response.items : appendDocumentPage(assets, response.items);
      total = response.total;
      nextPage = response.nextPage ? Number(response.nextPage) : null;
      loadFailed = false;
    } catch (error) {
      if (!isCurrent() || isAbortError(error)) {
        return;
      }
      if (reset) {
        assets = [];
        total = 0;
        nextPage = null;
      }
      loadFailed = true;
      handleError(error, $t('frameleaf_documents_error_load'));
    } finally {
      if (isCurrent()) {
        isLoading = false;
      }
    }
  };

  /** Starts over: the list, the selection and any answer still on its way. */
  const restart = () => {
    librarySession.clearSelection();
    assets = [];
    total = 0;
    nextPage = null;
    return load(true);
  };

  const onQueryInput = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = undefined;
      const text = query.trim();
      void goto(Route.documents(text ? { query: text } : undefined), {
        replaceState: true,
        keepFocus: true,
        noScroll: true,
      });
      void restart();
    }, DOCUMENT_SEARCH_DEBOUNCE_MS);
  };

  const onRemoved = (assetIds: string[]) => {
    const removed = new Set(assetIds);
    const before = assets.length;
    assets = assets.filter((asset) => !removed.has(asset.id));
    total = Math.max(0, total - (before - assets.length));
  };

  const updateAsset = (updated: AssetResponseDto) => {
    const index = assets.findIndex((asset) => asset.id === updated.id);
    if (index !== -1) {
      assets[index] = updated;
    }
  };

  const handleSelectAll = () => librarySession.selectAll(assets.map((asset) => asset.id));

  // Locking the session again takes the Locked photos away at once; unlocking brings them back.
  let wasElevated = sessionAccess.isElevated;
  $effect(() => {
    const elevated = sessionAccess.isElevated;
    untrack(() => {
      if (elevated === wasElevated) {
        return;
      }
      wasElevated = elevated;
      void restart();
    });
  });

  onMount(() => {
    librarySession.clearSelection();
    void load(true);
    return eventManager.on({
      SessionAccessChanged: ({ isElevated }) => {
        if (!isElevated) {
          void trackSessionLockRefresh(restart());
        }
      },
    });
  });

  onDestroy(() => {
    request.cancel();
    if (debounce) {
      clearTimeout(debounce);
    }
  });
</script>

<UserPageLayout title={data.meta.title} scrollbar={false}>
  <section class="frameleaf documents m-4 mb-12">
    <ResultsView
      assets={timelineAssets}
      downloadFileName={brandedArchiveName($t('frameleaf_archive_name_documents'))}
      onEndReached={() => void load(false)}
      {onRemoved}
      onSelectAll={handleSelectAll}
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
    >
      {#snippet header()}
        <header class="documents-header">
          <div>
            <h1>{$t('frameleaf_documents_title')}</h1>
            <p class="sub" aria-live="polite">
              {#if isLoading && assets.length === 0}
                {$t('frameleaf_documents_loading')}
              {:else if searching}
                {$t('frameleaf_documents_match_count', { values: { count: total, query: query.trim() } })}
              {:else}
                {$t('frameleaf_documents_count', { values: { count: total } })}
              {/if}
            </p>
          </div>
          <label class="search">
            <Icon icon={mdiMagnify} size="1.125em" aria-hidden={true} />
            <input
              type="search"
              bind:value={query}
              oninput={onQueryInput}
              placeholder={$t('frameleaf_documents_search_placeholder')}
              aria-label={$t('frameleaf_documents_search_placeholder')}
              maxlength="200"
            />
          </label>
          <p class="note">{$t('frameleaf_documents_note')}</p>
        </header>
      {/snippet}

      {#snippet empty()}
        {#if !isLoading}
          <div class="flex min-h-[calc(66vh-11rem)] w-full flex-col place-content-center items-center gap-4">
            {#if loadFailed}
              <EmptyPlaceholder text={$t('frameleaf_documents_error_load')} />
              <Button size="small" color="secondary" leadingIcon={mdiRefresh} onclick={restart}>
                {$t('frameleaf_documents_retry')}
              </Button>
            {:else if searching}
              <EmptyPlaceholder text={$t('frameleaf_documents_no_matches', { values: { query: query.trim() } })} />
            {:else if !featureFlagsManager.value.ocr}
              <EmptyPlaceholder text={$t('frameleaf_documents_empty_disabled')} />
            {:else}
              <EmptyPlaceholder text={$t('frameleaf_documents_empty')} />
            {/if}
          </div>
        {/if}
      {/snippet}
    </ResultsView>

    {#if isLoading}
      <div class="flex items-center justify-center py-16">
        <LoadingSpinner size="giant" />
      </div>
    {/if}
  </section>
</UserPageLayout>

<ResultsAssetViewer
  {assets}
  emptyRoute={Route.documents()}
  onAssetChange={updateAsset}
  onRemove={(id) => onRemoved([id])}
/>

<style>
  .documents-header {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    align-items: flex-end;
    justify-content: space-between;
    padding-block: 0.5rem 1rem;
    color: var(--fl-text);
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .sub,
  .note {
    margin: 0.25rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .note {
    flex-basis: 100%;
    margin: 0;
  }
  .search {
    display: flex;
    flex: 0 1 22rem;
    gap: 0.5rem;
    align-items: center;
    min-width: min(100%, 14rem);
    min-height: 44px;
    padding: 0 0.75rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .search:focus-within {
    border-color: var(--fl-accent);
  }
  .search input {
    flex: 1;
    min-width: 0;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    outline: none;
  }
</style>
