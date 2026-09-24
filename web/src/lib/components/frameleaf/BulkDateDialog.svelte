<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import type { ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { splitLocalDateTime, timeZoneChoices } from '$lib/frameleaf/time-zones';
  import { DateTime } from 'luxon';
  import { locale, t } from 'svelte-i18n';

  /**
   * Change date, ported from the prototype's `ChangeDateDialog` (`SelectionBar.jsx`). Both modes bind
   * to the one bulk update endpoint: "set the same date" sends `dateTimeOriginal` with an optional
   * IANA time zone, and "shift all by" sends `dateTimeRelative` in minutes, which keeps each item's
   * spacing.
   *
   * As in the prototype the dialog opens on the first selected item's own date and time, and the
   * time zone list names places ("Vancouver (Pacific Time · UTC−07:00)") rather than raw IANA ids.
   * Every zone the browser knows is offered, so the list is searchable (the Frameleaf `Picker`).
   */
  let {
    count,
    /** The first selected item's capture date and time on its own clock (`yyyy-MM-ddTHH:mm`). */
    initialDateTime,
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    initialDateTime?: string;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  const MINUTES_PER_UNIT = { minutes: 1, hours: 60, days: 1440 };
  const KEEP = 'keep';

  const initial = splitLocalDateTime(initialDateTime);
  let mode = $state<'set' | 'shift'>('set');
  let date = $state(initial?.date ?? '');
  let time = $state(initial?.time ?? '12:00');
  let amount = $state('1');
  let unit = $state<'minutes' | 'hours' | 'days'>('hours');
  let direction = $state<'later' | 'earlier'>('later');

  const keepOption = $derived<ComboBoxOption>({
    id: KEEP,
    value: KEEP,
    label: $t('frameleaf_bulk_date_keep_time_zone'),
  });
  let zone = $state<ComboBoxOption>();
  const selectedZone = $derived(zone ?? keepOption);

  let minutes = $derived(MINUTES_PER_UNIT[unit] * Number(amount) * (direction === 'earlier' ? -1 : 1));
  let valid = $derived(
    mode === 'set'
      ? /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
      : Number.isFinite(Number(amount)) && Number(amount) > 0,
  );

  /** Offsets follow daylight saving on the date being set, as the upstream picker did. */
  const moment = $derived.by(() => {
    const parsed = valid && mode === 'set' ? DateTime.fromISO(`${date}T${time}`, { zone: 'utc' }) : null;
    return parsed?.isValid ? parsed.toJSDate() : new Date();
  });
  const zoneOptions = $derived<ComboBoxOption[]>([
    keepOption,
    ...timeZoneChoices({ at: moment, locale: $locale ?? undefined }).map((choice) => ({
      id: choice.value,
      value: choice.value,
      label: choice.label,
    })),
  ]);

  let preview = $derived(
    valid
      ? mode === 'set'
        ? $t('frameleaf_bulk_date_preview_set', { values: { count, date, time } })
        : $t('frameleaf_bulk_date_preview_shift', {
            values: { count, amount: Number(amount), unit: $t(`frameleaf_bulk_date_unit_${unit}`).toLowerCase() },
          })
      : $t('frameleaf_bulk_date_incomplete'),
  );

  const submit = () =>
    onSubmit(
      mode === 'set'
        ? {
            dateMode: 'set',
            dateTimeOriginal: `${date}T${time.length === 5 ? `${time}:00` : time}`,
            ...(selectedZone.value !== KEEP && { timeZone: selectedZone.value }),
          }
        : { dateMode: 'shift', minutes },
    );
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
        onSelect={(option) => (zone = option ?? keepOption)}
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
