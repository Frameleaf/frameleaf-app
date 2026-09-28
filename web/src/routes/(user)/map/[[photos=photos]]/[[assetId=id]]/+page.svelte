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
  import { filmstripPlaceholder } from '$lib/frameleaf/viewer-filmstrip';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
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

  /**
   * V-17: the items in view when one was opened are the viewer's neighbours and its filmstrip. The map
   * opens an item in place (its address carries none), so the viewer moves the same way.
   */
  let neighbourIds = $state<string[]>([]);
  let neighbours = $state<{ nextAsset?: AssetResponseDto; previousAsset?: AssetResponseDto }>({});

  const openAsset = (assetId: string, inView: string[] = []) => {
    neighbourIds = inView.includes(assetId) ? inView : [];
    handlePromiseError(assetViewerManager.setAssetId(assetId));
  };

  const loadAsset = (id?: string) =>
    id ? getAssetInfo({ ...authManager.params, id }).catch(() => undefined) : Promise.resolve(undefined);

  $effect(() => {
    const current = assetViewerManager.isViewing ? assetViewerManager.asset : undefined;
    const index = current ? neighbourIds.indexOf(current.id) : -1;
    neighbours = {};
    if (index === -1) {
      return;
    }
    let cancelled = false;
    void Promise.all([loadAsset(neighbourIds[index + 1]), loadAsset(neighbourIds[index - 1])]).then(
      ([nextAsset, previousAsset]) => {
        if (!cancelled) {
          neighbours = { nextAsset, previousAsset };
        }
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const filmstripAssets = $derived(
    authManager.authenticated && neighbourIds.length > 1
      ? neighbourIds.map((id) => filmstripPlaceholder({ id, ownerId: authManager.user.id }))
      : [],
  );

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
          cursor={{ current: assetViewerManager.asset!, ...neighbours }}
          showNavigation={neighbourIds.length > 1}
          {filmstripAssets}
          onNavigateToAsset={async ({ id }) => {
            await assetViewerManager.setAssetId(id);
          }}
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
