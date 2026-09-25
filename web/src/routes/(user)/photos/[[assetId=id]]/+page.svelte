<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { formatMapArea, parseMapArea } from '$lib/frameleaf/map-settings';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The library page (FL-33): Timeline, Browse and Work over one live library session.
   *
   * The selection bar and its bulk actions are FL-32's Frameleaf bar, which `LibraryView` mounts
   * and binds to the same session, so this page no longer carries an action list of its own. The
   * viewer is still the production one and opens through the existing asset route.
   *
   * The prototype's library has no memory strip above the photos (FL-33, T-15): Memories is its own
   * destination, so the upstream `ImageCarousel` is gone, and an empty library shows the Frameleaf
   * empty state `LibraryView` draws rather than the legacy "click to upload" card.
   */
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  /**
   * The Map screen's "Search this area" lands here (prototype `MapView` onQuery → Library titled
   * "Map area"): the library narrowed to the area's bounds through the timeline's own `bbox`.
   * The session's server-side "select everything matching" knows nothing of the area, so the bar
   * offers the loaded selection instead while an area is shown.
   */
  const area = $derived(parseMapArea(page.url.searchParams.get('area')));
  const options = $derived({
    visibility: AssetVisibility.Timeline,
    withStacked: true,
    withPartners: true,
    ...(area && { bbox: formatMapArea(area) }),
  });
</script>

<UserPageLayout scrollbar={false}>
  <LibraryView
    bind:timelineManager
    {options}
    destination={{ kind: 'library' }}
    downloadFileName={brandedArchiveName($t('frameleaf_archive_name_photos'))}
    selectAll={area ? 'loaded' : 'matching'}
    enableRouting
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#if area}
      <div class="flex items-center gap-2 px-2 pt-4 text-(--fl-text)">
        <h1 class="text-xl font-semibold">{$t('frameleaf_map_area')}</h1>
        <IconButton label={$t('frameleaf_map_area_clear')} onclick={() => void goto(Route.photos())}>
          <Icon icon={mdiClose} size="18" />
        </IconButton>
      </div>
    {/if}

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
