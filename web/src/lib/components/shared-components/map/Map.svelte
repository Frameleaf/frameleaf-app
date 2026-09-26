<script lang="ts" module>
  import { addProtocol, setWorkerUrl } from 'maplibre-gl';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
  import { Protocol } from 'pmtiles';

  let protocol = new Protocol();
  setWorkerUrl(workerUrl);
  void addProtocol('pmtiles', protocol.tile);
</script>

<script lang="ts">
  import { afterNavigate } from '$app/navigation';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { getAssetMediaUrl, handlePromiseError } from '$lib/utils';
  import { type MapMarkerResponseDto } from '@immich/sdk';
  import { Alert, Container, Icon, Text, Theme, themeManager } from '@immich/ui';
  import { mdiMap, mdiMapMarker } from '@mdi/js';
  import type { Feature, GeoJsonProperties, Geometry, Point } from 'geojson';
  import {
    GlobeControl,
    LngLat,
    LngLatBounds,
    Marker,
    type GeoJSONSource,
    type LngLatLike,
    type Map,
    type MapMouseEvent,
  } from 'maplibre-gl';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import {
    AttributionControl,
    Control,
    ControlButton,
    ControlGroup,
    GeoJSON,
    GeolocateControl,
    MapLibre,
    MarkerLayer,
    NavigationControl,
    Popup,
    ScaleControl,
  } from 'svelte-maplibre';

  /**
   * The small embedded map (asset detail, location pickers, a shared space's places, an album's
   * public map). It always draws the markers it is given; the Map screen is `MapScreen`.
   */
  interface Props {
    mapMarkers?: MapMarkerResponseDto[];
    zoom?: number | undefined;
    center?: LngLatLike | undefined;
    simplified?: boolean;
    clickable?: boolean;
    useLocationPin?: boolean;
    onOpenInMapView?: (() => Promise<void> | void) | undefined;
    onSelect?: (assetIds: string[]) => void;
    onClickPoint?: ({ lat, lng }: { lat: number; lng: number }) => void;
    popup?: import('svelte').Snippet<[{ marker: MapMarkerResponseDto }]>;
    rounded?: boolean;
    showSimpleControls?: boolean;
    autoFitBounds?: boolean;
  }

  let {
    mapMarkers = [],
    zoom = undefined,
    center = $bindable(undefined),
    simplified = false,
    clickable = false,
    useLocationPin = false,
    onOpenInMapView = undefined,
    onSelect = () => {},
    onClickPoint = () => {},
    popup,
    rounded = false,
    showSimpleControls = true,
    autoFitBounds = true,
  }: Props = $props();

  // Calculate initial bounds from markers once during initialization
  const initialBounds = (() => {
    if (!autoFitBounds || center || zoom !== undefined || mapMarkers.length === 0) {
      return undefined;
    }

    const bounds = new LngLatBounds();
    for (const marker of mapMarkers) {
      bounds.extend([marker.lon, marker.lat]);
    }
    return bounds;
  })();

  let map: Map | undefined = $state();
  let marker: Marker | null = null;
  const mapTheme = $derived(themeManager.value);
  const styleUrl = $derived(
    mapTheme === Theme.Dark ? serverConfigManager.value.mapDarkStyleUrl : serverConfigManager.value.mapLightStyleUrl,
  );

  export function addClipMapMarker(lng: number, lat: number) {
    if (!map) {
      return;
    }

    if (marker) {
      marker.remove();
    }

    center = { lng, lat };
    marker = new Marker().setLngLat([lng, lat]).addTo(map);
  }

  function handleAssetClick(assetId: string, map: Map | null) {
    if (!map) {
      return;
    }
    onSelect([assetId]);
  }

  async function handleClusterClick(clusterId: number, map: Map | null) {
    if (!map) {
      return;
    }

    const mapSource = map.getSource('geojson') as GeoJSONSource;
    const leaves = await mapSource.getClusterLeaves(clusterId, 10_000, 0);
    const ids = leaves.map((leaf) => leaf.properties?.id as string);
    onSelect(ids);
  }

  function handleMapClick(event: MapMouseEvent) {
    if (!clickable) {
      return;
    }

    const { lng, lat } = event.lngLat;
    onClickPoint({ lng, lat });

    if (marker) {
      marker.remove();
    }

    if (map) {
      marker = new Marker().setLngLat([lng, lat]).addTo(map);
    }
  }

  type FeaturePoint = Feature<Point, { id: string; city: string | null; state: string | null; country: string | null }>;

  const asFeature = (marker: MapMarkerResponseDto): FeaturePoint => {
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [marker.lon, marker.lat] },
      properties: {
        id: marker.id,
        city: marker.city,
        state: marker.state,
        country: marker.country,
      },
    };
  };

  const asMarker = (feature: Feature<Geometry, GeoJsonProperties>): MapMarkerResponseDto => {
    const featurePoint = feature as FeaturePoint;
    const coords = LngLat.convert(featurePoint.geometry.coordinates as [number, number]);
    return {
      lat: coords.lat,
      lon: coords.lng,
      id: featurePoint.properties.id,
      city: featurePoint.properties.city,
      state: featurePoint.properties.state,
      country: featurePoint.properties.country,
    };
  };

  afterNavigate(() => {
    if (!map) {
      return;
    }

    map.resize();
  });

  $effect(() => {
    map?.setStyle(styleUrl, {
      transformStyle: (previousStyle, nextStyle) => {
        if (previousStyle) {
          // Preserves the custom map markers from the previous style when the theme is switched
          // Required until https://github.com/dimfeld/svelte-maplibre/issues/146 is fixed
          const customLayers = previousStyle.layers.filter((l) => l.type === 'fill' && l.source === 'geojson');
          const layers = nextStyle.layers.concat(customLayers);
          const sources = nextStyle.sources;

          for (const [key, value] of Object.entries(previousStyle.sources || {})) {
            if (key.startsWith('geojson')) {
              sources[key] = value;
            }
          }

          return {
            ...nextStyle,
            sources,
            layers,
          };
        }
        return nextStyle;
      },
    });
  });

  $effect(() => {
    if (!center || !zoom) {
      return;
    }

    untrack(() => map?.jumpTo({ center, zoom }));
  });
</script>

<svelte:boundary>
  <!--  We handle style loading ourselves so we set style blank here -->
  <MapLibre
    style=""
    class="h-full {rounded ? 'rounded-2xl' : 'rounded-none'}"
    {zoom}
    {center}
    bounds={initialBounds}
    fitBoundsOptions={{ padding: 50, maxZoom: 15 }}
    attributionControl={false}
    diffStyleUpdates={true}
    onload={(event: Map) => {
      event.setMaxZoom(18);
      event.on('click', handleMapClick);
      if (!simplified) {
        event.addControl(new GlobeControl(), 'top-left');
      }
    }}
    bind:map
  >
    {#snippet children({ map }: { map: Map })}
      {#if showSimpleControls}
        <NavigationControl position="top-left" showCompass={!simplified} />

        {#if !simplified}
          <GeolocateControl position="top-left" />
          <ScaleControl />
          <AttributionControl compact={false} />
        {/if}
      {/if}

      {#if onOpenInMapView && showSimpleControls}
        <Control position="top-right">
          <ControlGroup>
            <ControlButton onclick={() => onOpenInMapView()}>
              <Icon title={$t('open_in_map_view')} icon={mdiMap} size="100%" class="text-black/80" />
            </ControlButton>
          </ControlGroup>
        </Control>
      {/if}

      <GeoJSON
        data={{
          type: 'FeatureCollection',
          features: mapMarkers.map((marker) => asFeature(marker)),
        }}
        id="geojson"
        cluster={{ radius: 35, maxZoom: 18 }}
      >
        <MarkerLayer
          applyToClusters
          asButton
          onclick={(event) => handlePromiseError(handleClusterClick(event.feature.properties?.cluster_id, map))}
        >
          {#snippet children({ feature })}
            <div
              class="flex size-10 items-center justify-center rounded-full bg-immich-primary font-mono font-bold text-white opacity-90 shadow-lg transition-all duration-200 hover:bg-immich-dark-primary hover:text-immich-dark-bg"
            >
              {feature.properties?.point_count?.toLocaleString()}
            </div>
          {/snippet}
        </MarkerLayer>
        <MarkerLayer
          applyToClusters={false}
          asButton
          onclick={(event) => {
            if (!popup) {
              handleAssetClick(event.feature.properties?.id, map);
            }
          }}
        >
          {#snippet children({ feature }: { feature: Feature })}
            {#if useLocationPin}
              <Icon icon={mdiMapMarker} size="50px" class="translate-y-[calc(5px-50%)] text-primary" />
            {:else}
              <img
                src={getAssetMediaUrl({ id: feature.properties?.id })}
                class="size-15 rounded-full border-2 border-immich-primary bg-immich-primary object-cover shadow-lg transition-all duration-200 hover:scale-150 hover:border-immich-dark-primary"
                alt={feature.properties?.city && feature.properties.country
                  ? $t('map_marker_for_image', {
                      values: { city: feature.properties.city, country: feature.properties.country },
                    })
                  : $t('map_marker_with_image')}
              />
            {/if}
            {#if popup}
              <Popup offset={[0, -30]} openOn="click" closeOnClickOutside>
                {@render popup({ marker: asMarker(feature) })}
              </Popup>
            {/if}
          {/snippet}
        </MarkerLayer>
      </GeoJSON>
    {/snippet}
  </MapLibre>

  {#snippet failed()}
    <Container size="small" class="p-2">
      <Alert color="warning" title={$t('errors.unable_to_load_map')} size={simplified ? 'medium' : 'large'}>
        <Text size={simplified ? 'small' : 'medium'}>{$t('errors.unable_to_load_map_description')}</Text>
      </Alert>
    </Container>
  {/snippet}
</svelte:boundary>
