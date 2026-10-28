<script lang="ts">
  import { ColorTolerance, type ColorFilter as ColorCondition } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';

  let { color, onChange }: { color?: ColorCondition; onChange: (color: ColorCondition | undefined) => void } = $props();
  let draft = $state('');
  let invalid = $state(false);
  const id = $props.id();
  $effect(() => {
    draft = color?.hex ?? '';
    invalid = false;
  });

  const choose = (value: string) => {
    draft = value.trim();
    invalid = !/^#[\da-f]{6}$/i.test(draft);
    if (!invalid) {
      onChange({
        hex: draft.toLowerCase(),
        tolerance: color?.tolerance ?? ColorTolerance.Normal,
        minWeight: color?.minWeight ?? 0.05,
      });
    }
  };
  const tolerance = (value: string) => {
    const next = Object.values(ColorTolerance).find((option) => option === value);
    if (color && next) {
      onChange({ ...color, tolerance: next });
    }
  };
  const coverage = (value: number) => {
    if (color && Number.isFinite(value) && value >= 0 && value <= 100) {
      onChange({ ...color, minWeight: value / 100 });
    }
  };
</script>

<fieldset class="fl-color-filter">
  <legend>{$t('frameleaf_color_filter')}</legend>
  <div class="fl-color-inputs">
    <input
      type="color"
      aria-label={$t('frameleaf_color_choose')}
      value={color?.hex ?? '#808080'}
      onchange={(event) => choose(event.currentTarget.value)}
    />
    <label>
      <span>{$t('frameleaf_color_hex')}</span>
      <input
        type="text"
        value={draft}
        placeholder="#609060"
        maxlength="7"
        spellcheck="false"
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onchange={(event) => choose(event.currentTarget.value)}
      />
    </label>
  </div>
  {#if invalid}<p id="{id}-error" role="alert">{$t('frameleaf_color_hex_invalid')}</p>{/if}
  <SegmentedControl
    label={$t('frameleaf_color_tolerance')}
    options={[
      { value: ColorTolerance.Tight, label: $t('frameleaf_color_tight') },
      { value: ColorTolerance.Normal, label: $t('frameleaf_color_normal') },
      { value: ColorTolerance.Broad, label: $t('frameleaf_color_broad') },
    ]}
    value={color?.tolerance ?? ColorTolerance.Normal}
    disabled={!color}
    onChange={tolerance}
  />
  <label class="fl-color-coverage">
    <span>{$t('frameleaf_color_coverage')}</span>
    <span
      ><input
        type="number"
        min="0"
        max="100"
        step="1"
        disabled={!color}
        value={Math.round((color?.minWeight ?? 0.05) * 100)}
        onchange={(event) => coverage(event.currentTarget.valueAsNumber)}
      /> %</span
    >
  </label>
  <Button
    variant="quiet"
    disabled={!color && !draft}
    onclick={() => {
      draft = '';
      invalid = false;
      onChange(undefined);
    }}>{$t('frameleaf_color_clear')}</Button
  >
</fieldset>

<style>
  .fl-color-filter {
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
  .fl-color-inputs {
    display: grid;
    grid-template-columns: 3rem minmax(0, 1fr);
    align-items: end;
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
  }
  input[type='color'] {
    width: 100%;
    cursor: pointer;
  }
  input:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  input:disabled {
    opacity: 0.5;
  }
  .fl-color-coverage {
    grid-template-columns: 1fr auto;
    align-items: center;
  }
  .fl-color-coverage input {
    width: 4.5rem;
    font-variant-numeric: tabular-nums;
  }
  p {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
</style>
