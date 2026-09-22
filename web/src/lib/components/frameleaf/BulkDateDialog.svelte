<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { t } from 'svelte-i18n';

  /**
   * Change date, ported from the prototype's `ChangeDateDialog`. Both modes bind to the one bulk
   * update endpoint: "set the same date" sends `dateTimeOriginal` with an optional IANA time zone,
   * and "shift all by" sends `dateTimeRelative` in minutes, which keeps each item's spacing.
   */
  let {
    count,
    initialDate = '',
    initialTime = '12:00',
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    initialDate?: string;
    initialTime?: string;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  const TIME_ZONES = [
    'UTC',
    'America/Vancouver',
    'America/Edmonton',
    'America/Toronto',
    'Europe/London',
    'Europe/Berlin',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];
  const MINUTES_PER_UNIT = { minutes: 1, hours: 60, days: 1440 };

  let mode = $state<'set' | 'shift'>('set');
  let date = $state(initialDate);
  let time = $state(initialTime);
  let timeZone = $state('keep');
  let amount = $state('1');
  let unit = $state<'minutes' | 'hours' | 'days'>('hours');
  let direction = $state<'later' | 'earlier'>('later');

  let minutes = $derived(MINUTES_PER_UNIT[unit] * Number(amount) * (direction === 'earlier' ? -1 : 1));
  let valid = $derived(
    mode === 'set'
      ? /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
      : Number.isFinite(Number(amount)) && Number(amount) > 0,
  );
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
            ...(timeZone === 'keep' ? {} : { timeZone }),
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
      <label>
        {$t('frameleaf_bulk_date_time_zone')}
        <select bind:value={timeZone}>
          <option value="keep">{$t('frameleaf_bulk_date_keep_time_zone')}</option>
          {#each TIME_ZONES as zone (zone)}
            <option value={zone}>{zone}</option>
          {/each}
        </select>
      </label>
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
