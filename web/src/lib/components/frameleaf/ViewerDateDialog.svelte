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
   * FL-936: Exact date / Year / Decade at the top. A year or a decade saves the start of that period in UTC
   * with `dateAccuracy`; an exact date saves as before, which makes the date exact again.
   */
  import DatePrecisionChoice from '$lib/components/frameleaf/DatePrecisionChoice.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    dateAccuracyOf,
    decadeChoices,
    decadeOf,
    MIN_APPROXIMATE_YEAR,
    parseApproximateYear,
    periodStartIso,
    type DatePrecision,
    toSdkDateAccuracy,
  } from '$lib/frameleaf/approximate-date';
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
  import { updateAssets, type AssetResponseDto } from '@frameleaf/sdk';
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

  const currentYear = new Date().getFullYear();
  const decades = decadeChoices(currentYear);
  /** The year the photo is dated to now: the start of its period when only a year or a decade is known. */
  const startYear = Number(asset.localDateTime?.slice(0, 4)) || initialDate?.year || currentYear;
  const knownYear = Math.min(Math.max(startYear, MIN_APPROXIMATE_YEAR), currentYear);
  let precision = $state<DatePrecision>(dateAccuracyOf(asset.dateAccuracy) ?? 'exact');
  let yearText = $state(String(knownYear));
  let decade = $state(String(decadeOf(knownYear)));
  const year = $derived(parseApproximateYear(yearText, currentYear));
  /** The first year of the chosen period, or null while the year typed is not one. */
  const periodYear = $derived(precision === 'year' ? year : precision === 'decade' ? Number(decade) : null);
  const approximateCopy = $derived.by(() => {
    if (precision === 'decade') {
      return $t('frameleaf_date_will_show_decade', { values: { decade } });
    }
    if (year !== null) {
      return $t('frameleaf_date_will_show_year', { values: { year: String(year) } });
    }
    return /^\d{4}$/.test(yearText.trim())
      ? $t('frameleaf_date_year_range', {
          values: { min: String(MIN_APPROXIMATE_YEAR), max: String(currentYear) },
        })
      : $t('frameleaf_date_enter_year');
  });

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

  const saveApproximate = async (accuracy: 'year' | 'decade', start: number) => {
    saving = true;
    try {
      await updateAssets({
        assetBulkUpdateDto: {
          ids: [asset.id],
          dateTimeOriginal: periodStartIso(start, accuracy),
          dateAccuracy: toSdkDateAccuracy(accuracy),
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
    if (precision !== 'exact') {
      if (periodYear !== null) {
        await saveApproximate(precision, periodYear);
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
    <div class="mv-precision">
      <DatePrecisionChoice value={precision} onChange={(value) => (precision = value)} />
    </div>
    {#if precision === 'exact'}
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
    {:else}
      {#if precision === 'year'}
        <label>
          {$t('frameleaf_date_precision_year')}
          <input
            type="text"
            inputmode="numeric"
            maxlength="4"
            placeholder="1975"
            bind:value={yearText}
            aria-invalid={year === null}
            aria-describedby="fl-viewer-date-approximate"
            data-initial-focus
          />
        </label>
      {:else}
        <label>
          {$t('frameleaf_date_precision_decade')}
          <select bind:value={decade} aria-describedby="fl-viewer-date-approximate" data-initial-focus>
            {#each decades as option (option)}
              <option value={String(option)}>
                {$t('frameleaf_date_decade_option', { values: { decade: String(option) } })}
              </option>
            {/each}
          </select>
        </label>
      {/if}
      <p id="fl-viewer-date-approximate" class="mv-dialog-copy is-approximate" aria-live="polite">
        {approximateCopy}
      </p>
    {/if}
  </form>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button
      type="submit"
      form="fl-viewer-date-form"
      class="button primary"
      disabled={(precision === 'exact' ? !takenAt || !targetZone : periodYear === null) || saving}
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

  .mv-precision {
    margin-bottom: 20px;
  }

  .mv-dialog-copy.is-approximate {
    margin-top: 8px;
  }

  .mv-dialog-copy {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.55;
  }
</style>
