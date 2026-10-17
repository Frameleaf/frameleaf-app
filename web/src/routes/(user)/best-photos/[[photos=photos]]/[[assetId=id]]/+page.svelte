<script lang="ts">
  import BestMoments from '$lib/components/frameleaf/BestMoments.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import type { BestMoment } from '$lib/frameleaf/best-moments';
  import { BEST_PHOTOS_QUALITY_MIN_SCORE } from '$lib/frameleaf/explore';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility, getBestPhotos, type BestPhotoAssetResponseDto } from '@frameleaf/sdk';
  import { mdiStarOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Best Photos (FL-50, LIB-P3): the standard library view over the photos and videos Frameleaf
   * rates highest, as the template's Best Photos collection is one of the library's destinations
   * (`App.jsx` `collection === "Best Photos"`). It has the large title with Timeline, Browse and
   * Work, the toolbar (Filter, Slideshow, sort, Grid / List), the date scrubber and the status
   * capsule like Favorites or Archive.
   *
   * The time buckets keep the owner's own items scored from the Best Photos threshold up
   * (`bestPhotos`). The Timeline groups them by date; Browse, Work and the list open on the quality
   * ranking ("Best first", `GET /timeline/ordered?sort=quality`), never on star ratings, which each
   * tile shows as everywhere else. Archived items stay out, as before.
   *
   * "Best moments in your videos" stays as a strip under the title: the ranked videos with a best
   * frame, each played from that moment.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = { visibility: AssetVisibility.Timeline, withStacked: true, bestPhotos: true };

  /**
   * The ranked items the moments strip reads (each video's best frame), from the same threshold the
   * grid's buckets and Explore's Best Photos card use, so the strip never lists a video the grid has not.
   */
  let rankedItems = $state<BestPhotoAssetResponseDto[]>([]);
  onMount(() => {
    getBestPhotos({ page: 1, limit: 500, minScore: BEST_PHOTOS_QUALITY_MIN_SCORE })
      .then((response) => (rankedItems = response.items))
      .catch(() => {
        // The strip is a refinement: without it the page still shows every best photo.
      });
  });

  /** A ranked video's best moment: open it in the viewer, starting there (FL-50). */
  const playMoment = ({ asset, timestampMs }: BestMoment) => {
    videoSeek.request(asset.id, timestampMs);
    void navigate({ targetRoute: 'current', assetId: asset.id });
  };
</script>

<UserPageLayout scrollbar={false}>
  <LibraryView
    bind:timelineManager
    title={data.meta.title}
    {options}
    ranked={true}
    destination={{ kind: 'library' }}
    downloadFileName={brandedArchiveName($t('frameleaf_archive_name_best_photos'))}
    enableRouting
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#snippet subheader()}
      <BestMoments assets={rankedItems} onPlay={playMoment} />
    {/snippet}

    {#snippet empty()}
      <LibraryEmptyState
        icon={mdiStarOutline}
        title={$t('frameleaf_best_photos_empty_title')}
        message={$t('frameleaf_best_photos_empty_body')}
      />
    {/snippet}

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} withStacked />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
