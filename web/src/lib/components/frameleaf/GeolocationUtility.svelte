<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import type MapComponent from '$lib/components/shared-components/map/Map.svelte';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, AssetVisibility, getAssetInfo, searchAssets, type AssetResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let assets = $state<AssetResponseDto[]>([]);
  let nextPage = $state<number | null>(1);
  let loading = $state(false);
  let error = $state(false);
  let latitude = $state<number>();
  let longitude = $state<number>();
  let selected = $state<string[]>([]);
  let query = $state('');
  let account = $state('all');
  let show = $state('open');
  /** `latitude`/`longitude` null: the review removes the location (FL-51). */
  let review = $state<{ ids: string[]; latitude: number | null; longitude: number | null } | null>(null);
  let reviewOpen = $state(false);
  let mapElement = $state<ReturnType<typeof MapComponent>>();
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
      (asset) =>
        selected.includes(asset.id) && owned(asset) && durableBulkTracker.stateOf(asset.id)?.state !== 'pending',
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
        selected = selected.filter((id) => !result.succeeded.includes(id));
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
      <header><strong>{$t('frameleaf_utilities_coordinate_map')}</strong><small>WGS 84</small></header>
      <div class="map">
        {#await import('$lib/components/shared-components/map/Map.svelte') then { default: Map }}
          <Map
            bind:this={mapElement}
            mapMarkers={markers}
            simplified
            clickable
            onClickPoint={({ lat, lng }) => choose(lat, lng)}
          />
        {/await}
      </div>
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
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview })}
            alt={asset.originalFileName}
          />{#if job}<TileJobState {job} label={$t('frameleaf_bulk_tile_processing')} />{/if}
        </div>
        <label
          ><input
            type="checkbox"
            checked={selected.includes(asset.id)}
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
  {#if loading}<p role="status">{$t('loading')}</p>{:else if nextPage !== null}<Button onclick={() => void load()}
      >{$t('load_more')}</Button
    >{/if}
  {#if !loading && assets.length === 0 && !error}<p role="status">{$t('no_assets_to_show')}</p>{/if}
</div>

{#if review}
  <Dialog
    title={review.latitude === null ? $t('frameleaf_utilities_remove_location_title') : $t('change_location')}
    closeLabel={$t('cancel')}
    bind:open={reviewOpen}
  >
    <p>
      {review.latitude === null || review.longitude === null
        ? $t('frameleaf_utilities_remove_location_review', { values: { count: review.ids.length } })
        : $t('frameleaf_utilities_location_review', {
            values: { count: review.ids.length, latitude: review.latitude, longitude: review.longitude },
          })}
    </p>
    <Button variant="primary" disabled={bulk.busy} onclick={() => void apply()}
      >{$t('apply_count', { values: { count: review.ids.length } })}</Button
    >
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
    gap: 0.4375rem;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  input:not([type='checkbox']),
  select {
    width: 100%;
    min-height: 2.125rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.1875rem;
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  input:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--fl-accent);
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
    padding: 0.75rem 0.875rem;
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
  }
</style>
