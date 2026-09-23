<script lang="ts">
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Favorites (FL-33 cleanup): the Frameleaf library bound to the favourites scope.
   *
   * The legacy timeline and its select bar are gone. The Frameleaf selection bar carries the whole
   * bulk set, so the actions this page used to list one by one — unfavorite, share link, select
   * all, add to album, download, change date, description and location, archive, mark sensitive,
   * tag, move to the Locked folder and delete — are the same actions the bar offers everywhere.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = { isFavorite: true, withStacked: true };
</script>

<UserPageLayout hideNavbar={librarySession.selection.length > 0} title={data.meta.title} scrollbar={false}>
  <LibraryView
    bind:timelineManager
    {options}
    destination={{ kind: 'favorites' }}
    downloadFileName={brandedArchiveName($t('frameleaf_archive_name_favorites'))}
    enableRouting
    syncUrl={false}
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_favorites_message')} class="mx-auto mt-10" />
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
