<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { t } from 'svelte-i18n';

  /**
   * Change location. The prototype offered city, state and country fields as well, but the bulk
   * update endpoint takes coordinates only and the server reverse-geocodes the place name from
   * them. Writing a place name the coordinates disagree with would be a lie about the photo, so
   * this dialog asks for the coordinates and says where the place name comes from.
   */
  let {
    count,
    initialLatitude,
    initialLongitude,
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    initialLatitude?: number;
    initialLongitude?: number;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  let latitude = $state(Number.isFinite(initialLatitude) ? String(initialLatitude) : '');
  let longitude = $state(Number.isFinite(initialLongitude) ? String(initialLongitude) : '');

  const asNumber = (value: string) => (value.trim() === '' ? NaN : Number(value));
  let lat = $derived(asNumber(latitude));
  let lng = $derived(asNumber(longitude));
  let error = $derived(
    Number.isNaN(lat) || Math.abs(lat) > 90
      ? $t('frameleaf_bulk_location_latitude_range')
      : Number.isNaN(lng) || Math.abs(lng) > 180
        ? $t('frameleaf_bulk_location_longitude_range')
        : '',
  );
  let valid = $derived(error === '');
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_change_location')}
  submitLabel={$t('frameleaf_bulk_apply_to', { values: { count } })}
  {valid}
  preview={error || $t('frameleaf_bulk_location_geocoded', { values: { count } })}
  onSubmit={() => onSubmit({ latitude: lat, longitude: lng })}
>
  <div class="fl-grid">
    <label>
      {$t('latitude')}
      <input inputmode="decimal" placeholder="51.4254" bind:value={latitude} aria-invalid={!valid} required />
    </label>
    <label>
      {$t('longitude')}
      <input inputmode="decimal" placeholder="-116.1773" bind:value={longitude} aria-invalid={!valid} required />
    </label>
  </div>
</BulkFormDialog>
