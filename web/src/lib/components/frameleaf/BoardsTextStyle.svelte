<script lang="ts">
  /**
   * The style of a text annotation (FL-1359, approved prototype `TextStyleControl`): its font (the
   * standard one, or a font kept in Boards), size, colour and, for a variable font, its weight.
   * A font a browser cannot draw (a collection, Type 1) is listed but cannot be chosen.
   */
  import {
    listBoardsFonts,
    TEXT_COLOURS,
    TEXT_SIZES,
    textSizeId,
    tidyStyle,
    type BoardsFontChoice,
  } from '$lib/frameleaf/boards-fonts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetFont, type AssetAnnotationStyle, type AssetFontAxisDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiInformationOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    style: AssetAnnotationStyle | undefined;
    /** `typing` merges the change into the last undo step, as dragging the weight does. */
    onChange: (style: AssetAnnotationStyle | undefined, typing: boolean) => void;
  };

  let { style, onChange }: Props = $props();
  const id = $props.id();

  let fonts = $state<BoardsFontChoice[] | null>(null);
  onMount(() => {
    listBoardsFonts()
      .then((list) => (fonts = list))
      .catch(() => (fonts = []));
  });

  /** True while one drag of the weight slider is under way. */
  let adjusting = false;

  const fontId = $derived(style?.fontAssetId ?? '');
  const missing = $derived(!!fontId && fonts !== null && fonts.every((font) => font.id !== fontId));

  /** The chosen font's weight axis, when it is a variable font. */
  let weightAxis = $state<AssetFontAxisDto | null>(null);
  $effect(() => {
    const chosen = fontId;
    weightAxis = null;
    if (!chosen) {
      return;
    }
    let current = true;
    getAssetFont({ ...authManager.params, id: chosen })
      .then((font) => {
        if (current) {
          weightAxis = font.axes.find((axis) => axis.tag === 'wght') ?? null;
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });

  const change = (patch: Partial<AssetAnnotationStyle>, typing = false) =>
    onChange(tidyStyle({ ...style, ...patch }), typing);
  const weight = $derived(
    weightAxis ? Math.min(weightAxis.max, Math.max(weightAxis.min, style?.variation?.wght ?? weightAxis.default)) : 400,
  );
</script>

<div class="text-style" role="group" aria-label={$t('frameleaf_boards_text_style')} data-text-style>
  <label>
    <span>{$t('frameleaf_boards_text_font')}</span>
    <select
      class="fl-control"
      value={fontId}
      onchange={(event) => change({ fontAssetId: event.currentTarget.value || undefined, variation: undefined })}
    >
      <option value="">{$t('frameleaf_boards_text_font_standard')}</option>
      {#if missing}<option value={fontId} disabled>{$t('frameleaf_boards_text_font_gone')}</option>{/if}
      {#each fonts ?? [] as font (font.id)}
        <option value={font.id} disabled={!font.usable}>
          {font.usable
            ? `${font.name} · ${font.format}`
            : $t('frameleaf_boards_text_font_blocked', { values: { name: font.name } })}
        </option>
      {/each}
    </select>
    <small>{$t('frameleaf_boards_text_font_hint')}</small>
  </label>
  {#if missing}
    <p class="missing" role="status">
      <Icon icon={mdiInformationOutline} size="15" aria-hidden />
      <span>{$t('frameleaf_boards_text_font_missing')}</span>
    </p>
  {/if}
  <label>
    <span>{$t('size')}</span>
    <select
      class="fl-control"
      value={textSizeId(style?.size)}
      onchange={(event) => {
        const chosen = event.currentTarget.value;
        change({ size: TEXT_SIZES.find((size) => size.id === chosen)?.scale });
      }}
    >
      {#each TEXT_SIZES as size (size.id)}
        <option value={size.id}>{$t('frameleaf_boards_text_size', { values: { size: size.id } })}</option>
      {/each}
    </select>
  </label>
  <div class="field" role="radiogroup" aria-labelledby="{id}-colour">
    <span id="{id}-colour">{$t('frameleaf_boards_colour')}</span>
    <div class="colours">
      {#each TEXT_COLOURS as colour (colour.label)}
        <button
          type="button"
          role="radio"
          aria-checked={(style?.color ?? undefined) === colour.value}
          aria-label={$t(colour.label)}
          title={$t(colour.label)}
          style:--swatch={colour.value ?? 'var(--fl-warning)'}
          onclick={() => change({ color: colour.value })}
        ></button>
      {/each}
    </div>
  </div>
  {#if weightAxis}
    <label>
      <span class="head"><span>{$t('frameleaf_boards_font_weight')}</span><output>{Math.round(weight)}</output></span>
      <input
        type="range"
        min={weightAxis.min}
        max={weightAxis.max}
        step="10"
        value={weight}
        oninput={(event) => {
          // one undo step for each drag or key press: its first change starts the step, the rest join it
          change({ variation: { ...style?.variation, wght: Number(event.currentTarget.value) } }, adjusting);
          adjusting = true;
        }}
        onchange={() => (adjusting = false)}
      />
    </label>
  {/if}
</div>

<style>
  .text-style {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  label,
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  select {
    min-height: 36px;
    padding: 0 8px;
    color: var(--fl-text);
  }
  small {
    font-size: var(--fl-font-micro);
  }
  .head {
    display: flex;
    justify-content: space-between;
  }
  .colours {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .colours button {
    width: 28px;
    height: 28px;
    padding: 0;
    border: 2px solid var(--fl-panel);
    border-radius: 50%;
    background: var(--swatch);
    box-shadow: 0 0 0 1px var(--fl-border);
    cursor: pointer;
  }
  .colours button[aria-checked='true'] {
    box-shadow: 0 0 0 2px var(--fl-accent);
  }
  .missing {
    display: flex;
    gap: 8px;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.4;
  }
  .missing > :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--fl-accent);
  }
  button:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
