<script lang="ts">
  /**
   * The one date field (FL-1814; the prototype's `DateField` in `ComponentsSheet.jsx`) for a photo's date, a bulk
   * date change and a person's dates. It asks how sure you are first, so "sometime in 1987" is as easy to enter as
   * a full date, shows only the fields that answer needs, and reads the date back in words.
   *
   * `decade` is offered only when the date was already stored that way, so opening one shows it as it is and
   * changes nothing until something else is picked.
   */
  import { formatDate, formatTime } from '$lib/frameleaf/date-format';
  import { isRealDay, type DateFieldValue, type DateSure } from '$lib/frameleaf/date-field';
  import { Icon } from '@frameleaf/ui';
  import { mdiCalendarClock } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    label,
    value,
    onChange,
    withTime = false,
    minYear = 1800,
    maxYear = new Date().getFullYear(),
  }: {
    label: string;
    value: DateFieldValue;
    onChange: (value: DateFieldValue) => void;
    withTime?: boolean;
    minYear?: number;
    maxYear?: number;
  } = $props();

  const id = $props.id();
  const set = (patch: Partial<DateFieldValue>) => onChange({ ...value, ...patch });

  const choices = $derived<{ value: DateSure; label: string }[]>([
    { value: 'day', label: $t('frameleaf_date_field_sure_day') },
    { value: 'month', label: $t('frameleaf_date_field_sure_month') },
    { value: 'year', label: $t('frameleaf_date_field_sure_year') },
    { value: 'about', label: $t('frameleaf_date_field_sure_about') },
    ...(value.sure === 'decade' ? [{ value: 'decade' as const, label: $t('frameleaf_date_precision_decade') }] : []),
  ]);
  // the person's own date format and language (date-format.ts), on the local calendar
  const months = Array.from({ length: 12 }, (_, index) => formatDate(new Date(2000, index, 1), { month: 'long' }));

  const yearOk = $derived(Number.isSafeInteger(value.year) && value.year >= minYear && value.year <= maxYear);
  const said = $derived.by(() => {
    if (!yearOk) {
      return $t('frameleaf_date_year_range', { values: { min: String(minYear), max: String(maxYear) } });
    }
    const at = new Date(value.year, value.month - 1, value.day);
    // a year before 100 would read as 19xx without this
    at.setFullYear(value.year);
    switch (value.sure) {
      case 'day': {
        if (!isRealDay(value)) {
          return $t('frameleaf_date_field_not_a_day');
        }
        const day = formatDate(at, { year: 'numeric', month: 'long', day: 'numeric' });
        if (!withTime || !value.time) {
          return day;
        }
        const [hour, minute] = value.time.split(':').map(Number);
        const time = formatTime(new Date(2000, 0, 1, hour, minute), { hour: 'numeric', minute: '2-digit' });
        return $t('frameleaf_date_field_day_at', { values: { day, time } });
      }
      case 'month': {
        return formatDate(at, { year: 'numeric', month: 'long' });
      }
      case 'year': {
        return String(value.year);
      }
      case 'about': {
        return $t('frameleaf_date_field_around', { values: { year: String(value.year) } });
      }
      case 'decade': {
        return $t('frameleaf_date_circa_decade_heading', {
          values: { decade: String(Math.floor(value.year / 10) * 10) },
        });
      }
    }
  });
</script>

<fieldset class="date-field">
  <legend>{label}</legend>
  <label class="field">
    <span>{$t('frameleaf_date_field_how_sure')}</span>
    <select value={value.sure} onchange={(event) => set({ sure: event.currentTarget.value as DateSure })}>
      {#each choices as choice (choice.value)}
        <option value={choice.value}>{choice.label}</option>
      {/each}
    </select>
  </label>
  <div class="parts">
    {#if value.sure === 'day'}
      <label class="field">
        <span>{$t('day')}</span>
        <input
          id="{id}-day"
          type="number"
          inputmode="numeric"
          min="1"
          max="31"
          value={value.day}
          oninput={(event) => set({ day: event.currentTarget.valueAsNumber })}
        />
      </label>
    {/if}
    {#if value.sure === 'day' || value.sure === 'month'}
      <label class="field">
        <span>{$t('month')}</span>
        <select value={value.month} onchange={(event) => set({ month: Number(event.currentTarget.value) })}>
          {#each months as name, index (index)}
            <option value={index + 1}>{name}</option>
          {/each}
        </select>
      </label>
    {/if}
    <label class="field">
      <span>{$t('year')}</span>
      <input
        type="number"
        inputmode="numeric"
        min={minYear}
        max={maxYear}
        value={value.year}
        oninput={(event) => set({ year: event.currentTarget.valueAsNumber })}
      />
    </label>
    {#if withTime && value.sure === 'day'}
      <label class="field">
        <span>{$t('time')}</span>
        <input type="time" value={value.time ?? ''} oninput={(event) => set({ time: event.currentTarget.value })} />
      </label>
    {/if}
  </div>
  <p class="said" aria-live="polite">
    <Icon icon={mdiCalendarClock} size="16" aria-hidden />
    {said}
  </p>
</fieldset>

<style>
  .date-field {
    display: grid;
    gap: var(--fl-space-4);
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--fl-space-2);
    padding: 0;
    color: var(--fl-text);
    font-weight: 600;
  }
  .parts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    gap: var(--fl-space-3);
  }
  .field {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .field select,
  .field input {
    min-height: 44px;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-md);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .said {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    margin: 0;
    color: var(--fl-muted);
  }
</style>
