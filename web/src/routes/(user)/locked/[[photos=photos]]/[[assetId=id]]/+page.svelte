<script lang="ts">
  import { goto } from '$app/navigation';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getUserActions } from '$lib/services/user.service';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * The Locked folder (FL-33 cleanup): the Frameleaf library over the locked items.
   *
   * `locked` in the bulk context keeps this destination's own, narrower action set — move out of
   * the Locked folder, download, change date and location, and the permanent delete — which is
   * exactly what the legacy select bar offered here. Sharing, albums and the refresh jobs are not
   * offered on locked items, as they were not before.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = { visibility: AssetVisibility.Locked };

  const { LockSession } = $derived(getUserActions($t));

  const onSessionLocked = async () => {
    await goto(Route.photos());
  };
</script>

<OnEvents {onSessionLocked} />

<UserPageLayout
  title={data.meta.title}
  actions={[LockSession]}
  hideNavbar={librarySession.selection.length > 0}
  scrollbar={false}
>
  <LibraryView
    bind:timelineManager
    {options}
    destination={{ kind: 'library' }}
    bulkContext={{ locked: true }}
    enableRouting
    syncUrl={false}
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_locked_photos_message')} title={$t('nothing_here_yet')} class="mx-auto mt-10" />
    {/snippet}

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer
            bind:invisible={viewerInvisible}
            {timelineManager}
            removeAction={AssetAction.SET_VISIBILITY_TIMELINE}
          />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
