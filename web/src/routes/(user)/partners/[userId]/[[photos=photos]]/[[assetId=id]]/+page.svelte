<script lang="ts">
  import { goto } from '$app/navigation';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import PartnerLibraryHeader from '$lib/components/frameleaf/PartnerLibraryHeader.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility, type PartnerResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * A partner's library (FL-33 cleanup): the Frameleaf library over someone else's photos.
   *
   * Nothing here is owned by the signed-in user, so the bulk set narrows itself: the selection bar
   * skips every action whose asset belongs to someone else, which leaves the share link, add to
   * album and download the legacy select bar offered.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // The partner header (FL-54) below needs an up-to-date `inTimeline` for its toggle and
  // a live asset count; both can change after the load already ran (the toggle itself, or
  // assets loading into the timeline), so they are held here rather than read once from data.
  let partner: PartnerResponseDto = $state(data.partner);
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);

  /**
   * FL-54: when this partner stops sharing while the page is open, nothing of theirs stays on
   * screen: an open viewer closes, the timeline is dropped (the timeline manager does that for every
   * open timeline), and the page goes back to Sharing and says why.
   */
  const onPartnerRevoke = async ({ sharedById, sharedWithId }: { sharedById: string; sharedWithId: string }) => {
    if (sharedById !== data.partner.id || sharedWithId !== authManager.user.id) {
      return;
    }
    assetViewerManager.showAssetViewer(false);
    toastManager.primary($t('frameleaf_sharing.partner_revoked', { values: { name: partner.name } }));
    await goto(Route.sharing());
  };

  const options = $derived({
    userId: data.partner.id,
    visibility: AssetVisibility.Timeline,
    withStacked: true,
  });
</script>

<OnEvents {onPartnerRevoke} />

<!-- The Frameleaf shell (top bar and rail) replaces the legacy ControlAppBar (AL-41), as in PartnerLibrary.jsx. -->
<UserPageLayout scrollbar={false}>
  <LibraryView
    {options}
    bind:timelineManager
    destination={{ kind: 'library' }}
    downloadFileName={namedArchiveName(partner.name, $t('frameleaf_archive_name_partner'))}
    enableRouting
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    <!-- FL-54: the partner library's own header (identity, show-in-timeline toggle, stop
         sharing) renders inside the timeline's own scrollable header section, so it scrolls
         with the grid instead of being clipped by `main`'s fixed height. -->
    <section class="px-2 pt-2 md:px-0">
      <PartnerLibraryHeader
        bind:partner
        count={timelineManager?.assetCount ?? 0}
        onStopped={() => goto(Route.sharing())}
      />
    </section>

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} withStacked />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
