<script lang="ts">
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility, TimeBucketDateType } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Recently added (FL-33 cleanup): the Frameleaf library ordered by when items arrived.
   *
   * The Frameleaf selection bar replaces the legacy select bar and carries the same actions,
   * including stacking, Live Photo linking and the refresh jobs.
   */
  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = {
    visibility: AssetVisibility.Timeline,
    withStacked: true,
    withPartners: true,
    dateType: TimeBucketDateType.Added,
  };
</script>

<UserPageLayout title={data.meta.title} scrollbar={false}>
  <LibraryView
    bind:timelineManager
    {options}
    destination={{ kind: 'library' }}
    downloadFileName={brandedArchiveName($t('frameleaf_archive_name_recently_added'))}
    enableRouting
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer
            bind:invisible={viewerInvisible}
            {timelineManager}
            removeAction={AssetAction.ARCHIVE}
            withStacked
          />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
