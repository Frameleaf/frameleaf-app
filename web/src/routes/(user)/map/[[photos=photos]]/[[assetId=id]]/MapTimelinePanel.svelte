<script lang="ts">
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import type { SelectionBBox } from '$lib/components/shared-components/map/types';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { mapSettings } from '$lib/stores/preferences.store';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { AssetVisibility } from '@immich/sdk';
  import { CloseButton, Icon } from '@immich/ui';
  import { mdiImageMultiple } from '@mdi/js';
  import { ceil, floor } from 'lodash-es';
  import { t } from 'svelte-i18n';

  /**
   * The map's timeline panel (FL-33 cleanup): the Frameleaf library over the assets inside the
   * map's current selection, with FL-32's selection bar in place of the legacy select bar.
   *
   * The panel never routes to the viewer — the map owns the page's URL — so items open inside the
   * map's own flow rather than through this panel.
   */
  interface Props {
    bbox: SelectionBBox;
    selectedClusterIds: Set<string>;
    assetCount: number;
    onClose: () => void;
  }

  let { bbox, selectedClusterIds, assetCount, onClose }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;

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
      syncUrl={false}
      selectAll="loaded"
    />
  </div>
</aside>
