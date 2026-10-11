<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import type MapComponent from '$lib/components/shared-components/map/Map.svelte';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, AssetVisibility, getAssetInfo, searchAssets, type AssetResponseDto } from '@frameleaf/sdk';
  import { mdiArrowDown, mdiArrowLeft, mdiArrowRight, mdiArrowUp, mdiMinus, mdiPlus } from '@mdi/js';
  import { Icon } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let assets = $state<AssetResponseDto[]>([]);
  let nextPage = $state<number | null>(1);
  let loading = $state(false);
  let error = $state(false);
  let latitude = $state<number>();
  let longitude = $state<number>();
  let selected = $state<string[]>([]);
  // FL-139: rows look their state up here, not by scanning the selection once per row
  const selectedSet = $derived(new Set(selected));
  let query = $state('');
  let account = $state('all');
  let show = $state('open');
  /** `latitude`/`longitude` null: the review removes the location (FL-51). */
  let review = $state<{ ids: string[]; latitude: number | null; longitude: number | null } | null>(null);
  let reviewOpen = $state(false);
  let mapElement = $state<ReturnType<typeof MapComponent>>();
  /** Bumped when the map view settles, so the "outside this view" hint re-reads the bounds. */
  let viewVersion = $state(0);
  const mapHelpId = $props.id();
  const bulk = new BulkController({ dispatch: () => {} });
  const valid = $derived(
    latitude !== undefined &&
      longitude !== undefined &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180,
  );
  const rows = $derived(
    assets.filter(
      (asset) =>
        (account === 'all' || asset.ownerId === account) &&
        (show === 'all' || !asset.isTrashed) &&
        `${asset.originalFileName} ${ownerName(asset)}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const ownerName = (asset: AssetResponseDto) =>
    asset.ownerId === authManager.user.id
      ? authManager.user.name
      : (asset.owner?.name ?? $t('frameleaf_large_files_other_account'));
  const owners = $derived([...new Map(assets.map((asset) => [asset.ownerId, ownerName(asset)]))]);
  const hasLocation = (asset: AssetResponseDto) =>
    typeof asset.exifInfo?.latitude === 'number' && typeof asset.exifInfo?.longitude === 'number';
  const owned = (asset: AssetResponseDto) => asset.ownerId === authManager.user.id;
  const actionable = $derived(
    rows.filter(
      (asset) => selectedSet.has(asset.id) && owned(asset) && durableBulkTracker.stateOf(asset.id)?.state !== 'pending',
    ),
  );
  const markers = $derived(
    rows
      .filter((asset) => hasLocation(asset))
      .map((asset) => ({
        id: asset.id,
        lat: asset.exifInfo!.latitude!,
        lon: asset.exifInfo!.longitude!,
        city: asset.exifInfo?.city ?? null,
        state: asset.exifInfo?.state ?? null,
        country: asset.exifInfo?.country ?? null,
      })),
  );

  const load = async () => {
    if (nextPage === null || loading) {
      return;
    }
    loading = true;
    error = false;
    try {
      const result = await searchAssets({
        metadataSearchDto: {
          page: nextPage,
          size: 100,
          withExif: true,
          withStacked: true,
          visibility: AssetVisibility.Timeline,
        },
      });
      const present = new Set(assets.map((asset) => asset.id));
      assets = [...assets, ...result.assets.items.filter((asset) => !present.has(asset.id))];
      nextPage = result.assets.nextPage === null ? null : Number(result.assets.nextPage);
    } catch {
      error = true;
    } finally {
      loading = false;
    }
  };
  onMount(() => {
    void load();
  });
  $effect(() => {
    if (valid) {
      mapElement?.addClipMapMarker(longitude!, latitude!);
    }
  });

  const choose = (lat: number, lng: number) => {
    latitude = lat;
    longitude = lng;
  };

  type Direction = 'north' | 'south' | 'east' | 'west';
  const offsets: Record<Direction, [number, number]> = {
    north: [1, 0],
    south: [-1, 0],
    west: [0, -1],
    east: [0, 1],
  };
  const clamp = (value: number, limit: number) => Number(Math.max(-limit, Math.min(limit, value)).toFixed(6));
  /**
   * Nudge the selected point (UtilityMapPicker.jsx:47-57, 109-123): from the current point, or the
   * map centre before one is chosen; Shift moves ten times farther.
   */
  const move = (direction: Direction, large = false) => {
    const start = valid ? { lat: latitude!, lng: longitude! } : (mapElement?.getCenter() ?? { lat: 0, lng: 0 });
    const step = large ? 0.01 : 0.001;
    const [north, east] = offsets[direction];
    choose(clamp(start.lat + north * step, 90), clamp(start.lng + east * step, 180));
  };
  const arrowDirections: Record<string, Direction> = {
    ArrowUp: 'north',
    ArrowDown: 'south',
    ArrowLeft: 'west',
    ArrowRight: 'east',
  };
  const onMapKeydown = (event: KeyboardEvent) => {
    const direction = arrowDirections[event.key];
    if (direction && event.target === event.currentTarget) {
      event.preventDefault();
      move(direction, event.shiftKey);
    }
  };
  const outsideView = $derived(
    viewVersion >= 0 && valid && mapElement ? !mapElement.contains(longitude!, latitude!) : false,
  );
  const toggle = (asset: AssetResponseDto) => {
    if (!owned(asset) || durableBulkTracker.stateOf(asset.id)?.state === 'pending') {
      return;
    }
    selected = selected.includes(asset.id) ? selected.filter((id) => id !== asset.id) : [...selected, asset.id];
  };
  const ask = () => {
    if (!valid || bulk.busy) {
      return;
    }
    const ids = actionable.map((asset) => asset.id);
    if (ids.length === 0) {
      return;
    }
    review = { ids, latitude: latitude!, longitude: longitude! };
    reviewOpen = true;
  };
  /**
   * FL-51: "Remove location" clears the selected items' coordinates (and the place names read from
   * them). It goes through the same review, bulk run and per-item results as Apply location.
   */
  const locatedActionable = $derived(actionable.filter((asset) => hasLocation(asset)));
  const askRemove = () => {
    if (bulk.busy || locatedActionable.length === 0) {
      return;
    }
    review = { ids: locatedActionable.map((asset) => asset.id), latitude: null, longitude: null };
    reviewOpen = true;
  };
  const apply = async () => {
    if (!review || bulk.busy) {
      return;
    }
    const frozen = review;
    error = false;
    try {
      const result = await bulk.run(
        'change-location',
        frozen.ids,
        frozen.latitude === null || frozen.longitude === null
          ? { clearLocation: true }
          : { latitude: frozen.latitude, longitude: frozen.longitude },
      );
      if (result) {
        const refreshed = await Promise.all(result.succeeded.map((id) => getAssetInfo({ ...authManager.params, id })));
        const byId = new Map(refreshed.map((asset) => [asset.id, asset]));
        assets = assets.map((asset) => byId.get(asset.id) ?? asset);
        const succeeded = new Set(result.succeeded);
        selected = selected.filter((id) => !succeeded.has(id));
      } else {
        selected = [];
      }
      reviewOpen = false;
    } catch {
      error = true;
    }
  };
</script>

<div class="location-tool">
  <div class="toolbar">
    <label
      >{$t('account')}<select bind:value={account} onchange={() => (selected = [])}>
        <option value="all">{$t('frameleaf_large_files_all_accounts')}</option>
        {#each owners as [id, name] (id)}<option value={id}>{name}</option>{/each}
      </select></label
    >
    <label
      >{$t('frameleaf_utilities_find_items')}<input
        type="search"
        bind:value={query}
        placeholder={$t('filename')}
      /></label
    >
    <label
      >{$t('frameleaf_large_files_show')}<select bind:value={show} onchange={() => (selected = [])}>
        <option value="open">{$t('frameleaf_large_files_show_open')}</option>
        <option value="all">{$t('frameleaf_large_files_show_all')}</option>
      </select></label
    >
  </div>
  {#if error}<p role="alert">
      {$t('errors.something_went_wrong')}
      <Button onclick={() => void load()}>{$t('retry')}</Button>
    </p>{/if}
  <div class="location">
    <div class="map-picker">
      <header>
        <div><strong>{$t('frameleaf_utilities_coordinate_map')}</strong><small>WGS 84</small></div>
        <!-- UtilityMapPicker.jsx:89-98: the picker's own zoom buttons replace the map's built-in ones. -->
        <div class="map-buttons">
          <Button label={$t('zoom_out')} onclick={() => mapElement?.zoomOut()}
            ><Icon icon={mdiMinus} size="1rem" aria-hidden={true} /></Button
          >
          <Button label={$t('zoom_in')} onclick={() => mapElement?.zoomIn()}
            ><Icon icon={mdiPlus} size="1rem" aria-hidden={true} /></Button
          >
        </div>
      </header>
      <!-- UtilityMapPicker.jsx:100-123: the focusable map surface; arrow keys nudge the selected point. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="map"
        role="group"
        tabindex="0"
        aria-label={$t('frameleaf_utilities_map_label')}
        aria-describedby={mapHelpId}
        onkeydown={onMapKeydown}
      >
        {#await import('$lib/components/shared-components/map/Map.svelte') then { default: Map }}
          <Map
            bind:this={mapElement}
            mapMarkers={markers}
            simplified
            clickable
            showSimpleControls={false}
            onViewChange={() => viewVersion++}
            onClickPoint={({ lat, lng }) => choose(lat, lng)}
          />
        {/await}
      </div>
      <!-- UtilityMapPicker.jsx:219-259: direction buttons, centre, the outside-view hint and help. -->
      <div class="map-controls">
        <div role="group" aria-label={$t('frameleaf_utilities_move_location')}>
          <Button label={$t('frameleaf_utilities_move_west')} onclick={() => move('west')}
            ><Icon icon={mdiArrowLeft} size="1rem" aria-hidden={true} /></Button
          >
          <Button label={$t('frameleaf_utilities_move_north')} onclick={() => move('north')}
            ><Icon icon={mdiArrowUp} size="1rem" aria-hidden={true} /></Button
          >
          <Button label={$t('frameleaf_utilities_move_south')} onclick={() => move('south')}
            ><Icon icon={mdiArrowDown} size="1rem" aria-hidden={true} /></Button
          >
          <Button label={$t('frameleaf_utilities_move_east')} onclick={() => move('east')}
            ><Icon icon={mdiArrowRight} size="1rem" aria-hidden={true} /></Button
          >
        </div>
        <Button disabled={!valid} onclick={() => valid && mapElement?.centerOn(longitude!, latitude!)}
          >{$t('frameleaf_utilities_center_on_selection')}</Button
        >
      </div>
      {#if outsideView}<p class="map-note">{$t('frameleaf_utilities_outside_view')}</p>{/if}
      <p class="map-note" id={mapHelpId}>{$t('frameleaf_utilities_map_help')}</p>
    </div>
    <div class="coordinates">
      <label>{$t('latitude')}<input type="number" min="-90" max="90" step="any" bind:value={latitude} /></label>
      <label>{$t('longitude')}<input type="number" min="-180" max="180" step="any" bind:value={longitude} /></label>
      <div class="coordinate-actions">
        <Button variant="primary" disabled={!valid || actionable.length === 0 || bulk.busy} onclick={ask}
          >{$t('frameleaf_utilities_apply_location', { values: { count: actionable.length } })}</Button
        >
        <Button disabled={locatedActionable.length === 0 || bulk.busy} onclick={askRemove}
          >{$t('frameleaf_utilities_remove_location', { values: { count: locatedActionable.length } })}</Button
        >
      </div>
    </div>
  </div>
  <div class="photo-grid">
    {#each rows as asset (asset.id)}
      {@const job = durableBulkTracker.stateOf(asset.id)}
      <article>
        <div class="image">
          <img
            loading="lazy"
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview })}
            alt={asset.originalFileName}
          />{#if job}<TileJobState {job} label={$t('frameleaf_bulk_tile_processing')} />{/if}
        </div>
        <label
          ><input
            type="checkbox"
            checked={selectedSet.has(asset.id)}
            disabled={!owned(asset) || job?.state === 'pending'}
            onchange={() => toggle(asset)}
          />{asset.originalFileName}</label
        >
        <small
          >{ownerName(asset)} · {hasLocation(asset)
            ? `${asset.exifInfo!.latitude!.toFixed(4)}, ${asset.exifInfo!.longitude!.toFixed(4)}`
            : $t('frameleaf_utilities_no_location')}</small
        >
        <div class="photo-action">
          <Button
            disabled={!hasLocation(asset)}
            onclick={() => choose(asset.exifInfo!.latitude!, asset.exifInfo!.longitude!)}
            >{$t('frameleaf_utilities_use_location')}</Button
          >
        </div>
      </article>
    {/each}
  </div>
  {#if loading}<div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="3rem" />
    </div>{:else if nextPage !== null}<Button onclick={() => void load()}>{$t('load_more')}</Button>{/if}
  {#if !loading && assets.length === 0 && !error}<p role="status">{$t('no_assets_to_show')}</p>{/if}
</div>

{#if review}
  {@const frozen = review}
  {@const removing = frozen.latitude === null || frozen.longitude === null}
  <!-- UtilitiesManager.jsx:963-1050: the fixed set, one "owner · old → new" row per item, Confirm n items. -->
  <Dialog
    title={removing
      ? $t('frameleaf_utilities_remove_location_title')
      : $t('frameleaf_utilities_update_locations_title')}
    closeLabel={$t('cancel')}
    wide
    bind:open={reviewOpen}
  >
    <p>{$t('library_care_review_fixed')}</p>
    <div class="review-rows">
      {#each frozen.ids as id (id)}
        {@const item = assets.find((asset) => asset.id === id)}
        {#if item}
          <div>
            <strong>{item.originalFileName}</strong>
            <span
              >{$t('frameleaf_utilities_location_change_row', {
                values: {
                  owner: ownerName(item),
                  from: hasLocation(item)
                    ? `${item.exifInfo!.latitude}, ${item.exifInfo!.longitude}`
                    : $t('frameleaf_utilities_no_location'),
                  to: removing ? $t('frameleaf_utilities_no_location') : `${frozen.latitude}, ${frozen.longitude}`,
                },
              })}</span
            >
          </div>
        {/if}
      {/each}
    </div>
    <p>
      {removing
        ? $t('frameleaf_utilities_remove_location_review', { values: { count: frozen.ids.length } })
        : $t('library_care_retained_policy')}
    </p>
    {#snippet actions()}
      <Button onclick={() => (reviewOpen = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={bulk.busy} onclick={() => void apply()}
        >{$t('frameleaf_large_files_review_confirm', { values: { count: frozen.ids.length } })}</Button
      >
    {/snippet}
  </Dialog>
{/if}

<style>
  .toolbar {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  input:not([type='checkbox']),
  select {
    width: 100%;
    min-height: 2.125rem;
    padding: 0.5rem var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: 0.1875rem;
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  input:focus-visible,
  select:focus-visible {
    outline: var(--fl-focus-ring);
  }
  .location {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
    margin: 0.75rem 0 1.5rem;
  }
  .location > div {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: 0.25rem;
  }
  .coordinates {
    padding: 1.375rem;
  }
  .coordinates label {
    margin-bottom: 0.8125rem;
  }
  .coordinate-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .map-picker {
    overflow: hidden;
    min-width: 0;
  }
  .map-picker header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem;
  }
  .map-buttons,
  .map-controls,
  .map-controls > div {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .map-controls {
    justify-content: space-between;
    padding: 0.625rem 0.875rem 0;
  }
  .map:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-inset);
  }
  .map-note {
    margin: 0;
    padding: 0.5rem 0.875rem 0;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  .map-note:last-child {
    padding-bottom: 0.75rem;
  }
  .review-rows {
    display: grid;
    gap: 0.5rem;
    max-height: 14rem;
    overflow-y: auto;
    margin: 0.75rem 0;
  }
  .review-rows > div {
    display: grid;
    gap: 0.125rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    font-size: 0.8125rem;
  }
  .review-rows span {
    color: var(--fl-muted);
  }
  .map-picker strong {
    display: block;
    font-size: 0.75rem;
  }
  .map-picker small {
    display: block;
    color: var(--fl-muted);
    font-size: 0.625rem;
  }
  .map {
    height: 17.1875rem;
    position: relative;
  }
  .photo-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.875rem;
    margin-bottom: 1rem;
  }
  article {
    padding-bottom: 0.9375rem;
    border: 1px solid var(--fl-border);
    background: var(--fl-panel);
    overflow: hidden;
  }
  .image {
    position: relative;
  }
  .image img {
    display: block;
    width: 100%;
    aspect-ratio: 1.5;
    object-fit: cover;
  }
  article > label {
    flex-direction: row;
    align-items: center;
    padding: 0.8125rem 0.75rem 0.4375rem;
    color: var(--fl-text);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  article small {
    display: block;
    margin: 0 0.75rem 0.8125rem;
    color: var(--fl-muted);
    font-size: 0.625rem;
  }
  .photo-action {
    margin: 0 0.75rem;
    font-size: 0.6875rem;
  }
  @media (max-width: 68.75rem) {
    .photo-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 43.75rem) {
    .location,
    .photo-grid {
      grid-template-columns: 1fr;
    }
    /* Three fields in one row cut their own text off on a phone; they wrap instead. */
    .toolbar {
      flex-wrap: wrap;
    }
    .toolbar label {
      flex: 1 1 9rem;
    }
  }
</style>
