<script lang="ts">
  /**
   * "Edit date and time" (audit V-23), ported from `DateTimeDialog` in
   * `design/frameleaf/template/src/MediaViewer.jsx:3397-3463` and `.mv-form` (media-viewer.css:1712-1752):
   * a date, a time, a time zone whose first choice keeps the current one, and a line saying what the
   * capture time becomes. Saving writes `dateTimeOriginal` with the zone's offset through
   * `updateAsset`, as the production date modal did; the zone list is the template's common zones
   * followed by every other zone, so no zone the old dialog offered is lost.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { joinDateTime, splitDateTime, timezoneChoices } from '$lib/frameleaf/viewer-date';
  import {
    getModernOffsetForZoneAndDate,
    getPreferredTimeZone,
    getTimezones,
    toIsoDate,
    type ZoneOption,
  } from '$lib/modals/timezone-utils';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    /** The capture time as the panel shows it, in the item's own zone. */
    initialDate?: DateTime;
    initialTimeZone?: string;
    onClose: (saved?: boolean) => void;
    /** The panel reports a failed save next to the row, with the recovery that can work. */
    onError?: (error: unknown) => void;
  }

  const { asset, initialDate, initialTimeZone, onClose, onError }: Props = $props();

  const initial = splitDateTime(initialDate?.toFormat("yyyy-MM-dd'T'HH:mm") ?? null);

  let open = $state(true);
  let saved = false;
  let date = $state(initial.date);
  let time = $state(initial.time || '00:00');
  /** An empty value keeps the current time zone. */
  let zone = $state('');
  let saving = $state(false);

  const choices = timezoneChoices(initialTimeZone);
  const takenAt = $derived(joinDateTime(date, time));

  /** The zone the capture time is written in: the one chosen, or the item's current one. */
  const targetZone = $derived.by((): ZoneOption | undefined => {
    if (!takenAt) {
      return undefined;
    }
    const zones = getTimezones(takenAt);
    if (zone) {
      // The browser's zone list can leave out an alias such as UTC; its offset is still known.
      return (
        zones.find((option) => option.value === zone) ?? {
          value: zone,
          label: zone,
          offsetMinutes: getModernOffsetForZoneAndDate(zone, takenAt).offsetMinutes,
          valid: true,
        }
      );
    }
    return getPreferredTimeZone(initialDate ?? DateTime.now(), initialTimeZone, zones);
  });

  const preview = $derived.by(() => {
    if (!takenAt) {
      return null;
    }
    const wallClock = DateTime.fromISO(takenAt);
    return {
      date: wallClock.toLocaleString(
        { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' },
        { locale: $locale },
      ),
      time: wallClock.toLocaleString({ hour: 'numeric', minute: '2-digit' }, { locale: $locale }),
    };
  });

  $effect(() => {
    if (!open) {
      onClose(saved);
    }
  });

  const save = async () => {
    if (!takenAt || !targetZone) {
      return;
    }
    saving = true;
    try {
      await updateAsset({ id: asset.id, updateAssetDto: { dateTimeOriginal: toIsoDate(takenAt, targetZone) } });
      saved = true;
      open = false;
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_date'));
      onError?.(error);
      open = false;
    } finally {
      saving = false;
    }
  };
</script>

<Dialog bind:open title={$t('edit_date_and_time')} closeLabel={$t('close')}>
  <form
    id="fl-viewer-date-form"
    class="mv-form"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <label>
      {$t('date')}
      <input type="date" bind:value={date} data-initial-focus />
    </label>
    <label>
      {$t('time')}
      <input type="time" bind:value={time} />
    </label>
    <label>
      {$t('frameleaf_info_time_zone')}
      <select bind:value={zone}>
        <option value="">{$t('frameleaf_info_keep_time_zone')}</option>
        {#each choices.common as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
        {#if choices.more.length > 0}
          <optgroup label={$t('frameleaf_info_more_time_zones')}>
            {#each choices.more as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </label>
    <p class="mv-dialog-copy" aria-live="polite">
      {preview
        ? $t('frameleaf_info_capture_time_becomes', { values: { date: preview.date, time: preview.time } })
        : $t('frameleaf_info_enter_valid_date')}
    </p>
  </form>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button
      type="submit"
      form="fl-viewer-date-form"
      class="button primary"
      disabled={!takenAt || !targetZone || saving}
    >
      {$t('save')}
    </button>
  {/snippet}
</Dialog>

<style>
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

  .mv-form input,
  .mv-form select {
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-size);
  }

  .mv-dialog-copy {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.55;
  }
</style>
