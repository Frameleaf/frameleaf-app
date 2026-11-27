<script lang="ts" module>
  /** How much of a date is known. `decade` is only ever a date stored that way before (FL-936). */
  export type DateSure = 'day' | 'month' | 'year' | 'about' | 'decade';
  export type DateFieldValue = {
    sure: DateSure;
    year: number;
    /** 1–12 */
    month: number;
    day: number;
    /** `HH:mm`, with `withTime` and an exact day only */
    time?: string;
  };

  const pad = (value: number, size = 2) => String(value).padStart(size, '0');

  /** The ISO day a value is stored as: the day itself, or the start of its month, year or decade. */
  export const dateFieldStart = ({ sure, year, month, day }: DateFieldValue) =>
    sure === 'day'
      ? `${pad(year, 4)}-${pad(month)}-${pad(day)}`
      : sure === 'month'
        ? `${pad(year, 4)}-${pad(month)}-01`
        : `${pad(sure === 'decade' ? Math.floor(year / 10) * 10 : year, 4)}-01-01`;

  /** Whether the value can be saved: a whole year in range, and a real day when the day is known. */
  export const isDateFieldValid = (value: DateFieldValue, minYear = 1800, maxYear = new Date().getFullYear()) =>
    Number.isInteger(value.year) &&
    value.year >= minYear &&
    value.year <= maxYear &&
    (value.sure !== 'day' || isRealDay(value));

  /** Whether the value names a real day (no 31 April, no 29 February outside a leap year). */
  export const isRealDay = ({ year, month, day }: Pick<DateFieldValue, 'year' | 'month' | 'day'>) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
</script>

<script lang="ts">
  /**
   * The one date field (FL-1814; the prototype's `DateField` in `ComponentsSheet.jsx`) for a photo's date, a bulk
   * date change and a person's dates. It asks how sure you are first, so "sometime in 1987" is as easy to enter as
   * a full date, shows only the fields that answer needs, and reads the date back in words.
   *
   * `decade` is offered only when the date was already stored that way, so opening one shows it as it is and
   * changes nothing until something else is picked.
   */
  import { locale } from '$lib/stores/preferences.store';
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
  const months = $derived(
    Array.from({ length: 12 }, (_, index) =>
      new Intl.DateTimeFormat($locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, index, 1))),
    ),
  );

  const yearOk = $derived(Number.isInteger(value.year) && value.year >= minYear && value.year <= maxYear);
  const said = $derived.by(() => {
    if (!yearOk) {
      return $t('frameleaf_date_year_range', { values: { min: String(minYear), max: String(maxYear) } });
    }
    const at = new Date(Date.UTC(value.year, value.month - 1, value.day));
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat($locale, { ...options, timeZone: 'UTC' }).format(at);
    switch (value.sure) {
      case 'day': {
        if (!isRealDay(value)) {
          return $t('frameleaf_date_field_not_a_day');
        }
        const day = format({ year: 'numeric', month: 'long', day: 'numeric' });
        if (!withTime || !value.time) {
          return day;
        }
        const [hour, minute] = value.time.split(':').map(Number);
        const time = new Intl.DateTimeFormat($locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(
          new Date(Date.UTC(2000, 0, 1, hour, minute)),
        );
        return $t('frameleaf_date_field_day_at', { values: { day, time } });
      }
      case 'month': {
        return format({ year: 'numeric', month: 'long' });
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
