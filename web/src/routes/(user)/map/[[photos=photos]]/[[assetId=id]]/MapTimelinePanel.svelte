<script lang="ts">
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import type { SelectionBBox } from '$lib/components/shared-components/map/types';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { mapSettings } from '$lib/stores/preferences.store';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@immich/sdk';
  import { CloseButton, Icon } from '@immich/ui';
  import { mdiImageMultiple } from '@mdi/js';
  import { ceil, floor } from 'lodash-es';
  import { t } from 'svelte-i18n';

  /**
   * The map's timeline panel (FL-33 cleanup): the Frameleaf library over the assets inside the
   * map's current selection, with FL-32's selection bar in place of the legacy select bar.
   *
   * The panel does not restore scroll from the URL — the map owns where the page lands — but an
   * item still opens in the production viewer, as it did from the legacy timeline here.
   */
  interface Props {
    bbox: SelectionBBox;
    selectedClusterIds: Set<string>;
    assetCount: number;
    onClose: () => void;
  }

  let { bbox, selectedClusterIds, assetCount, onClose }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);

  const timelineBoundingBox = $derived(
    `${floor(bbox.west, 6)},${floor(bbox.south, 6)},${ceil(bbox.east, 6)},${ceil(bbox.north, 6)}`,
  );

  const timelineOptions = $derived({
    bbox: timelineBoundingBox,
    visibility: $mapSettings.withPartners
      ? AssetVisibility.Timeline
      : $mapSettings.includeArchived
        ? undefined
        : AssetVisibility.Timeline,
    isFavorite: $mapSettings.onlyFavorites || undefined,
    withPartners: $mapSettings.withPartners || undefined,
    assetFilter: selectedClusterIds,
  });

  $effect.pre(() => {
    void timelineOptions;
    librarySession.clearSelection();
  });
</script>

<aside class="flex size-full flex-col overflow-hidden bg-immich-bg contain-content dark:bg-immich-dark-bg">
  <div class="flex items-center justify-between border-b border-gray-200 pe-1 pb-1 dark:border-immich-dark-gray">
    <div class="flex items-center gap-2">
      <Icon icon={mdiImageMultiple} size="20" />
      <p class="text-sm font-medium text-immich-fg dark:text-immich-dark-fg">
        {$t('assets_count', { values: { count: assetCount } })}
      </p>
    </div>
    <CloseButton onclick={onClose} />
  </div>

  <div class="min-h-0 flex-1">
    <LibraryView
      bind:timelineManager
      options={timelineOptions}
      destination={{ kind: 'place' }}
      downloadFileName={brandedArchiveName($t('frameleaf_archive_name_map'))}
      syncUrl={false}
      selectAll="loaded"
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
    >
      {#snippet viewer()}
        <Portal target="body">
          {#if assetViewerManager.isViewing}
            <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} />
          {/if}
        </Portal>
      {/snippet}
    </LibraryView>
  </div>
</aside>
