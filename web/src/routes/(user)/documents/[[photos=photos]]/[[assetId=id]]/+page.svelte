<script lang="ts">
  import { goto } from '$app/navigation';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
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
  import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { searchDocuments, type AssetResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiMagnify, mdiPlayBoxOutline, mdiRefresh, mdiTextBoxSearchOutline } from '@mdi/js';
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

  /** The Library's Slideshow (LibraryView `startSlideshow`): from the first document, in the viewer. */
  const startSlideshow = async () => {
    const first = assets[0];
    if (!first) {
      return;
    }
    await navigate({ targetRoute: 'current', assetId: first.id });
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
  };
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
        replace: true,
        reset: false,
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

<!--
  The Library view (prototype: the rail's Documents opens the Library narrowed to them): the Library's
  header and title, a line saying where the list comes from, the toolbar band with the count and the
  text search, then the grid and the Library's empty state.
-->
<UserPageLayout scrollbar={false}>
  <section class="frameleaf documents">
    <header class="doc-head">
      <h1>{$t('frameleaf_documents_title')}</h1>
    </header>
    <p class="doc-hint">{$t('frameleaf_documents_note')}</p>
    <div class="doc-toolbar">
      <p class="doc-count" aria-live="polite">
        {#if isLoading && assets.length === 0}
          {$t('frameleaf_documents_loading')}
        {:else if searching}
          {$t('frameleaf_documents_match_count', { values: { count: total, query: query.trim() } })}
        {:else}
          {$t('frameleaf_documents_count', { values: { count: total } })}
        {/if}
      </p>
      <!-- The Library's toolbar as far as a text search allows: the search narrows the list (the
           Library's Filter), then Slideshow. A flat, relevance-ordered list has no layout or sort. -->
      <div class="doc-tools">
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
        <Button disabled={assets.length === 0} onclick={() => void startSlideshow()}>
          <Icon icon={mdiPlayBoxOutline} size="16" aria-hidden={true} />
          {$t('slideshow')}
        </Button>
      </div>
    </div>

    <div class="doc-grid">
      <ResultsView
        assets={timelineAssets}
        downloadFileName={brandedArchiveName($t('frameleaf_archive_name_documents'))}
        onEndReached={() => void load(false)}
        {onRemoved}
        onSelectAll={handleSelectAll}
        onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
      >
        {#snippet empty()}
          {#if !isLoading}
            <div class="doc-empty">
              {#if loadFailed}
                <EmptyState
                  icon={mdiTextBoxSearchOutline}
                  message={$t('frameleaf_documents_error_load')}
                  secondaryAction={{ label: $t('frameleaf_documents_retry'), icon: mdiRefresh, onClick: restart }}
                />
              {:else if searching}
                <EmptyState
                  icon={mdiTextBoxSearchOutline}
                  message={$t('frameleaf_documents_no_matches', { values: { query: query.trim() } })}
                />
              {:else if !featureFlagsManager.value.ocr}
                <EmptyState icon={mdiTextBoxSearchOutline} message={$t('frameleaf_documents_empty_disabled')} />
              {:else}
                <EmptyState icon={mdiTextBoxSearchOutline} message={$t('frameleaf_documents_empty')} />
              {/if}
            </div>
          {/if}
        {/snippet}
      </ResultsView>
    </div>

    {#if isLoading}
      <div class="doc-loading">
        <Spinner size="xl" />
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
  /*
   * The Library's frame (LibraryView `.fl-library-header`, `.fl-layout-hint`, `.fl-library-toolbar`):
   * the page area's 8px plus 16px make the 24px gutter (8px plus 8px on a phone); the header's
   * hairline and the toolbar band run edge to edge across the page area.
   */
  .documents {
    --doc-bleed: calc(-1 * (var(--fl-page-inline) + var(--fl-space-2)));
    display: flex;
    flex-direction: column;
    padding: 0 var(--fl-page-inline) var(--fl-space-12);
    color: var(--fl-text);
  }
  .doc-head {
    position: relative;
    padding: calc(var(--fl-page-top) - var(--fl-space-2)) 0 var(--fl-space-3);
  }
  .doc-head::after {
    content: '';
    position: absolute;
    bottom: 0;
    inset-inline: var(--doc-bleed);
    border-bottom: 1px solid var(--fl-border);
  }
  /* The Library's title (`.fl-library-title`). */
  h1 {
    margin: 0;
    /* One page-title size on every page (tokens.css --fl-type-display: 28px / 600). */
    font-size: var(--fl-font-display);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.15;
  }
  /* Where the Library says what its layout is for (`.fl-layout-hint`). */
  .doc-hint {
    margin: 0;
    padding-block: var(--fl-space-4);
    color: var(--fl-muted);
    font-size: 13px;
  }
  .doc-toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2) var(--fl-space-3);
    padding-block: var(--fl-space-3);
  }
  .doc-toolbar::before {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline: var(--doc-bleed);
    z-index: -1;
    border-bottom: 1px solid var(--fl-material-edge);
    background: var(--fl-material);
    -webkit-backdrop-filter: var(--fl-material-blur);
    backdrop-filter: var(--fl-material-blur);
  }
  .doc-count {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .doc-tools {
    display: flex;
    flex: 0 1 30rem;
    justify-content: flex-end;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .search {
    display: flex;
    flex: 1 1 22rem;
    gap: var(--fl-space-2);
    align-items: center;
    min-width: min(100%, 14rem);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  /* The field's own outline is off; the ring is drawn round the whole control instead. */
  .search:focus-within {
    border-color: var(--fl-accent);
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .search input {
    flex: 1;
    min-width: 0;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    outline: none;
  }
  /* The grid starts under the band, at the photo gutter. */
  .doc-grid {
    padding-top: var(--fl-space-half);
  }
  .doc-empty {
    display: grid;
    min-height: calc(66vh - 11rem);
    place-content: center;
  }
  .doc-loading {
    display: flex;
    justify-content: center;
    padding: var(--fl-space-12) 0;
  }
  @media (max-width: 767px) {
    .documents {
      padding-bottom: var(--fl-space-8);
    }
    .doc-tools {
      flex-basis: 100%;
    }
    .search {
      flex: 1 1 auto;
    }
  }
  @media (pointer: coarse) {
    .search {
      min-height: var(--fl-control-height-touch);
    }
  }
  @media (max-width: 767px) {
    h1 {
      font-size: var(--fl-font-title);
    }
  }
</style>
