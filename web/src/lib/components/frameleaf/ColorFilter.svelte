<script lang="ts">
  /**
   * Find by colour (Boards prototype `ColourPopover`): 16 named swatches, any colour or hex, "How
   * close" and "Only the main colour". Choices are a draft until "Show matches"; Cancel puts the
   * draft back to the filter that is applied, and Clear removes it.
   *
   * The prototype's Exact, Close and Loose are the server's Tight, Normal and Broad tolerances, and
   * "Only the main colour" is a high minimum coverage (`COLOR_MAIN_MIN_WEIGHT`).
   */
  import { ColorTolerance, type ColorFilter as ColorCondition } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import {
    COLOR_CLOSENESS,
    COLOR_PRESETS,
    colorChoiceOf,
    colorFilterFrom,
    colorNameValues,
    isHexColor,
  } from '$lib/frameleaf/library-filters';

  let {
    color,
    onChange,
    onCancel,
  }: {
    color?: ColorCondition;
    onChange: (color: ColorCondition | undefined) => void;
    /** Called after Cancel restores the draft, so a popover host can close. */
    onCancel?: () => void;
  } = $props();

  const id = $props.id();
  let hex = $state('');
  let tolerance = $state<ColorTolerance>(ColorTolerance.Normal);
  let mainOnly = $state(false);
  let touched = $state(false);

  const reset = () => {
    const choice = colorChoiceOf(color);
    hex = choice?.hex ?? '';
    tolerance = choice?.tolerance ?? ColorTolerance.Normal;
    mainOnly = choice?.mainOnly ?? false;
    touched = false;
  };
  $effect(() => {
    void color;
    reset();
  });

  const trimmed = $derived(hex.trim());
  const normalized = $derived(trimmed.startsWith('#') ? trimmed : `#${trimmed}`);
  const valid = $derived(isHexColor(normalized));
  const invalid = $derived(touched && trimmed !== '' && !valid);
  const show = () => {
    if (valid) {
      onChange(colorFilterFrom({ hex: normalized, tolerance, mainOnly }));
    }
  };
</script>

<fieldset class="fl-color-filter">
  <legend>{$t('frameleaf_color_filter')}</legend>
  <div class="fl-color-swatches" role="group" aria-label={$t('frameleaf_boards_colour_pick')}>
    {#each COLOR_PRESETS as preset (preset.id)}
      {@const name = $t('frameleaf_boards_colour_name', { values: colorNameValues(preset.hex) })}
      <button
        type="button"
        class="fl-color-swatch"
        style:--swatch={preset.hex}
        aria-label={name}
        title={name}
        aria-pressed={valid && normalized.toLowerCase() === preset.hex}
        onclick={() => {
          hex = preset.hex;
          touched = false;
        }}
      ></button>
    {/each}
  </div>
  <div class="fl-color-inputs">
    <input
      type="color"
      aria-label={$t('frameleaf_boards_colour_any')}
      value={valid ? normalized.toLowerCase() : '#808080'}
      oninput={(event) => {
        hex = event.currentTarget.value;
        touched = false;
      }}
    />
    <label>
      <span>{$t('frameleaf_color_hex')}</span>
      <input
        type="text"
        bind:value={hex}
        placeholder="#3f8f8a"
        maxlength="7"
        spellcheck="false"
        autocomplete="off"
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onchange={() => (touched = true)}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            touched = true;
            show();
          }
        }}
      />
    </label>
  </div>
  {#if invalid}<p id="{id}-error" class="fl-color-error" role="alert">{$t('frameleaf_color_hex_invalid')}</p>{/if}
  <SegmentedControl
    label={$t('frameleaf_boards_colour_how_close')}
    options={COLOR_CLOSENESS.map((option) => ({ value: option.value, label: $t(option.labelKey) }))}
    value={tolerance}
    onChange={(value) => {
      const next = COLOR_CLOSENESS.find((option) => option.value === value);
      if (next) {
        tolerance = next.value;
      }
    }}
  />
  <label class="fl-color-check">
    <input type="checkbox" bind:checked={mainOnly} />
    <span>{$t('frameleaf_boards_colour_main_only')}</span>
  </label>
  <p class="fl-color-note">{$t('frameleaf_boards_colour_video_note')}</p>
  <div class="fl-color-actions">
    {#if color}<Button variant="quiet" onclick={() => onChange(undefined)}>{$t('frameleaf_color_clear')}</Button>{/if}
    <Button
      onclick={() => {
        reset();
        onCancel?.();
      }}>{$t('cancel')}</Button
    >
    <Button variant="primary" disabled={!valid} onclick={show}>{$t('frameleaf_boards_colour_show')}</Button>
  </div>
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
  .fl-color-swatches {
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: var(--fl-space-2);
  }
  .fl-color-swatch {
    aspect-ratio: 1;
    min-width: 24px;
    min-height: 24px;
    padding: 0;
    background: var(--swatch);
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    cursor: pointer;
  }
  .fl-color-swatch[aria-pressed='true'] {
    box-shadow:
      0 0 0 2px var(--fl-panel),
      0 0 0 4px var(--fl-accent);
  }
  .fl-color-swatch:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
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
  input[type='text'],
  input[type='color'] {
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
  .fl-color-check {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 2.75rem;
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .fl-color-check input {
    width: 1.125rem;
    height: 1.125rem;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .fl-color-note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-color-error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .fl-color-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
</style>
