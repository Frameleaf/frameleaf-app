<script lang="ts" module>
  import { addProtocol, setWorkerUrl } from 'maplibre-gl';
  import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
  import { Protocol } from 'pmtiles';

  const protocol = new Protocol();
  setWorkerUrl(workerUrl);
  void addProtocol('pmtiles', protocol.tile);
</script>

<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { applyClusterLabelLayout, clusterRadius, MAP_CLUSTER_DISTANCE } from '$lib/frameleaf/map-clusters';
  import {
    markerCardLine,
    markerDetail,
    markerPlace,
    markerRowLine,
    markerTypeCounts,
  } from '$lib/frameleaf/map-markers';
  import { mapDateWindow, MAP_DATE_PRESETS, type MapArea } from '$lib/frameleaf/map-settings';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { mapSettings, type MapSettings } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getAlbumMapMarkers,
    getMapMarkers,
    getMapStatistics,
    type MapMarkerResponseDto,
    type MapStatisticsResponseDto,
  } from '@immich/sdk';
  import { Icon, Theme, themeManager } from '@immich/ui';
  import {
    mdiArrowExpandAll,
    mdiClose,
    mdiCogOutline,
    mdiCrosshairsGps,
    mdiImageOutline,
    mdiMapMarkerOffOutline,
    mdiMagnify,
    mdiMapMarkerMultipleOutline,
    mdiMapMarkerOutline,
    mdiMinus,
    mdiPlus,
    mdiViewListOutline,
  } from '@mdi/js';
  import type { Feature, Point } from 'geojson';
  import { LngLatBounds, type GeoJSONSource, type Map } from 'maplibre-gl';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AttributionControl, GeoJSON, MapLibre, MarkerLayer } from 'svelte-maplibre';

  /**
   * The Map screen (prototype `MapView.jsx`, FL-51): located items as clusters over the configured
   * tile source, with the prototype's chrome — the in-view chip, "Search this area", the tools
   * column (zoom, show all, list, settings), the legend, the settings sheet and the "In view" list.
   *
   * Markers come from the existing endpoints with the settings sheet's filters: `GET /map/markers`
   * for the whole library, or the album's own `GET /albums/{id}/map-markers` when the screen is
   * scoped to an album (`/map?albumId=`, prototype `setMapScope("collection")`), where each switch
   * only narrows the album's own items.
   */
  interface Props {
    /** Scope the screen to this album's located items. */
    albumId?: string;
    /** Accessible name of the map region. */
    title: string;
    /** Opens an item; `inView` is the items in view, in the list's order, for the viewer's filmstrip (V-17). */
    onOpenAsset: (assetId: string, inView: string[]) => void;
    /** "Search this area": the prototype opens the Library over the visible bounds. */
    onSearchArea?: (area: MapArea) => void;
  }

  let { albumId, title, onOpenAsset, onSearchArea }: Props = $props();

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 18;

  type SettingsSwitch = 'includeArchived' | 'withSharedAlbums' | 'withPartners' | 'onlyFavorites' | 'showAssetPanel';
  const presetLabels = $derived({
    all: $t('frameleaf_map_preset_all'),
    '30d': $t('frameleaf_map_preset_30d'),
    year: $t('frameleaf_map_preset_year'),
    custom: $t('frameleaf_map_preset_custom'),
  });
  const switches = $derived<{ key: SettingsSwitch; label: string }[]>([
    { key: 'includeArchived', label: $t('frameleaf_map_include_archived') },
    { key: 'withSharedAlbums', label: $t('frameleaf_map_include_shared') },
    { key: 'withPartners', label: $t('frameleaf_map_include_partner') },
    { key: 'onlyFavorites', label: $t('frameleaf_map_only_favorites') },
    { key: 'showAssetPanel', label: $t('frameleaf_map_asset_panel') },
  ]);

  const scoped = $derived(albumId !== undefined);

  let map = $state<Map>();
  let loadedMarkers = $state<MapMarkerResponseDto[]>([]);
  let loaded = $state(false);
  let inView = $state<MapMarkerResponseDto[]>([]);
  let zoom = $state(2);
  let changed = $state(false);
  let settingsOpen = $state(false);
  let status = $state('');
  let hoveredCluster = $state<Feature>();
  let hoveredSingle = $state<Feature>();
  let gear = $state<HTMLElement>();
  let settingsSheet = $state<HTMLElement>();
  let fitted = false;
  let abort: AbortController | undefined;
  /** MapView.jsx settings counts: archived and partner items and items without a location (library scope). */
  let statistics = $state<MapStatisticsResponseDto>();
  /**
   * FL-51: the configured tile source cannot be reached (offline, or the style or its tiles fail).
   * The located items stay reachable through the "In view" list, which needs no tiles.
   */
  let tilesFailed = $state(false);
  let offline = $state(typeof navigator !== 'undefined' && !navigator.onLine);

  const markers = $derived(loadedMarkers);
  const listOpen = $derived($mapSettings.showAssetPanel);
  const styleUrl = $derived(
    themeManager.value === Theme.Dark
      ? serverConfigManager.value.mapDarkStyleUrl
      : serverConfigManager.value.mapLightStyleUrl,
  );
  // A link from Places, an asset's location or the map itself carries `#zoom/lat/lng`.
  const focusedByLink = typeof location !== 'undefined' && /^#[\d.-]+\/[\d.-]+\/[\d.-]+/.test(location.hash);

  const patchSettings = (patch: Partial<MapSettings>) => ($mapSettings = { ...$mapSettings, ...patch });
  const focusGear = () => gear?.querySelector('button')?.focus();

  /* ------------------------------------------------------------------ */
  /* Markers                                                             */
  /* ------------------------------------------------------------------ */
  // A string, so toggling the list or the sheet (same store) does not refetch the markers.
  const filterKey = $derived(
    JSON.stringify(
      albumId
        ? {
            id: albumId,
            // an album shows archived items and everyone else's items unless the sheet leaves them
            // out, so these are sent either way; withSharedAlbums narrows nothing in album scope
            isArchived: $mapSettings.includeArchived,
            isFavorite: $mapSettings.onlyFavorites || undefined,
            withPartners: $mapSettings.withPartners,
            withSharedAlbums: $mapSettings.withSharedAlbums,
            ...mapDateWindow($mapSettings),
          }
        : {
            isArchived: $mapSettings.includeArchived || undefined,
            isFavorite: $mapSettings.onlyFavorites || undefined,
            withPartners: $mapSettings.withPartners || undefined,
            withSharedAlbums: $mapSettings.withSharedAlbums || undefined,
            ...mapDateWindow($mapSettings),
          },
    ),
  );

  $effect(() => {
    const query: unknown = JSON.parse(filterKey);
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    const request = albumId
      ? getAlbumMapMarkers(query as Parameters<typeof getAlbumMapMarkers>[0], { signal: controller.signal })
      : getMapMarkers(query as Parameters<typeof getMapMarkers>[0], { signal: controller.signal });
    request
      .then((result) => {
        loadedMarkers = result;
        loaded = true;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        loaded = true;
        handleError(error, $t('errors.unable_to_load_map'));
      });
  });

  onDestroy(() => abort?.abort());

  // The settings sheet's counts follow its date and favorite filters (not the switches they count for).
  const statisticsKey = $derived(
    JSON.stringify({ isFavorite: $mapSettings.onlyFavorites || undefined, ...mapDateWindow($mapSettings) }),
  );
  $effect(() => {
    const query = JSON.parse(statisticsKey) as Parameters<typeof getMapStatistics>[0];
    if (scoped) {
      statistics = undefined;
      return;
    }
    let stale = false;
    getMapStatistics(query)
      .then((result) => {
        if (!stale) {
          statistics = result;
        }
      })
      .catch(() => {
        // the counts are a hint beside the switches; the markers still load without them
        if (!stale) {
          statistics = undefined;
        }
      });
    return () => {
      stale = true;
    };
  });

  const placeOf = markerPlace;

  const features = $derived({
    type: 'FeatureCollection' as const,
    features: markers.map(
      (marker): Feature<Point, { id: string; place: string; name: string; line: string; video: boolean }> => {
        const detail = markerDetail(marker);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [marker.lon, marker.lat] },
          properties: {
            id: marker.id,
            place: detail.place,
            name: detail.name ?? '',
            line: markerCardLine(detail),
            video: detail.video,
          },
        };
      },
    ),
  });
  const counts = $derived(markerTypeCounts(inView));

  const retryTiles = () => {
    tilesFailed = false;
    map?.setStyle(styleUrl);
  };

  /* ------------------------------------------------------------------ */
  /* Viewport                                                            */
  /* ------------------------------------------------------------------ */
  const extent = () => {
    const bounds = new LngLatBounds();
    for (const marker of markers) {
      bounds.extend([marker.lon, marker.lat]);
    }
    return bounds;
  };

  const updateInView = () => {
    if (!map) {
      return;
    }
    const bounds = map.getBounds();
    const all = bounds.getEast() - bounds.getWest() >= 360;
    inView = all ? markers : markers.filter(({ lon, lat }) => bounds.contains([lon, lat]));
    zoom = map.getZoom();
  };

  const fitAll = (announce = true) => {
    if (!map || markers.length === 0) {
      return;
    }
    map.fitBounds(extent(), { padding: 48, maxZoom: 15, animate: announce });
    changed = false;
    if (announce) {
      status = $t('frameleaf_map_status_reset');
    }
  };

  // Fit once the first markers arrive, unless a link asked for a particular place.
  $effect(() => {
    if (!map || !loaded || fitted) {
      return;
    }
    fitted = true;
    if (scoped || !focusedByLink) {
      fitAll(false);
    }
    updateInView();
  });

  // New markers (a settings change) re-count what is in view without moving the map.
  $effect(() => {
    void markers;
    updateInView();
  });

  // Keeps the markers when the theme swaps the style (svelte-maplibre#146).
  $effect(() => {
    map?.setStyle(styleUrl, {
      transformStyle: (previous, next) => {
        if (!previous) {
          return next;
        }
        const sources = next.sources;
        for (const [key, value] of Object.entries(previous.sources || {})) {
          if (key.startsWith('geojson')) {
            sources[key] = value;
          }
        }
        return { ...next, sources };
      },
    });
  });

  const zoomBy = (delta: number) => {
    if (!map) {
      return;
    }
    map.zoomTo(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, map.getZoom() + delta)));
    changed = true;
  };

  const openCluster = async (feature: Feature) => {
    if (!map) {
      return;
    }
    const clusterId = feature.properties?.cluster_id as number;
    const count = feature.properties?.point_count as number;
    const source = map.getSource('geojson') as GeoJSONSource;
    const expansion = await source.getClusterExpansionZoom(clusterId);
    const [lng, lat] = (feature.geometry as Point).coordinates;
    map.easeTo({ center: [lng, lat], zoom: Math.min(MAX_ZOOM, Math.max(expansion, map.getZoom() + 2)) });
    changed = true;
    status = $t('frameleaf_map_status_zoomed', { values: { count } });
  };

  const locate = (marker: MapMarkerResponseDto) => {
    map?.easeTo({ center: [marker.lon, marker.lat], zoom: Math.max(map.getZoom(), 12) });
    changed = true;
    status = $t('frameleaf_map_status_centred', { values: { place: placeOf(marker) || $t('frameleaf_map_item') } });
  };

  const searchArea = () => {
    if (!map) {
      return;
    }
    const bounds = map.getBounds();
    changed = false;
    status = $t('frameleaf_map_status_searching', { values: { count: inView.length } });
    onSearchArea?.({
      west: Math.max(-180, bounds.getWest()),
      south: Math.max(-90, bounds.getSouth()),
      east: Math.min(180, bounds.getEast()),
      north: Math.min(90, bounds.getNorth()),
    });
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (settingsOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      settingsOpen = false;
      focusGear();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.classList.contains('maplibregl-canvas') && (event.key === 'Home' || event.key === '0')) {
      event.preventDefault();
      fitAll();
    }
  };

  const toggleSettings = async () => {
    settingsOpen = !settingsOpen;
    if (settingsOpen) {
      await tick();
      settingsSheet?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
    }
  };

  const coordinatesOf = (feature: Feature) => {
    const [lng, lat] = (feature.geometry as Point).coordinates;
    return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
  };
</script>

<svelte:window
  ononline={() => {
    offline = false;
    if (tilesFailed) {
      retryTiles();
    }
  }}
  onoffline={() => (offline = true)}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fl-map" class:with-list={listOpen} onkeydown={onKeydown}>
  <div
    class="stage"
    role="region"
    aria-label={$t('frameleaf_map_region', { values: { title, count: inView.length } })}
    aria-describedby="fl-map-help"
  >
    <MapLibre
      style=""
      hash={!scoped}
      class="fl-map-canvas"
      attributionControl={false}
      diffStyleUpdates={true}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      onload={(instance: Map) => {
        // MapView.jsx:230-240: place names start past their dot and clear of the bubbles, on every style.
        const layoutLabels = () => applyClusterLabelLayout(instance, 'geojson');
        instance.on('styledata', layoutLabels);
        instance.on('sourcedata', (event: { sourceId?: string }) => {
          if (event.sourceId === 'geojson') {
            layoutLabels();
          }
        });
        instance.on('moveend', (event: { originalEvent?: unknown }) => {
          if (event.originalEvent) {
            changed = true;
          }
          updateInView();
        });
        // FL-51: a style or tile that cannot be fetched (offline, or the tile server is unreachable)
        // shows the offline state instead of a silently blank map
        instance.on('error', (event) => {
          if ((event as { sourceId?: string }).sourceId !== 'geojson') {
            tilesFailed = true;
          }
        });
      }}
      bind:map
    >
      <AttributionControl compact position="bottom-right" />
      <GeoJSON data={features} id="geojson" cluster={{ radius: MAP_CLUSTER_DISTANCE, maxZoom: 17 }}>
        <MarkerLayer
          applyToClusters
          asButton
          bind:hovered={hoveredCluster}
          onclick={(event) => void openCluster(event.feature)}
        >
          {#snippet children({ feature })}
            {@const count = (feature.properties?.point_count as number) ?? 0}
            <span
              class="cluster"
              style:--fl-cluster-size="{clusterRadius(count) * 2}px"
              role="img"
              aria-label={$t('frameleaf_map_cluster_label', { values: { count } })}
            >
              {count.toLocaleString()}
              {#if hoveredCluster?.properties?.cluster_id === feature.properties?.cluster_id}
                <span class="card" aria-hidden="true">
                  <span class="card-empty"><Icon icon={mdiImageOutline} size="20" /></span>
                  <span class="card-copy">
                    <strong>{$t('frameleaf_map_items', { values: { count } })}</strong>
                    <small>{coordinatesOf(feature)}</small>
                  </span>
                </span>
              {/if}
            </span>
          {/snippet}
        </MarkerLayer>
        <MarkerLayer
          applyToClusters={false}
          asButton
          bind:hovered={hoveredSingle}
          onclick={(event) =>
            onOpenAsset(
              event.feature.properties?.id as string,
              inView.map(({ id }) => id),
            )}
        >
          {#snippet children({ feature })}
            {@const id = feature.properties?.id as string}
            {@const place = feature.properties?.place as string}
            {@const name = (feature.properties?.name as string) || $t('frameleaf_map_item')}
            {@const line = feature.properties?.line as string}
            <!-- MapView.jsx:582-584, 626-628, 634-658: "Open name, place", a video dot, and the hover
                 card with the file name over the capture day and place. -->
            <span class="single">
              <img
                src={getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail })}
                alt={place
                  ? $t('frameleaf_map_open_named_at', { values: { name, place } })
                  : $t('frameleaf_map_open_named', { values: { name } })}
              />
              {#if feature.properties?.video}
                <span class="video-dot" aria-hidden="true"></span>
              {/if}
              {#if hoveredSingle?.properties?.id === id}
                <span class="card" aria-hidden="true">
                  <img src={getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail })} alt="" />
                  <span class="card-copy">
                    <strong>{name}</strong>
                    <small>{line || coordinatesOf(feature)}</small>
                  </span>
                </span>
              {/if}
            </span>
          {/snippet}
        </MarkerLayer>
      </GeoJSON>
    </MapLibre>

    <p id="fl-map-help" class="sr-only">{$t('frameleaf_map_help')}</p>

    <div class="overlay top-left">
      <span class="chip">
        <Icon icon={mdiMapMarkerMultipleOutline} size="16" />
        {$t('frameleaf_map_in_view', { values: { count: inView.length } })}
        <small>· {$t('frameleaf_map_located', { values: { count: markers.length } })}</small>
      </span>
    </div>

    {#if changed && onSearchArea}
      <div class="overlay top-center">
        <Button variant="primary" onclick={searchArea}>
          <Icon icon={mdiMagnify} size="18" />
          {$t('frameleaf_map_search_this_area')}
        </Button>
      </div>
    {/if}

    <div class="overlay tools" role="toolbar" aria-label={$t('frameleaf_map_tools')}>
      <IconButton label={$t('frameleaf_map_zoom_in')} disabled={zoom >= MAX_ZOOM} onclick={() => zoomBy(0.5)}>
        <Icon icon={mdiPlus} size="20" />
      </IconButton>
      <IconButton label={$t('frameleaf_map_zoom_out')} disabled={zoom <= MIN_ZOOM} onclick={() => zoomBy(-0.5)}>
        <Icon icon={mdiMinus} size="20" />
      </IconButton>
      <IconButton label={$t('frameleaf_map_show_all')} onclick={() => fitAll()}>
        <Icon icon={mdiArrowExpandAll} size="20" />
      </IconButton>
      <IconButton
        label={listOpen ? $t('frameleaf_map_hide_list') : $t('frameleaf_map_show_list')}
        pressed={listOpen}
        onclick={() => patchSettings({ showAssetPanel: !listOpen })}
      >
        <Icon icon={mdiViewListOutline} size="20" />
      </IconButton>
      <span bind:this={gear} class="gear">
        <IconButton label={$t('frameleaf_map_settings')} pressed={settingsOpen} onclick={() => void toggleSettings()}>
          <Icon icon={mdiCogOutline} size="20" />
        </IconButton>
      </span>
    </div>

    <div class="overlay legend" role="group" aria-label={$t('frameleaf_map_legend')}>
      <span><i class="dot small"></i> 1</span>
      <span><i class="dot"></i> 2–9</span>
      <span><i class="dot large"></i> 10+</span>
      <span class="legend-counts">
        {$t('frameleaf_map_legend_counts', { values: { photos: counts.photos, videos: counts.videos } })}
      </span>
    </div>

    {#if tilesFailed || offline}
      <!-- FL-51: the tile source cannot be reached; the prototype's empty-state card, with the list
           as the way to the located items. -->
      <div class="offline" role="status">
        <Icon icon={mdiMapMarkerOffOutline} size="24" />
        <strong>{offline ? $t('frameleaf_map_offline_title') : $t('frameleaf_map_tiles_failed_title')}</strong>
        <p>{$t('frameleaf_map_tiles_failed_help')}</p>
        <div class="offline-actions">
          {#if !listOpen}
            <Button onclick={() => patchSettings({ showAssetPanel: true })}>{$t('frameleaf_map_show_list')}</Button>
          {/if}
          {#if !offline}
            <Button onclick={retryTiles}>{$t('frameleaf_map_try_again')}</Button>
          {/if}
        </div>
      </div>
    {/if}

    {#if settingsOpen}
      <div class="settings" role="dialog" aria-label={$t('frameleaf_map_settings')} bind:this={settingsSheet}>
        <header>
          <strong>{$t('frameleaf_map_settings')}</strong>
          <IconButton
            label={$t('frameleaf_map_close_settings')}
            onclick={() => {
              settingsOpen = false;
              focusGear();
            }}
          >
            <Icon icon={mdiClose} size="18" />
          </IconButton>
        </header>
        <fieldset>
          <legend>{$t('frameleaf_map_date_range')}</legend>
          <div class="presets" role="radiogroup" aria-label={$t('frameleaf_map_date_range')}>
            {#each MAP_DATE_PRESETS as preset (preset)}
              <button
                type="button"
                role="radio"
                aria-checked={$mapSettings.datePreset === preset}
                class:on={$mapSettings.datePreset === preset}
                onclick={() => patchSettings({ datePreset: preset })}
              >
                {presetLabels[preset]}
              </button>
            {/each}
          </div>
          {#if $mapSettings.datePreset === 'custom'}
            <div class="dates">
              <label>
                {$t('frameleaf_map_from')}
                <input
                  type="date"
                  value={$mapSettings.dateAfter}
                  max={$mapSettings.dateBefore || undefined}
                  onchange={(event) => patchSettings({ dateAfter: event.currentTarget.value })}
                />
              </label>
              <label>
                {$t('frameleaf_map_to')}
                <input
                  type="date"
                  value={$mapSettings.dateBefore}
                  min={$mapSettings.dateAfter || undefined}
                  onchange={(event) => patchSettings({ dateBefore: event.currentTarget.value })}
                />
              </label>
            </div>
          {/if}
        </fieldset>
        <fieldset>
          <legend>{$t('frameleaf_map_include')}</legend>
          {#each switches as option (option.key)}
            {@const count =
              option.key === 'includeArchived'
                ? statistics?.archived
                : option.key === 'withPartners'
                  ? statistics?.partner
                  : undefined}
            <button
              type="button"
              role="switch"
              class="switch"
              class:on={$mapSettings[option.key]}
              aria-checked={$mapSettings[option.key]}
              onclick={() => patchSettings({ [option.key]: !$mapSettings[option.key] })}
            >
              <span class="track" aria-hidden="true"></span>
              <span
                >{option.label}{#if count !== undefined}&nbsp;<small>{count.toLocaleString()}</small>{/if}</span
              >
            </button>
          {/each}
        </fieldset>
        <dl class="counts">
          <div>
            <dt>{$t('frameleaf_map_count_located')}</dt>
            <dd>{markers.length}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_map_count_in_view')}</dt>
            <dd>{inView.length}</dd>
          </div>
          {#if statistics}
            <div>
              <dt>{$t('frameleaf_map_count_unlocated')}</dt>
              <dd>{statistics.unlocated}</dd>
            </div>
          {/if}
        </dl>
      </div>
    {/if}

    <output class="sr-only" aria-live="polite">{status}</output>
  </div>

  {#if listOpen}
    <aside class="list" aria-label={$t('frameleaf_map_items_in_view')}>
      <header>
        <strong>{$t('frameleaf_map_count_in_view')}</strong>
        <small>{$t('frameleaf_map_items', { values: { count: inView.length } })}</small>
        <IconButton label={$t('frameleaf_map_hide_list')} onclick={() => patchSettings({ showAssetPanel: false })}>
          <Icon icon={mdiClose} size="18" />
        </IconButton>
      </header>
      {#if inView.length > 0}
        <ul>
          {#each inView as marker (marker.id)}
            {@const detail = markerDetail(marker)}
            {@const place = detail.name ?? (detail.place || $t('frameleaf_map_item'))}
            {@const line = markerRowLine(detail, $t('frameleaf_map_video'))}
            <li>
              <!-- MapView.jsx:806-829: the file name over "day · city · Video", and "Centre map on name". -->
              <button
                type="button"
                class="row"
                onclick={() =>
                  onOpenAsset(
                    marker.id,
                    inView.map(({ id }) => id),
                  )}
              >
                <img src={getAssetMediaUrl({ id: marker.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
                <span>
                  <strong>{place}</strong>
                  <small>{line || `${marker.lat.toFixed(3)}, ${marker.lon.toFixed(3)}`}</small>
                </span>
              </button>
              <button
                type="button"
                class="locate"
                aria-label={$t('frameleaf_map_centre_on', { values: { place } })}
                title={$t('frameleaf_map_centre')}
                onclick={() => locate(marker)}
              >
                <Icon icon={mdiCrosshairsGps} size="16" />
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="list-empty" role="status">{$t('frameleaf_map_list_empty')}</p>
      {/if}
    </aside>
  {/if}

  {#if loaded && markers.length === 0}
    <div class="empty" role="status">
      <Icon icon={mdiMapMarkerOutline} size="30" />
      <!-- MapView.jsx has one empty state for both scopes: the settings sheet narrows an album too. -->
      <strong>{$t('frameleaf_map_empty_title')}</strong>
      <p>{$t('frameleaf_map_empty_help')}</p>
    </div>
  {/if}
</div>

<style>
  .fl-map {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 320px;
    min-width: 0;
    overflow: hidden;
    color: var(--fl-text);
    background: var(--fl-canvas);
    font-size: var(--fl-font-size);
  }
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
  .stage :global(.fl-map-canvas) {
    width: 100%;
    height: 100%;
  }
  .overlay {
    position: absolute;
    z-index: 2;
  }
  .top-left {
    top: 12px;
    left: 12px;
  }
  .top-center {
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 0 12px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
    font-size: var(--fl-font-small);
    font-weight: 500;
  }
  .chip small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 400;
  }
  .tools {
    top: 12px;
    right: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px;
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-1);
  }
  .gear {
    display: contents;
  }
  .legend {
    bottom: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 30px;
    padding: 6px 12px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .dot {
    display: inline-block;
    box-sizing: border-box;
    width: 12px;
    height: 12px;
    border: 2px solid var(--fl-text);
    border-radius: 50%;
    background: var(--fl-raised);
  }
  .switch small {
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .legend-counts {
    padding-left: 12px;
    border-left: 1px solid var(--fl-border);
  }
  .video-dot {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 12px;
    height: 12px;
    border: 2px solid var(--fl-panel);
    border-radius: 50%;
    background: var(--fl-accent);
  }
  .offline {
    position: absolute;
    top: 56px;
    left: 50%;
    z-index: 3;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: min(320px, calc(100% - 32px));
    padding: 18px;
    transform: translateX(-50%);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
    text-align: center;
    color: var(--fl-muted);
  }
  .offline strong {
    color: var(--fl-text);
  }
  .offline p {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .offline-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .dot.small {
    width: 9px;
    height: 9px;
  }
  .dot.large {
    width: 16px;
    height: 16px;
  }

  /* Markers */
  .cluster,
  .single {
    position: relative;
    display: grid;
    place-items: center;
    border: 2px solid var(--fl-text);
    border-radius: 50%;
    box-shadow: 0 2px 6px #0006;
    color: var(--fl-text);
    transition: border-color var(--fl-motion) var(--fl-ease);
  }
  /* MapView.jsx:104-105: the bubble grows with its count up to 40 items (clusterRadius). */
  .cluster {
    width: var(--fl-cluster-size, 38px);
    height: var(--fl-cluster-size, 38px);
    background: var(--fl-raised);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .single {
    width: 42px;
    height: 42px;
    background: var(--fl-panel);
  }
  .single > img {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    object-fit: cover;
  }
  :global(.maplibregl-marker:hover) .cluster,
  :global(.maplibregl-marker:hover) .single,
  :global(.maplibregl-marker:focus-visible) .cluster,
  :global(.maplibregl-marker:focus-visible) .single {
    border-color: var(--fl-accent);
  }
  .card {
    position: absolute;
    bottom: calc(100% + 10px);
    left: 50%;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 10px;
    width: 180px;
    padding: 8px;
    transform: translateX(-50%);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
    color: var(--fl-text);
    text-align: left;
    pointer-events: none;
  }
  .card img,
  .card-empty {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 46px;
    height: 46px;
    border-radius: var(--fl-radius-control);
    object-fit: cover;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .card-copy {
    min-width: 0;
  }
  .card strong,
  .card small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card strong {
    font-size: var(--fl-font-small);
    font-weight: 560;
  }
  .card small {
    margin-top: 3px;
    font-size: var(--fl-font-micro);
    font-weight: 400;
    color: var(--fl-muted);
  }

  /* Settings sheet */
  .settings {
    position: absolute;
    top: 12px;
    right: 76px;
    z-index: 4;
    width: 300px;
    max-width: calc(100% - 88px);
    max-height: calc(100% - 24px);
    overflow: auto;
    padding: 14px 16px 16px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }
  .settings header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
  }
  .settings header strong {
    font-weight: 600;
  }
  .settings fieldset {
    margin: 0 0 6px;
    padding: 10px 0 0;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
  .settings legend {
    padding: 10px 0 8px;
    font-size: var(--fl-font-micro);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  .presets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .presets button {
    min-height: 34px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: transparent;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .presets button.on {
    border-color: transparent;
    background: var(--fl-raised);
    font-weight: 560;
  }
  .dates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 8px;
  }
  .dates label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .dates input {
    min-height: 34px;
    padding: 5px 8px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .switch {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 36px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-small);
    text-align: left;
    cursor: pointer;
  }
  .track {
    position: relative;
    flex-shrink: 0;
    width: 32px;
    height: 18px;
    border-radius: 12px;
    background: var(--fl-border);
    transition: background var(--fl-motion) var(--fl-ease);
  }
  .track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--fl-text);
    transition: transform var(--fl-motion) var(--fl-ease);
  }
  .switch.on .track {
    background: var(--fl-accent);
  }
  .switch.on .track::after {
    transform: translateX(14px);
    background: var(--fl-accent-text);
  }
  .counts {
    display: flex;
    gap: 14px;
    margin: 8px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--fl-border);
  }
  .counts div {
    flex: 1;
  }
  .counts dt {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .counts dd {
    margin: 2px 0 0;
    font-size: 15px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* In-view list */
  .list {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 300px;
    min-height: 0;
    border-left: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .list header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    padding: 10px 10px 10px 16px;
    border-bottom: 1px solid var(--fl-border);
  }
  .list header strong {
    font-weight: 600;
  }
  .list header small {
    flex: 1;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .list ul {
    min-height: 0;
    margin: 0;
    padding: 6px;
    overflow: auto;
    list-style: none;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .row {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 6px;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--fl-raised);
  }
  .row img {
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    border-radius: var(--fl-radius-control);
    object-fit: cover;
    background: var(--fl-raised);
  }
  .row > span {
    min-width: 0;
  }
  .row strong,
  .row small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row strong {
    font-size: var(--fl-font-small);
    font-weight: 540;
  }
  .row small {
    margin-top: 3px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .locate {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: none;
    color: var(--fl-muted);
    cursor: pointer;
  }
  .locate:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .list-empty {
    padding: 24px 16px;
    font-size: var(--fl-font-small);
    line-height: 1.5;
    color: var(--fl-muted);
  }
  .empty {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 3;
    width: min(320px, calc(100% - 32px));
    padding: 22px;
    transform: translate(-50%, -50%);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
    text-align: center;
    color: var(--fl-muted);
  }
  .empty strong {
    display: block;
    margin-top: 10px;
    color: var(--fl-text);
  }
  .empty p {
    margin: 8px 0 0;
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 720px) {
    .fl-map.with-list {
      flex-direction: column;
    }
    .list {
      width: 100%;
      max-height: 45%;
      border-top: 1px solid var(--fl-border);
      border-left: 0;
    }
  }
</style>
