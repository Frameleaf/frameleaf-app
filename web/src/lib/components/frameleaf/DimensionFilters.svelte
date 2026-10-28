<script lang="ts">
  import type { NumberFilterNullable, SearchFilter } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';

  type DimensionField = 'width' | 'height' | 'aspectRatio' | 'durationMs';
  let {
    filter,
    onChange,
  }: {
    filter: Pick<SearchFilter, DimensionField>;
    onChange: (field: DimensionField, condition: NumberFilterNullable | undefined) => void;
  } = $props();
  const fields = [
    { field: 'width', label: 'frameleaf_filter_width', scale: 1, step: 1 },
    { field: 'height', label: 'frameleaf_filter_height', scale: 1, step: 1 },
    { field: 'aspectRatio', label: 'frameleaf_filter_aspect_ratio', scale: 1, step: 0.01 },
    { field: 'durationMs', label: 'frameleaf_filter_duration', scale: 1000, step: 0.1 },
  ] as const;
  const bounds = ['gte', 'lte'] as const;
  const custom = (field: DimensionField) =>
    Object.keys(filter[field] ?? {}).some((key) => !['gte', 'lte'].includes(key));
  const change = (field: DimensionField, bound: (typeof bounds)[number], value: string, scale: number) => {
    if (custom(field)) {
      return;
    }
    const next = { ...filter[field] };
    if (value.trim() === '') {
      delete next[bound];
    } else {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        return;
      }
      next[bound] = number * scale;
    }
    onChange(field, Object.keys(next).length > 0 ? next : undefined);
  };
</script>

<fieldset class="fl-dimension-filters">
  <legend>{$t('frameleaf_filter_dimensions')}</legend>
  {#each fields as entry (entry.field)}
    <div class="fl-dimension-field">
      <div class="fl-dimension-heading">
        <span>{$t(entry.label)}</span>
        {#if filter[entry.field]}<Button
            variant="quiet"
            label={$t('frameleaf_filter_clear_field', { values: { field: $t(entry.label) } })}
            onclick={() => onChange(entry.field, undefined)}>{$t('clear')}</Button
          >{/if}
      </div>
      {#if custom(entry.field)}<p>{$t('frameleaf_search_custom_condition')}</p>{/if}
      <div class="fl-dimension-range">
        {#each bounds as bound (bound)}
          <label>
            <span>{bound === 'gte' ? $t('frameleaf_filter_minimum') : $t('frameleaf_filter_maximum')}</span>
            <input
              type="number"
              min="0"
              step={entry.step}
              disabled={custom(entry.field)}
              aria-label={$t(bound === 'gte' ? 'frameleaf_filter_minimum_field' : 'frameleaf_filter_maximum_field', {
                values: { field: $t(entry.label) },
              })}
              value={filter[entry.field]?.[bound] === undefined ? '' : filter[entry.field]![bound]! / entry.scale}
              onchange={(event) => change(entry.field, bound, event.currentTarget.value, entry.scale)}
            />
          </label>
        {/each}
      </div>
    </div>
  {/each}
</fieldset>

<style>
  .fl-dimension-filters {
    display: grid;
    min-width: 0;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend {
    margin-bottom: var(--fl-space-2);
    font-weight: 600;
  }
  .fl-dimension-field {
    display: grid;
    gap: var(--fl-space-1);
  }
  .fl-dimension-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
  }
  .fl-dimension-range {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-2);
  }
  label {
    display: grid;
    gap: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  input {
    min-width: 0;
    min-height: 2.75rem;
    padding: var(--fl-space-2);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-variant-numeric: tabular-nums;
  }
  input:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  input:disabled {
    opacity: 0.5;
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
