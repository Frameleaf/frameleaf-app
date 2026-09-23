<script lang="ts">
  import { goto } from '$app/navigation';
  import MapScreen from '$lib/components/frameleaf/MapScreen.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { formatMapArea, type MapArea } from '$lib/frameleaf/map-settings';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { handlePromiseError } from '$lib/utils';
  import { navigate } from '$lib/utils/navigation';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import { onDestroy } from 'svelte';
  import type { PageData } from './$types';

  /**
   * The Map screen (prototype `MapView.jsx`, FL-51): the whole library's located items, or one
   * album's when opened from the album's Map action (`/map?albumId=`, prototype `setMapScope`).
   * An item opens in the production viewer and closing it returns to the same map.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  onDestroy(() => {
    assetViewerManager.showAssetViewer(false);
  });

  if (!featureFlagsManager.value.map) {
    handlePromiseError(goto(Route.photos()));
  }

  const openAsset = (assetId: string) => handlePromiseError(assetViewerManager.setAssetId(assetId));

  // The prototype's "Search this area" opens the Library over the visible bounds, titled "Map area".
  const searchArea = (area: MapArea) => handlePromiseError(goto(Route.photos({ area: formatMapArea(area) })));

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

{#if featureFlagsManager.value.map}
  <UserPageLayout>
    <div class="size-full [&>.frameleaf]:size-full">
      <Theme theme={appTheme}>
        <MapScreen
          title={data.meta.title}
          scopedMarkers={data.albumMarkers}
          onOpenAsset={openAsset}
          onSearchArea={data.albumMarkers ? undefined : searchArea}
        />
      </Theme>
    </div>
  </UserPageLayout>
  <Portal target="body">
    {#if assetViewerManager.isViewing}
      {#await import('$lib/components/asset-viewer/AssetViewer.svelte') then { default: AssetViewer }}
        <AssetViewer
          cursor={{ current: assetViewerManager.asset! }}
          showNavigation={false}
          onClose={() => {
            assetViewerManager.showAssetViewer(false);
            handlePromiseError(navigate({ targetRoute: 'current', assetId: null }));
          }}
          onAssetUpdate={(updatedAsset) => {
            // The cursor prop is an inline literal, so mutating cursor.current
            // inside the viewer silently fails. Route updates through the
            // manager, which owns the $state-backed `asset`.
            assetViewerManager.setAsset(updatedAsset);
          }}
          isShared={false}
        />
      {/await}
    {/if}
  </Portal>
{/if}
