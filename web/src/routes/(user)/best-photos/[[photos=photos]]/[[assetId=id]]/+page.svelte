<script lang="ts">
  import BestMoments from '$lib/components/frameleaf/BestMoments.svelte';
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import type { BestMoment } from '$lib/frameleaf/best-moments';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { navigateToAsset } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getBestPhotos, type BestPhotoAssetResponseDto } from '@immich/sdk';
  import { LoadingSpinner } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

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
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let page = $state(1);
  let isLoading = $state(true);
  let assets: BestPhotoAssetResponseDto[] = $state([]);

  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));

  const onAssetDelete = (assetIds: string[]) => {
    const deleted = new Set(assetIds);
    assets = assets.filter((asset) => !deleted.has(asset.id));
  };

  const reload = async () => {
    page = 1;
    assets = [];
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
      page = Number(response.nextPage) || 0;
    } catch (error) {
      handleError(error, $t('failed_to_load_assets'));
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

<UserPageLayout title={data.meta.title} scrollbar={false}>
  <section class="m-4 mb-12 bg-immich-bg dark:bg-immich-dark-bg">
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
        {#if !isLoading}
          <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center">
            <EmptyPlaceholder text={$t('no_best_photos_scored')} />
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

<ResultsAssetViewer {assets} onAssetChange={updateAsset} onRemove={(id) => onAssetDelete([id])} />
