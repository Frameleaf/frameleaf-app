<script lang="ts">
  import '$lib/frameleaf/discovery.css';
  import BestMoments from '$lib/components/frameleaf/BestMoments.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import type { BestMoment } from '$lib/frameleaf/best-moments';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getBestPhotos, type BestPhotoAssetResponseDto } from '@frameleaf/sdk';
  import { mdiStarOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Best Photos (FL-50, FL-33 cleanup): the ranked results in the Frameleaf grid.
   *
   * These are a paged ranking rather than a timeline, so the page mounts `ResultsView` — the flat
   * counterpart of the library view — which binds the same session and the same FL-32 selection
   * bar. The legacy gallery grid and select bar are gone. The order is the server's quality ranking
   * (`GET /best-photos`), never star ratings; each tile shows the item's own star rating like every
   * other grid (T-6, `AssetTile.jsx:278-291`), so a rating is never presented as the quality score.
   * With no scored items the page says so rather than falling back to ratings.
   */
  let page = $state(1);
  let isLoading = $state(true);
  let assets: BestPhotoAssetResponseDto[] = $state([]);
  /** How many items are ranked in all, once the first page says. */
  let total = $state<number | null>(null);
  /** The first page could not be loaded: a retry in place, never "nothing ranked yet". */
  let loadFailed = $state(false);
  const SKELETON_TILES = Array.from({ length: 18 }, (_, index) => index);

  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));

  const onAssetDelete = (assetIds: string[]) => {
    const deleted = new Set(assetIds);
    assets = assets.filter((asset) => !deleted.has(asset.id));
  };

  const reload = async () => {
    page = 1;
    assets = [];
    loadFailed = false;
    await loadNextPage(true);
  };

  // eslint-disable-next-line svelte/valid-prop-names-in-kit-pages
  export const loadNextPage = async (force?: boolean) => {
    if (!page || (isLoading && !force)) {
      return;
    }

    isLoading = true;

    try {
      const response = await getBestPhotos({ page, limit: 100 });
      assets.push(...response.items);
      total = response.total;
      page = Number(response.nextPage) || 0;
    } catch (error) {
      if (assets.length === 0) {
        loadFailed = true;
      } else {
        handleError(error, $t('failed_to_load_assets'));
      }
    } finally {
      isLoading = false;
    }
  };

  /** A ranked video's best moment: open it in the viewer, starting there (FL-50). */
  const playMoment = ({ asset, timestampMs }: BestMoment) => {
    videoSeek.request(asset.id, timestampMs);
    void navigateToAsset(asset);
  };

  const handleSelectAll = () => librarySession.selectAll(assets.map((asset) => asset.id));

  const updateAsset = (updated: { id: string }) => {
    const index = assets.findIndex((asset) => asset.id === updated.id);
    if (index !== -1) {
      assets[index] = { ...assets[index], ...updated };
    }
  };

  onMount(() => {
    void reload();
  });
</script>

<UserPageLayout scrollbar={false}>
  <section class="m-4 mb-12 bg-(--fl-canvas)">
    <!-- The same header as Places, Tags, Folders and Memories: title, one line of what this is, count. -->
    <div class="fl-discovery best-photos-head">
      <header class="dv-header">
        <div>
          <h1>{$t('best_photos')}</h1>
          <p>
            {$t('frameleaf_best_photos_intro')}
            {#if total}
              · {$t('frameleaf_explore_item_count', { values: { count: total } })}
            {/if}
          </p>
        </div>
      </header>
    </div>
    <BestMoments {assets} onPlay={playMoment} />
    <ResultsView
      assets={timelineAssets}
      downloadFileName={brandedArchiveName($t('frameleaf_archive_name_best_photos'))}
      onEndReached={() => void loadNextPage()}
      onRemoved={onAssetDelete}
      onSelectAll={handleSelectAll}
      onOpen={(asset) => void navigateToAsset(asset)}
    >
      {#snippet empty()}
        {#if loadFailed}
          <div class="best-photos-state">
            <InlineError
              title={$t('frameleaf_best_photos_failed_title')}
              message={$t('frameleaf_search_failed_hint')}
              onRetry={reload}
              retrying={isLoading}
            />
          </div>
        {:else if !isLoading}
          <div class="best-photos-state">
            <EmptyState
              icon={mdiStarOutline}
              title={$t('frameleaf_best_photos_empty_title')}
              message={$t('frameleaf_best_photos_empty_body')}
            />
          </div>
        {/if}
      {/snippet}
    </ResultsView>

    {#if isLoading && assets.length === 0 && !loadFailed}
      <div class="best-photos-skeleton" aria-busy="true">
        <span class="sr-only">{$t('loading')}</span>
        {#each SKELETON_TILES as tile (tile)}
          <Skeleton variant="tile" />
        {/each}
      </div>
    {:else if isLoading && assets.length > 0}
      <div class="best-photos-more"><Spinner size="xl" /></div>
    {/if}
  </section>
</UserPageLayout>

<ResultsAssetViewer {assets} onAssetChange={updateAsset} onRemove={(id) => onAssetDelete([id])} />

<style>
  .best-photos-head {
    max-width: none;
    padding: var(--fl-space-2) 0 0;
  }
  .best-photos-state,
  .best-photos-skeleton,
  .best-photos-more {
    background: transparent;
  }
  .best-photos-state {
    display: grid;
    min-height: calc(66vh - 11rem);
    place-content: center;
  }
  .best-photos-skeleton {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: var(--fl-space-1);
  }
  .best-photos-more {
    display: flex;
    justify-content: center;
    padding: var(--fl-space-8) 0;
  }
</style>
