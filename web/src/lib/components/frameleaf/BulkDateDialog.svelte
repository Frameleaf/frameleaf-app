<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import type { ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import type { BulkAsset } from '$lib/frameleaf/bulk-actions';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import {
    browserTimeZone,
    splitLocalDateTime,
    timeZoneChoices,
    wallTimeInZone,
    zoneForOffset,
  } from '$lib/frameleaf/time-zones';
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
   * item's time zone" sends the wall time at each item's own offset. Keeping needs every item's
   * offset, so it is offered only when the whole selection is loaded; otherwise the list opens on
   * the first item's zone.
   */
  let {
    count,
    /** The selected items, when every one of them is loaded; empty for a "select all matching" set. */
    assets = [],
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    assets?: BulkAsset[];
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  const MINUTES_PER_UNIT = { minutes: 1, hours: 60, days: 1440 };
  const KEEP = 'keep';

  const first = assets[0];
  const initial = splitLocalDateTime(first?.localDateTime);
  /** Each item's own offset, when every selected item's is known. */
  const offsets: Record<string, number> | null =
    assets.length > 0 && assets.length === count && assets.every((asset) => Number.isFinite(asset.utcOffsetMinutes))
      ? Object.fromEntries(assets.map((asset) => [asset.id, asset.utcOffsetMinutes as number]))
      : null;

  let mode = $state<'set' | 'shift'>('set');
  let date = $state(initial?.date ?? '');
  let time = $state(initial?.time ?? '12:00');
  let amount = $state('1');
  let unit = $state<'minutes' | 'hours' | 'days'>('hours');
  let direction = $state<'later' | 'earlier'>('later');

  let minutes = $derived(MINUTES_PER_UNIT[unit] * Number(amount) * (direction === 'earlier' ? -1 : 1));
  let valid = $derived(
    mode === 'set'
      ? /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
      : Number.isFinite(Number(amount)) && Number(amount) > 0,
  );
  const wallTime = $derived(`${date}T${time}`);

  const choices = $derived(
    timeZoneChoices({ wallTime: valid && mode === 'set' ? wallTime : undefined, locale: $locale ?? undefined }),
  );
  const keepOption = $derived<ComboBoxOption>({
    id: KEEP,
    value: KEEP,
    label: $t('frameleaf_bulk_date_keep_time_zone'),
  });
  const zoneOptions = $derived<ComboBoxOption[]>([
    ...(offsets ? [keepOption] : []),
    ...choices.map((choice) => ({ id: choice.value, value: choice.value, label: choice.label })),
  ]);

  /** The chosen zone by id; its label is read from the current options, so a date change relabels it. */
  let zoneValue = $state<string>(
    offsets
      ? KEEP
      : ((first?.utcOffsetMinutes === undefined
          ? undefined
          : zoneForOffset(timeZoneChoices({ wallTime: first?.localDateTime }), first.utcOffsetMinutes)?.value) ??
          browserTimeZone()),
  );
  const selectedZone = $derived(zoneOptions.find((option) => option.value === zoneValue) ?? zoneOptions[0]);

  let preview = $derived(
    valid
      ? mode === 'set'
        ? $t('frameleaf_bulk_date_preview_set', { values: { count, date, time } })
        : $t('frameleaf_bulk_date_preview_shift', {
            values: { count, amount: Number(amount), unit: $t(`frameleaf_bulk_date_unit_${unit}`).toLowerCase() },
          })
      : $t('frameleaf_bulk_date_incomplete'),
  );

  const submit = () => {
    if (mode === 'shift') {
      onSubmit({ dateMode: 'shift', minutes });
      return;
    }
    if (selectedZone?.value === KEEP && offsets) {
      onSubmit({ dateMode: 'set', dateTimeOriginal: wallTime, offsetMinutesById: offsets });
      return;
    }
    const zone = selectedZone?.value ?? browserTimeZone();
    const dateTimeOriginal = wallTimeInZone(wallTime, zone);
    if (dateTimeOriginal) {
      onSubmit({ dateMode: 'set', dateTimeOriginal, timeZone: zone });
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
    <div class="fl-grid">
      <label>
        {$t('date')}
        <input type="date" bind:value={date} required />
      </label>
      <label>
        {$t('time')}
        <input type="time" bind:value={time} required />
      </label>
    </div>
    <div class="fl-zone">
      <Picker
        label={$t('frameleaf_bulk_date_time_zone')}
        options={zoneOptions}
        selectedOption={selectedZone}
        onSelect={(option) => {
          if (option) {
            zoneValue = option.value;
          }
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
