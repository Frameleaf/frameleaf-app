<script lang="ts">
  /**
   * FL-943 "Fix dates…": the Date & Time Doctor's preview for photos picked on the timeline. Either the photos were
   * taken in another time zone (their clock time stays, read in that zone), or their camera's clock was off (every
   * photo moves by the same amount). The strip shows the first few photos before and after, as the server will
   * write them (FL-930), so daylight saving is the server's answer, not a guess here.
   *
   * A date that is simply wrong (a reset camera, a date in the future) needs a date and time set outright: Change
   * date is one click away, on the same selection.
   */
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import DateFixStrip from '$lib/components/frameleaf/DateFixStrip.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { STRIP_SIZE, UNDO_DAYS } from '$lib/frameleaf/date-doctor';
  import { browserTimeZone, timeZoneChoices } from '$lib/frameleaf/time-zones';
  import { previewDateFix, type DateDoctorFixDto, type DateDoctorPreviewItemDto } from '@frameleaf/sdk';
  import { locale, t } from 'svelte-i18n';

  let {
    count,
    ids,
    open = $bindable(true),
    onSubmit,
    onChangeDate,
  }: {
    count: number;
    /** The selection; the first few are previewed. */
    ids: string[];
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
    onChangeDate?: () => void;
  } = $props();

  const MINUTES_PER_UNIT = { minutes: 1, hours: 60, days: 1440 };

  let mode = $state<'zone' | 'shift'>('zone');
  let zone = $state(browserTimeZone());
  let amount = $state('1');
  let unit = $state<'minutes' | 'hours' | 'days'>('hours');
  let direction = $state<'later' | 'earlier'>('later');

  const minutes = $derived(MINUTES_PER_UNIT[unit] * Number(amount) * (direction === 'earlier' ? -1 : 1));
  const valid = $derived(
    mode === 'zone'
      ? zone !== ''
      : Number.isSafeInteger(Number(amount)) && Number(amount) > 0 && Number.isFinite(minutes),
  );

  const options = $derived(
    timeZoneChoices({ locale: $locale ?? undefined }).map((choice) => ({
      id: choice.value,
      value: choice.value,
      label: choice.label,
    })),
  );
  const selectedZone = $derived(options.find((option) => option.value === zone));

  const fix = $derived<Omit<DateDoctorFixDto, 'assetIds'>>(
    mode === 'zone' ? { timeZone: zone, keepWallTime: true } : { shiftMinutes: minutes },
  );

  let preview = $state<DateDoctorPreviewItemDto[]>([]);
  let previewing = $state(false);
  let failed = $state(false);
  let reads = 0;
  let wait: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!valid) {
      return;
    }
    const body: DateDoctorFixDto = { ...fix, assetIds: ids.slice(0, STRIP_SIZE) };
    const read = ++reads;
    clearTimeout(wait);
    // the shown preview is for the old choice until the new one comes back: Fix waits for it
    previewing = true;
    // typing an amount asks once it settles, not on every key
    wait = setTimeout(() => {
      void (async () => {
        try {
          const { items } = await previewDateFix({ dateDoctorFixDto: body });
          if (read === reads) {
            preview = items;
            failed = false;
          }
        } catch {
          if (read === reads) {
            preview = [];
            failed = true;
          }
        } finally {
          if (read === reads) {
            previewing = false;
          }
        }
      })();
    }, 250);
    return () => clearTimeout(wait);
  });

  const submit = () => onSubmit(mode === 'zone' ? { timeZone: zone } : { dateMode: 'shift', minutes });
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_fix_dates')}
  submitLabel={$t('frameleaf_date_doctor_fix', { values: { count } })}
  valid={valid && !previewing}
  preview={failed
    ? $t('frameleaf_date_doctor_preview_failed')
    : $t('frameleaf_date_doctor_promise', { values: { days: UNDO_DAYS } })}
  onSubmit={submit}
>
  <fieldset>
    <legend>{$t('frameleaf_date_doctor_what_happened')}</legend>
    <label><input type="radio" value="zone" bind:group={mode} />{$t('frameleaf_date_doctor_mode_zone')}</label>
    <label><input type="radio" value="shift" bind:group={mode} />{$t('frameleaf_date_doctor_mode_shift')}</label>
  </fieldset>

  {#if mode === 'zone'}
    <div class="zone">
      <Picker
        label={$t('frameleaf_date_doctor_taken_in')}
        {options}
        selectedOption={selectedZone}
        onSelect={(option) => {
          if (option) {
            zone = option.value;
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

  {#if preview.length > 0}
    <DateFixStrip items={preview} busy={previewing} />
  {/if}

  {#if onChangeDate}
    <p class="other">
      <button type="button" class="link" onclick={onChangeDate}>{$t('frameleaf_date_doctor_set_date_instead')}</button>
    </p>
  {/if}
</BulkFormDialog>

<style>
  .zone {
    min-width: 0;
  }
  .other {
    margin: 0;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
