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
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiMapMarkerOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
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

  const openAsset = (assetId: string) => handlePromiseError(assetViewerManager.setAssetId(assetId));

  // The prototype's "Search this area" opens the Library over the visible bounds, titled "Map area".
  const searchArea = (area: MapArea) => handlePromiseError(goto(Route.photos({ area: formatMapArea(area) })));

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

{#if featureFlagsManager.value.map}
  <UserPageLayout>
    <div class="size-full [&>.frameleaf]:size-full">
      <Theme theme={appTheme}>
        <MapScreen title={data.meta.title} albumId={data.album?.id} onOpenAsset={openAsset} onSearchArea={searchArea} />
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
{:else}
  <!-- FL-51: an administrator turned the map off; say so instead of silently leaving for the Library
       (the prototype's empty-state card, MapView.jsx:839-845). -->
  <UserPageLayout>
    <Theme theme={appTheme}>
      <div class="map-off" role="status">
        <Icon icon={mdiMapMarkerOffOutline} size="30" />
        <strong>{$t('frameleaf_map_disabled_title')}</strong>
        <p>{$t('frameleaf_map_disabled_help')}</p>
        <a class="map-off-link" href={Route.places()}>{$t('frameleaf_map_disabled_places')}</a>
      </div>
    </Theme>
  </UserPageLayout>
{/if}

<style>
  .map-off {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: min(360px, calc(100% - 32px));
    margin: 18vh auto 0;
    padding: 24px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
    text-align: center;
    color: var(--fl-muted);
  }
  .map-off strong {
    color: var(--fl-text);
  }
  .map-off p {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .map-off-link {
    color: var(--fl-accent);
    font-weight: 560;
  }
</style>
