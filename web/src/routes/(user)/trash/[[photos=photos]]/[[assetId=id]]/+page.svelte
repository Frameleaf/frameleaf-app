<script lang="ts">
  import { goto } from '$app/navigation';
  import empty3Url from '$lib/assets/empty-3.svg';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getTrashActions } from '$lib/services/trash.service';
  import { handlePromiseError } from '$lib/utils';
  import { navigate } from '$lib/utils/navigation';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Trash (FL-33 cleanup): the Frameleaf library over the trashed items.
   *
   * `trash` in the bulk context is what replaces the legacy select bar's own action list: the live
   * actions give way to restore and permanent delete, which is exactly what that bar offered.
   */
  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = { isTrashed: true };

  if (!featureFlagsManager.value.trash) {
    handlePromiseError(goto(Route.photos()));
  }

  const { Empty, RestoreAll } = $derived(getTrashActions($t));
  const selecting = $derived(librarySession.selection.length > 0);
</script>

{#if featureFlagsManager.value.trash}
  <UserPageLayout
    hideNavbar={selecting}
    actions={selecting ? [] : [Empty, RestoreAll]}
    title={data.meta.title}
    scrollbar={false}
  >
    <LibraryView
      bind:timelineManager
      {options}
      destination={{ kind: 'trash' }}
      bulkContext={{ trash: true }}
      enableRouting
      syncUrl={false}
      selectAll="loaded"
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
    >
      <p class="p-4 font-medium text-gray-500/60 dark:text-gray-300/60">
        {$t('trashed_items_will_be_permanently_deleted_after', {
          values: { days: serverConfigManager.value.trashDays },
        })}
      </p>

      {#snippet empty()}
        <EmptyPlaceholder text={$t('trash_no_results_message')} src={empty3Url} class="mx-auto mt-10" />
      {/snippet}

      {#snippet viewer()}
        <Portal target="body">
          {#if assetViewerManager.isViewing}
            <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} />
          {/if}
        </Portal>
      {/snippet}
    </LibraryView>
  </UserPageLayout>
{/if}
