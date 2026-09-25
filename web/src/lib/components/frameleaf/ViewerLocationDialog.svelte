<script lang="ts">
  /**
   * "Edit location" (audit V-24), ported from `LocationDialog` and `PinMap` in
   * `design/frameleaf/template/src/MediaViewer.jsx:3464-3693` and `.mv-form`, `.mv-location-grid`
   * (media-viewer.css:1712-1760): City, State or region and Country, the coordinates, and a map to
   * place the pin by clicking, or with the arrow keys (Shift for larger steps).
   *
   * The map is the production MapLibre map rather than the template's drawn one (the recorded "MapLibre
   * kept" deviation of the Map screen). Saving writes the coordinates and any place name the owner
   * changed through `updateAsset`; a typed place name is kept over reverse geocoding, and moving the
   * pin without touching the place lets geocoding name the new spot.
   *
   * Remove location (owner decision, FL-146, 2026-09-25): "Remove location", or emptying both
   * coordinates as the template allows, sends null coordinates (FL-51). The server clears the
   * coordinates and place names of the item and of its Live Photo video, rewrites their metadata
   * files and keeps the removal locked. It is confirmed first with the Frameleaf danger confirmation,
   * the prototype's pattern for destructive changes (MediaViewer.jsx:1866-1890).
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type Map from '$lib/components/shared-components/map/Map.svelte';
  import { timeToLoadTheMap } from '$lib/constants';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { isLocationRemoval, locationDraft, locationPatch, parseCoordinate } from '$lib/frameleaf/viewer-location';
  import { geolocationManager } from '$lib/managers/geolocation.manager.svelte';
  import { delay } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { LoadingSpinner } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    onClose: (updated?: AssetResponseDto) => void;
    /** The panel reports a failed save next to the row, with the recovery that can work. */
    onError?: (error: unknown, patch: ReturnType<typeof locationPatch>) => void;
  }

  const { asset, onClose, onError }: Props = $props();

  const initial = locationDraft(asset.exifInfo);
  const hintId = $props.id();

  let open = $state(true);
  let updated: AssetResponseDto | undefined;
  let city = $state(initial.city);
  let region = $state(initial.state);
  let country = $state(initial.country);
  let latitude = $state(initial.latitude);
  let longitude = $state(initial.longitude);
  let saving = $state(false);
  let mapElement = $state<ReturnType<typeof Map>>();

  const lat = $derived(parseCoordinate(latitude, 90));
  const lon = $derived(parseCoordinate(longitude, 180));
  const patch = $derived(locationPatch(initial, { city, state: region, country, latitude, longitude }));
  const invalid = $derived(patch === 'invalid');

  const startPoint = initial.latitude
    ? { lat: Number(initial.latitude), lng: Number(initial.longitude) }
    : geolocationManager.lastPoint;

  $effect(() => {
    if (!open) {
      onClose(updated);
    }
  });

  const place = (nextLat: number, nextLon: number) => {
    latitude = String(Number(nextLat.toFixed(5)));
    longitude = String(Number(nextLon.toFixed(5)));
    mapElement?.addClipMapMarker(Number(longitude), Number(latitude));
  };

  // PinMap's arrow keys (MediaViewer.jsx:3525-3534): a small nudge, or a larger one with Shift.
  const nudge = (event: KeyboardEvent) => {
    const size = event.shiftKey ? 0.05 : 0.005;
    const baseLat = lat ?? startPoint?.lat ?? 0;
    const baseLon = lon ?? startPoint?.lng ?? 0;
    const moves: Record<string, [number, number]> = {
      ArrowUp: [size, 0],
      ArrowDown: [-size, 0],
      ArrowLeft: [0, -size],
      ArrowRight: [0, size],
    };
    const move = moves[event.key];
    if (!move) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    place(Math.max(-90, Math.min(90, baseLat + move[0])), Math.max(-180, Math.min(180, baseLon + move[1])));
  };

  /** Removing a location cannot be undone here: the owner confirms it, and Keep returns to the dialog. */
  const confirmRemoval = () =>
    confirmFrameleaf({
      title: $t('frameleaf_info_remove_location_title'),
      prompt: asset.livePhotoVideoId
        ? $t('frameleaf_info_remove_location_prompt_live')
        : $t('frameleaf_info_remove_location_prompt'),
      confirmText: $t('frameleaf_info_remove_location'),
      cancelText: $t('frameleaf_viewer_delete_keep'),
      danger: true,
    });

  /**
   * "Remove location" asks first and only then empties the coordinates, so Keep leaves every field
   * exactly as it was.
   */
  const removeLocation = async () => {
    if (saving || !(await confirmRemoval())) {
      return;
    }
    latitude = '';
    longitude = '';
    await save({ confirmed: true });
  };

  const save = async ({ confirmed = false } = {}) => {
    if (patch === 'invalid' || saving) {
      return;
    }
    if (!patch) {
      open = false;
      return;
    }
    if (isLocationRemoval(patch) && !confirmed && !(await confirmRemoval())) {
      return;
    }
    saving = true;
    try {
      updated = await updateAsset({ id: asset.id, updateAssetDto: patch });
      // A removal sends null coordinates; only a real point becomes the next dialog's starting point.
      if (typeof patch.latitude === 'number' && typeof patch.longitude === 'number') {
        geolocationManager.onSelected({ lat: patch.latitude, lng: patch.longitude });
      }
      open = false;
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_location'));
      onError?.(error, patch);
      open = false;
    } finally {
      saving = false;
    }
  };
</script>

<Dialog bind:open title={$t('edit_location')} closeLabel={$t('close')} wide>
  <form
    id="fl-viewer-location-form"
    class="mv-location-grid"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <div class="mv-form">
      <label>
        {$t('city')}
        <input bind:value={city} data-initial-focus autocomplete="off" />
      </label>
      <label>
        {$t('frameleaf_info_state_or_region')}
        <input bind:value={region} autocomplete="off" />
      </label>
      <label>
        {$t('country')}
        <input bind:value={country} autocomplete="off" />
      </label>
      <div class="mv-form-row">
        <label>
          {$t('latitude')}
          <input inputmode="decimal" bind:value={latitude} aria-invalid={latitude.trim() !== '' && lat === null} />
        </label>
        <label>
          {$t('longitude')}
          <input inputmode="decimal" bind:value={longitude} aria-invalid={longitude.trim() !== '' && lon === null} />
        </label>
      </div>
      {#if invalid}
        <p class="mv-form-error" role="alert">
          {$t('frameleaf_info_coordinates_invalid')}
        </p>
      {/if}
    </div>
    <div class="mv-map-wrap">
      <!-- The pin map is an application widget: arrow keys move the pin (UtilityMapPicker.jsx:48-57). -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="mv-map fl-continuous-corners"
        role="application"
        tabindex="0"
        aria-label={lat !== null && lon !== null
          ? $t('frameleaf_info_map_pin_at', { values: { latitude: lat.toFixed(4), longitude: lon.toFixed(4) } })
          : $t('frameleaf_info_map_no_pin')}
        aria-describedby={hintId}
        onkeydown={nudge}
      >
        {#await import('$lib/components/shared-components/map/Map.svelte')}
          {#await delay(timeToLoadTheMap) then}
            <div class="flex size-full items-center justify-center">
              <LoadingSpinner />
            </div>
          {/await}
        {:then { default: MapComponent }}
          <MapComponent
            bind:this={mapElement}
            mapMarkers={initial.latitude
              ? [
                  {
                    id: asset.id,
                    lat: Number(initial.latitude),
                    lon: Number(initial.longitude),
                    city: asset.exifInfo?.city ?? null,
                    state: asset.exifInfo?.state ?? null,
                    country: asset.exifInfo?.country ?? null,
                  },
                ]
              : []}
            zoom={initial.latitude ? 12.5 : 1}
            center={startPoint}
            simplified
            clickable
            onClickPoint={(point) => place(point.lat, point.lng)}
            rounded
          />
        {/await}
      </div>
      <small id={hintId}>{$t('frameleaf_info_map_hint')}</small>
    </div>
  </form>
  {#snippet actions()}
    {#if initial.latitude}
      <button type="button" class="button remove" disabled={saving} onclick={() => void removeLocation()}>
        {$t('frameleaf_info_remove_location')}
      </button>
    {/if}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="submit" form="fl-viewer-location-form" class="button primary" disabled={invalid || saving}>
      {$t('save')}
    </button>
  {/snippet}
</Dialog>

<style>
  /* A secondary destructive action sits apart at the start of the footer, in the danger colour; its
     confirmation carries the filled danger button (ConfirmDialog, the prototype's .button.danger). */
  .remove {
    margin-inline-end: auto;
    color: var(--fl-danger);
  }

  .mv-location-grid {
    display: grid;
    grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
    gap: 22px;
    align-items: start;
  }

  .mv-form {
    display: grid;
    gap: 4px;
  }

  .mv-form label {
    display: grid;
    gap: 6px;
    margin: 0 0 12px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }

  .mv-form input {
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-size);
  }

  .mv-form input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }

  .mv-form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .mv-form-error {
    margin: 0 0 8px;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }

  .mv-map-wrap {
    display: grid;
    gap: 8px;
  }

  .mv-map {
    height: 300px;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }

  .mv-map:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }

  .mv-map-wrap small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }

  @supports (corner-shape: squircle) {
    .mv-map {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }

  @media (max-width: 700px) {
    .mv-location-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
