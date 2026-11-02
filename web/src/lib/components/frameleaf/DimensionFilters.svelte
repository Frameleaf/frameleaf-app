<script lang="ts">
  /**
   * Size and shape (Boards prototype `ShapeFilter`): a shape (aspect-ratio ranges), "At least this
   * wide", "Transparent background only" and, kept compact, the video length. Each choice applies at
   * once. A condition this control cannot show (for example one opened from a link) is named, and
   * choosing a value replaces it.
   */
  import type { BoolFilter, NumberFilterNullable, SearchFilter } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    BOARD_SHAPE_LABEL_KEYS,
    MINIMUM_WIDTHS,
    boardShapeCondition,
    boardShapeOf,
    minimumWidthCondition,
    minimumWidthOf,
    type BoardShape,
  } from '$lib/frameleaf/library-filters';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCropLandscape,
    mdiCropPortrait,
    mdiCropSquare,
    mdiPanoramaHorizontalOutline,
    mdiShapeOutline,
  } from '@mdi/js';

  type DimensionField = 'aspectRatio' | 'width' | 'durationMs' | 'hasTransparency';
  let {
    filter,
    onChange,
    onDone,
  }: {
    filter: Pick<SearchFilter, DimensionField>;
    onChange: (field: DimensionField, condition: NumberFilterNullable | BoolFilter | undefined) => void;
    /** Draws Done (and Clear), for a popover host that closes on Done. */
    onDone?: () => void;
  } = $props();

  const id = $props.id();
  const SHAPES: { id: BoardShape; icon: string }[] = [
    { id: 'any', icon: mdiShapeOutline },
    { id: 'landscape', icon: mdiCropLandscape },
    { id: 'portrait', icon: mdiCropPortrait },
    { id: 'square', icon: mdiCropSquare },
    { id: 'wide', icon: mdiPanoramaHorizontalOutline },
  ];
  const shape = $derived(boardShapeOf(filter.aspectRatio));
  const width = $derived(minimumWidthOf(filter.width));
  const transparent = $derived(filter.hasTransparency?.eq === true);
  const durationCustom = $derived(Object.keys(filter.durationMs ?? {}).some((key) => !['gte', 'lte'].includes(key)));
  const active = $derived(!!filter.aspectRatio || !!filter.width || !!filter.hasTransparency || !!filter.durationMs);

  const changeDuration = (bound: 'gte' | 'lte', value: string) => {
    if (durationCustom) {
      return;
    }
    const next = { ...filter.durationMs };
    if (value.trim() === '') {
      delete next[bound];
    } else {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) {
        return;
      }
      next[bound] = Math.round(seconds * 1000);
    }
    onChange('durationMs', Object.keys(next).length > 0 ? next : undefined);
  };
  const durationValue = (bound: 'gte' | 'lte') => {
    const value = filter.durationMs?.[bound];
    return typeof value === 'number' ? value / 1000 : '';
  };
</script>

<fieldset class="fl-dimension-filters">
  <legend>{$t('frameleaf_boards_size_and_shape')}</legend>
  <div class="fl-dimension-group" role="group" aria-labelledby="{id}-shape">
    <span id="{id}-shape" class="fl-dimension-label">{$t('frameleaf_boards_shape')}</span>
    {#if shape === 'custom'}<p class="fl-dimension-note">{$t('frameleaf_search_custom_condition')}</p>{/if}
    <div class="fl-dimension-shapes">
      {#each SHAPES as option (option.id)}
        <button
          type="button"
          class="fl-dimension-shape"
          aria-pressed={shape === option.id}
          onclick={() => onChange('aspectRatio', boardShapeCondition(option.id))}
        >
          <Icon icon={option.icon} size="18" aria-hidden />
          {$t(BOARD_SHAPE_LABEL_KEYS[option.id])}
        </button>
      {/each}
    </div>
  </div>
  <label class="fl-dimension-field">
    <span class="fl-dimension-label">{$t('frameleaf_boards_min_width')}</span>
    <select
      value={String(width)}
      onchange={(event) => {
        const next = Number(event.currentTarget.value);
        if (Number.isFinite(next)) {
          onChange('width', minimumWidthCondition(next));
        }
      }}
    >
      {#if width === 'custom'}<option value="custom" disabled>{$t('frameleaf_search_custom_condition')}</option>{/if}
      {#if typeof width === 'number' && !MINIMUM_WIDTHS.includes(width as (typeof MINIMUM_WIDTHS)[number])}
        <option value={String(width)}>{$t('frameleaf_boards_min_width_value', { values: { width } })}</option>
      {/if}
      {#each MINIMUM_WIDTHS as option (option)}
        <option value={String(option)}>
          {option === 0
            ? $t('frameleaf_boards_min_width_any')
            : option === 1920
              ? $t('frameleaf_boards_min_width_full_hd', { values: { width: option } })
              : option === 3840
                ? $t('frameleaf_boards_min_width_4k', { values: { width: option } })
                : $t('frameleaf_boards_min_width_px', { values: { width: option } })}
        </option>
      {/each}
    </select>
  </label>
  <label class="fl-dimension-check">
    <input
      type="checkbox"
      checked={transparent}
      onchange={(event) => onChange('hasTransparency', event.currentTarget.checked ? { eq: true } : undefined)}
    />
    <span>{$t('frameleaf_boards_transparent_only')}</span>
  </label>
  <div class="fl-dimension-group" role="group" aria-labelledby="{id}-duration">
    <span id="{id}-duration" class="fl-dimension-label">{$t('frameleaf_boards_video_length')}</span>
    {#if durationCustom}<p class="fl-dimension-note">{$t('frameleaf_search_custom_condition')}</p>{/if}
    <div class="fl-dimension-range">
      {#each ['gte', 'lte'] as const as bound (bound)}
        <label>
          <span>{bound === 'gte' ? $t('frameleaf_filter_minimum') : $t('frameleaf_filter_maximum')}</span>
          <input
            type="number"
            min="0"
            step="1"
            inputmode="decimal"
            disabled={durationCustom}
            aria-label={$t(bound === 'gte' ? 'frameleaf_filter_minimum_field' : 'frameleaf_filter_maximum_field', {
              values: { field: $t('frameleaf_filter_duration') },
            })}
            value={durationValue(bound)}
            onchange={(event) => changeDuration(bound, event.currentTarget.value)}
          />
        </label>
      {/each}
    </div>
  </div>
  {#if onDone || active}
    <div class="fl-dimension-actions">
      {#if active}<Button
          variant="quiet"
          onclick={() => {
            const set = [
              filter.aspectRatio && 'aspectRatio',
              filter.width && 'width',
              filter.hasTransparency && 'hasTransparency',
              filter.durationMs && 'durationMs',
            ] as const;
            for (const field of set) {
              if (field) {
                onChange(field, undefined);
              }
            }
          }}>{$t('clear')}</Button
        >{/if}
      {#if onDone}<Button variant="primary" onclick={onDone}>{$t('done')}</Button>{/if}
    </div>
  {/if}
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
  .fl-dimension-group,
  .fl-dimension-field {
    display: grid;
    gap: var(--fl-space-1);
  }
  .fl-dimension-label {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-dimension-shapes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .fl-dimension-shape {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-height: 2.75rem;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .fl-dimension-shape[aria-pressed='true'] {
    border-color: var(--fl-accent);
    box-shadow: inset 0 0 0 1px var(--fl-accent);
    font-weight: 600;
  }
  .fl-dimension-shape:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .fl-dimension-range {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-2);
  }
  .fl-dimension-range label {
    display: grid;
    gap: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  select,
  input[type='number'] {
    min-width: 0;
    min-height: 2.75rem;
    padding: var(--fl-space-2);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-variant-numeric: tabular-nums;
  }
  input:disabled {
    opacity: 0.5;
  }
  .fl-dimension-check {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 2.75rem;
    color: var(--fl-text);
  }
  .fl-dimension-check input {
    width: 1.125rem;
    height: 1.125rem;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .fl-dimension-note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-dimension-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
</style>
