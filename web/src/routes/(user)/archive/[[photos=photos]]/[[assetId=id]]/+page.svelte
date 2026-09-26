<script lang="ts">
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@immich/sdk';
  import { mdiArchiveOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Archive (FL-33 cleanup): the Frameleaf library scoped to archived items.
   *
   * The Frameleaf selection bar replaces the legacy select bar outright, and offers the same
   * actions it did — unarchive, share link, select all, add to album, favorite, download, mark
   * sensitive, move to the Locked folder and delete — from the one bulk set.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = { visibility: AssetVisibility.Archive };
</script>

<UserPageLayout title={data.meta.title} scrollbar={false}>
  <LibraryView
    bind:timelineManager
    {options}
    destination={{ kind: 'archive' }}
    downloadFileName={brandedArchiveName($t('frameleaf_archive_name_archive'))}
    enableRouting
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#snippet empty()}
      <LibraryEmptyState icon={mdiArchiveOutline} message={$t('no_archived_assets_message')} />
    {/snippet}

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer
            bind:invisible={viewerInvisible}
            {timelineManager}
            removeAction={AssetAction.UNARCHIVE}
          />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
