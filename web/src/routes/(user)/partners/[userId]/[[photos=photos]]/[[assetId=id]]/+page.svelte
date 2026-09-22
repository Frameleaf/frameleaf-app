<script lang="ts">
  import { goto } from '$app/navigation';
  import PartnerLibraryHeader from '$lib/components/frameleaf/PartnerLibraryHeader.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import CreateSharedLink from '$lib/components/timeline/actions/CreateSharedLinkAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { AssetVisibility, type PartnerResponseDto } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider } from '@immich/ui';
  import { mdiArrowLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // The partner header (FL-54) below needs an up-to-date `inTimeline` for its toggle and
  // a live asset count; both can change after the load already ran (the toggle itself, or
  // assets loading into the timeline), so they are held here rather than read once from data.
  let partner: PartnerResponseDto = $state(data.partner);
  let timelineManager = $state<TimelineManager>();

  const options = $derived({
    userId: data.partner.id,
    visibility: AssetVisibility.Timeline,
    withStacked: true,
  });

  const handleEscape = () => {
    if (!assetMultiSelectManager.selectionActive) {
      return;
    }

    assetMultiSelectManager.clear();
    return;
  };
</script>

<main class="relative h-dvh overflow-hidden px-2 pt-(--navbar-height) max-md:pt-(--navbar-height-md) md:px-6">
  <Timeline
    enableRouting={true}
    {options}
    bind:timelineManager
    assetInteraction={assetMultiSelectManager}
    onEscape={handleEscape}
  >
    <!-- FL-54: the partner library's own header (identity, show-in-timeline toggle, stop
         sharing) renders inside Timeline's own scrollable header section (the same slot
         AlbumViewer.svelte uses for the album title), so it scrolls with the grid instead of
         being clipped by `main`'s fixed height. -->
    <section class="px-2 pt-8 md:px-0 md:pt-24">
      <PartnerLibraryHeader
        bind:partner
        count={timelineManager?.assetCount ?? 0}
        onStopped={() => goto(Route.sharing())}
      />
    </section>
  </Timeline>
</main>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {@const Actions = getAssetBulkActions($t)}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
    <CreateSharedLink />
    <ActionButton action={Actions.AddToAlbum} />
    <DownloadAction />
  </AssetSelectControlBar>
{:else}
  <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(Route.sharing())}>
    {#snippet leading()}
      <p class="whitespace-nowrap text-immich-fg dark:text-immich-dark-fg">
        {$t('partner_list_user_photos', { values: { user: data.partner.name } })}
      </p>
    {/snippet}
  </ControlAppBar>
{/if}
