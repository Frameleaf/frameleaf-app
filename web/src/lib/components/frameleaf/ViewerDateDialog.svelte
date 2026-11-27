<script lang="ts">
  /**
   * "Edit date and time" (audit V-23), ported from `DateTimeDialog` in
   * `design/frameleaf/template/src/MediaViewer.jsx:3397-3463` and `.mv-form` (media-viewer.css:1712-1752):
   * a date, a time, a time zone whose first choice keeps the current one, and a line saying what the
   * capture time becomes. Saving writes `dateTimeOriginal` with the zone's offset and the zone by name
   * through the bulk update (LIB-02: an offset alone kept the old zone, and a zone with the same offset
   * saved nothing); the zone list is the template's common zones
   * followed by every other zone, so no zone the old dialog offered is lost.
   *
   * FL-1814: the date is the one date field, which asks how sure you are first (the exact day, month and year,
   * year only, around a year; a decade stored before is shown as it is). Anything but the exact day saves the
   * start of its period in UTC with `dateAccuracy` and `dateDetail`; an exact day saves with its time and zone,
   * which makes the date exact again.
   */
  import DateField, { dateFieldStart, isDateFieldValid } from '$lib/components/frameleaf/DateField.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { toSdkDateAccuracy } from '$lib/frameleaf/approximate-date';
  import { photoDateField, photoDateUpdate } from '$lib/frameleaf/date-field';
  import { formatLuxon } from '$lib/frameleaf/date-format';
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
  import { updateAssets, type AssetResponseDto, type DateDetail } from '@frameleaf/sdk';
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
  /** What the field holds; an approximate date opens as it is stored. */
  let field = $state({
    ...photoDateField(
      asset.dateAccuracy ? asset.localDateTime : initialDate?.toISODate(),
      asset.dateAccuracy,
      asset.dateDetail,
    ),
    time: initial.time || '00:00',
  });
  const date = $derived(field.sure === 'day' && isDateFieldValid(field) ? dateFieldStart(field) : '');
  const time = $derived(field.time ?? '00:00');
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
      date: formatLuxon(wallClock, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }, $locale),
      time: formatLuxon(wallClock, { hour: 'numeric', minute: '2-digit' }, $locale),
    };
  });

  $effect(() => {
    if (!open) {
      onClose(saved);
    }
  });

  const saveApproximate = async () => {
    const { dateTimeOriginal, dateAccuracy, dateDetail } = photoDateUpdate(field);
    saving = true;
    try {
      await updateAssets({
        assetBulkUpdateDto: {
          ids: [asset.id],
          dateTimeOriginal,
          dateAccuracy: toSdkDateAccuracy(dateAccuracy),
          dateDetail: dateDetail as DateDetail | null,
        },
      });
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

  const save = async () => {
    if (field.sure !== 'day') {
      if (isDateFieldValid(field)) {
        await saveApproximate();
      }
      return;
    }
    if (!takenAt || !targetZone) {
      return;
    }
    saving = true;
    try {
      await updateAssets({
        assetBulkUpdateDto: {
          ids: [asset.id],
          dateTimeOriginal: toIsoDate(takenAt, targetZone),
          // keeping the zone keeps its name, even one the browser's list has no entry for
          timeZone: zone || initialTimeZone || targetZone.value,
        },
      });
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
    <DateField label={$t('edit_date_and_time')} withTime value={field} onChange={(value) => (field = value)} />
    {#if field.sure === 'day'}
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
    {/if}
  </form>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button
      type="submit"
      form="fl-viewer-date-form"
      class="button primary"
      disabled={(field.sure === 'day' ? !takenAt || !targetZone : !isDateFieldValid(field)) || saving}
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
