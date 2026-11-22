<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import DatePrecisionChoice from '$lib/components/frameleaf/DatePrecisionChoice.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import type { ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import type { BulkAsset } from '$lib/frameleaf/bulk-actions';
  import {
    dateAccuracyOf,
    decadeChoices,
    decadeOf,
    MIN_APPROXIMATE_YEAR,
    parseApproximateYear,
    type DatePrecision,
  } from '$lib/frameleaf/approximate-date';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import {
    splitLocalDateTime,
    timeZoneChoices,
    wallTimeInZone,
    zoneForOffset,
    type CaptureTime,
  } from '$lib/frameleaf/time-zones';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * Change date, ported from the prototype's `ChangeDateDialog` (`SelectionBar.jsx`). Both modes bind
   * to the one bulk update endpoint: "set the same date" and "shift all by" (`dateTimeRelative` in
   * minutes, which keeps each item's spacing).
   *
   * As in the prototype the dialog opens on the first selected item's own date and time, and the
   * time zone list names places ("Vancouver (Pacific Time · UTC−07:00)") rather than raw IANA ids.
   * Every zone the browser knows is offered, so the list is searchable (the Frameleaf `Picker`), and
   * each offset is the one the chosen date has in that zone.
   *
   * The time sent always carries an offset, so nothing is read as UTC by accident: a chosen zone
   * sends the wall time at that zone's offset (as the upstream date dialog does), and "Keep each
   * item's time zone" sets the wall time in each item's own zone: its IANA zone where its metadata
   * names one (the offset read for the new date), else its current offset. Keeping needs every
   * item's real capture time, so it is offered only when the whole selection is loaded and known.
   *
   * In an Added-date view (Recently added, "Added — newest") the timeline's dates are upload times,
   * so nothing is pre-filled from them: the real capture times are fetched on open, and if they
   * cannot be, "keep" is not offered, nothing is pre-filled and a zone must be chosen.
   *
   * FL-936: under "Set the same date", Exact date / Year / Decade. A year or a decade runs as one Date & Time Doctor
   * fix, so one Undo puts every item's date back.
   */
  let {
    count,
    /** The selected items, when every one of them is loaded; empty for a "select all matching" set. */
    assets = [],
    /**
     * The items' real capture times, fetched on open (review N1/N3): the zone each item keeps, and
     * the only honest pre-fill where the timeline's dates are upload times (an Added-date view).
     * Resolves null when they cannot be read.
     */
    resolveCaptureTimes,
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    assets?: BulkAsset[];
    resolveCaptureTimes?: (ids: string[]) => Promise<Record<string, CaptureTime> | null>;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  const MINUTES_PER_UNIT = { minutes: 1, hours: 60, days: 1440 };
  const KEEP = 'keep';

  const loaded = assets.length > 0 && assets.length === count;
  /** What the timeline itself knows: a capture time only where its dates are capture dates. */
  const fromTimeline: Record<string, CaptureTime> = Object.fromEntries(
    assets
      .filter((asset) => asset.localDateTime && Number.isFinite(asset.utcOffsetMinutes))
      .map((asset) => [
        asset.id,
        { localDateTime: asset.localDateTime as string, offsetMinutes: asset.utcOffsetMinutes as number },
      ]),
  );
  let fetched = $state<Record<string, CaptureTime> | null>(null);
  let resolving = $state(false);
  const captures = $derived<Record<string, CaptureTime>>({ ...fromTimeline, ...fetched });
  /** Every selected item's capture time is known, so "Keep each item's time zone" can keep it. */
  const canKeep = $derived(loaded && assets.every((asset) => captures[asset.id] !== undefined));
  const first = $derived(assets[0] ? captures[assets[0].id] : undefined);

  const currentYear = new Date().getFullYear();
  const decades = decadeChoices(currentYear);
  /** The selection's accuracy when every item shares it, so reopening shows what is stored. */
  const sharedAccuracy =
    loaded && assets.every((asset) => dateAccuracyOf(asset.dateAccuracy) === dateAccuracyOf(assets[0].dateAccuracy))
      ? dateAccuracyOf(assets[0].dateAccuracy)
      : null;
  const firstYear = Number(assets[0]?.localDateTime?.slice(0, 4)) || currentYear;
  const knownYear = Math.min(Math.max(firstYear, MIN_APPROXIMATE_YEAR), currentYear);
  let precision = $state<DatePrecision>(sharedAccuracy ?? 'exact');
  let yearText = $state(String(knownYear));
  let decade = $state(String(decadeOf(knownYear)));
  const year = $derived(parseApproximateYear(yearText, currentYear));
  /** The first year of the chosen period, or null while the year typed is not one. */
  const periodYear = $derived(precision === 'year' ? year : precision === 'decade' ? Number(decade) : null);

  let mode = $state<'set' | 'shift'>('set');
  let date = $state('');
  let time = $state('');
  let amount = $state('1');
  let unit = $state<'minutes' | 'hours' | 'days'>('hours');
  let direction = $state<'later' | 'earlier'>('later');
  /** The chosen zone by id; empty until chosen where nothing honest can be pre-selected. */
  let zoneValue = $state('');
  let touchedDate = false;
  let touchedZone = false;

  /** Pre-fill from the first item's capture time, and keep zones, until the person changes them. */
  const prefill = () => {
    const initial = splitLocalDateTime(first?.localDateTime);
    if (!touchedDate && initial) {
      date = initial.date;
      time = initial.time;
    }
    if (!touchedZone) {
      zoneValue = canKeep
        ? KEEP
        : first
          ? (first.timeZone ??
            zoneForOffset(timeZoneChoices({ wallTime: first.localDateTime }), first.offsetMinutes)?.value ??
            '')
          : '';
    }
  };
  prefill();

  onMount(() => {
    if (!resolveCaptureTimes || !loaded) {
      return;
    }
    resolving = true;
    void resolveCaptureTimes(assets.map((asset) => asset.id))
      .then((result) => {
        fetched = result;
        prefill();
      })
      .catch(() => {})
      .finally(() => (resolving = false));
  });

  let minutes = $derived(MINUTES_PER_UNIT[unit] * Number(amount) * (direction === 'earlier' ? -1 : 1));
  const wallTime = $derived(`${date}T${time}`);
  const zoneChosen = $derived(zoneValue !== '');
  let valid = $derived(
    mode === 'set'
      ? precision === 'exact'
        ? /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) && zoneChosen && !resolving
        : periodYear !== null
      : Number.isFinite(Number(amount)) && Number(amount) > 0,
  );

  const choices = $derived(
    timeZoneChoices({
      wallTime: /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time) ? wallTime : undefined,
      locale: $locale ?? undefined,
    }),
  );
  const keepOption = $derived<ComboBoxOption>({
    id: KEEP,
    value: KEEP,
    label: $t('frameleaf_bulk_date_keep_time_zone'),
  });
  const zoneOptions = $derived<ComboBoxOption[]>([
    ...(canKeep ? [keepOption] : []),
    ...choices.map((choice) => ({ id: choice.value, value: choice.value, label: choice.label })),
  ]);
  /** Its label is read from the current options, so a date change relabels it. */
  const selectedZone = $derived(zoneOptions.find((option) => option.value === zoneValue));

  const approximatePreview = $derived.by(() => {
    if (precision === 'decade') {
      return $t('frameleaf_bulk_date_will_show_decade', { values: { count, decade } });
    }
    if (year !== null) {
      return $t('frameleaf_bulk_date_will_show_year', { values: { count, year: String(year) } });
    }
    return /^\d{4}$/.test(yearText.trim())
      ? $t('frameleaf_date_year_range', { values: { min: String(MIN_APPROXIMATE_YEAR), max: String(currentYear) } })
      : $t('frameleaf_date_enter_year');
  });

  let preview = $derived(
    mode === 'set' && precision !== 'exact'
      ? approximatePreview
      : valid
        ? mode === 'set'
          ? $t('frameleaf_bulk_date_preview_set', { values: { count, date, time } })
          : $t('frameleaf_bulk_date_preview_shift', {
              values: { count, amount: Number(amount), unit: $t(`frameleaf_bulk_date_unit_${unit}`).toLowerCase() },
            })
        : mode === 'set' && !zoneChosen
          ? $t('frameleaf_bulk_date_choose_zone')
          : $t('frameleaf_bulk_date_incomplete'),
  );

  const submit = () => {
    if (mode === 'shift') {
      onSubmit({ dateMode: 'shift', minutes });
      return;
    }
    if (precision !== 'exact') {
      if (periodYear !== null) {
        onSubmit({ dateMode: 'set', dateAccuracy: precision, year: periodYear });
      }
      return;
    }
    if (zoneValue === KEEP && canKeep) {
      const own = assets.map((asset) => [asset.id, captures[asset.id]] as const);
      const zones = Object.fromEntries(
        own.filter(([, capture]) => !!capture.timeZone).map(([id, capture]) => [id, capture.timeZone as string]),
      );
      onSubmit({
        dateMode: 'set',
        dateTimeOriginal: wallTime,
        offsetMinutesById: Object.fromEntries(own.map(([id, capture]) => [id, capture.offsetMinutes])),
        ...(Object.keys(zones).length > 0 && { timeZoneById: zones }),
      });
      return;
    }
    if (!zoneChosen) {
      return;
    }
    const dateTimeOriginal = wallTimeInZone(wallTime, zoneValue);
    if (dateTimeOriginal) {
      onSubmit({ dateMode: 'set', dateTimeOriginal, timeZone: zoneValue });
    }
  };
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_change_date')}
  submitLabel={$t('frameleaf_bulk_apply_to', { values: { count } })}
  {valid}
  {preview}
  onSubmit={submit}
>
  <fieldset>
    <legend>{$t('frameleaf_bulk_date_how')}</legend>
    <label><input type="radio" value="set" bind:group={mode} />{$t('frameleaf_bulk_date_set')}</label>
    <label><input type="radio" value="shift" bind:group={mode} />{$t('frameleaf_bulk_date_shift')}</label>
  </fieldset>

  {#if mode === 'set'}
    <DatePrecisionChoice value={precision} onChange={(value) => (precision = value)} />
  {/if}
  {#if mode === 'set' && precision === 'year'}
    <label>
      {$t('frameleaf_date_precision_year')}
      <input
        type="text"
        inputmode="numeric"
        maxlength="4"
        placeholder="1975"
        bind:value={yearText}
        aria-invalid={year === null}
      />
    </label>
  {:else if mode === 'set' && precision === 'decade'}
    <label>
      {$t('frameleaf_date_precision_decade')}
      <select bind:value={decade}>
        {#each decades as option (option)}
          <option value={String(option)}>
            {$t('frameleaf_date_decade_option', { values: { decade: String(option) } })}
          </option>
        {/each}
      </select>
    </label>
  {:else if mode === 'set'}
    <div class="fl-grid">
      <label>
        {$t('date')}
        <input type="date" bind:value={date} oninput={() => (touchedDate = true)} required />
      </label>
      <label>
        {$t('time')}
        <input type="time" bind:value={time} oninput={() => (touchedDate = true)} required />
      </label>
    </div>
    <div class="fl-zone">
      <Picker
        label={$t('frameleaf_bulk_date_time_zone')}
        options={zoneOptions}
        selectedOption={selectedZone}
        onSelect={(option) => {
          if (!option) {
            return;
          }
          touchedZone = true;
          zoneValue = option.value;
        }}
      />
    </div>
  {:else}
    <div class="fl-grid">
      <label>
        {$t('frameleaf_bulk_date_amount')}
        <input type="number" min="1" step="1" inputmode="numeric" bind:value={amount} />
      </label>
      <label>
        {$t('frameleaf_bulk_date_unit')}
        <select bind:value={unit}>
          <option value="minutes">{$t('frameleaf_bulk_date_unit_minutes')}</option>
          <option value="hours">{$t('frameleaf_bulk_date_unit_hours')}</option>
          <option value="days">{$t('frameleaf_bulk_date_unit_days')}</option>
        </select>
      </label>
      <label>
        {$t('frameleaf_bulk_date_direction')}
        <select bind:value={direction}>
          <option value="later">{$t('frameleaf_bulk_date_later')}</option>
          <option value="earlier">{$t('frameleaf_bulk_date_earlier')}</option>
        </select>
      </label>
    </div>
  {/if}
</BulkFormDialog>

<style>
  /* The zone names are long; the searchable list takes the dialog's full width. */
  .fl-zone {
    min-width: 0;
  }
</style>
