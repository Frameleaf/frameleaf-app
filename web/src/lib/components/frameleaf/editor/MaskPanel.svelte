<script lang="ts">
  /**
   * The Masks panel of the quick editor (FL-64): selective adjustments. Add a radial or linear
   * mask, place it with the handles on the photo, and move the tone and colour controls that
   * apply only inside it (or outside it, inverted). Masks render on the server exactly as the
   * global sliders do, into the preview and the saved version.
   */
  import EditorSlider from '$lib/components/frameleaf/editor/EditorSlider.svelte';
  import { formatParam, paramFor } from '$lib/frameleaf/develop';
  import {
    MASK_KEYS,
    MAX_MASKS,
    createMask,
    emptyMaskAdjustments,
    maskIsActive,
    type EditorMask,
  } from '$lib/frameleaf/photo-tools';
  import { AssetDevelopMaskKind } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiDeleteOutline,
    mdiEye,
    mdiEyeOff,
    mdiGradientVertical,
    mdiInvertColors,
    mdiRestore,
    mdiVectorEllipse,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    masks,
    selectedId = $bindable(null),
    onChange,
  }: {
    masks: EditorMask[];
    selectedId?: string | null;
    onChange: (masks: EditorMask[]) => void;
  } = $props();

  const selected = $derived(masks.find((mask) => mask.id === selectedId) ?? null);
  const kindLabel = (kind: AssetDevelopMaskKind) =>
    kind === AssetDevelopMaskKind.Radial ? $t('frameleaf_editor_mask_radial') : $t('frameleaf_editor_mask_linear');
  const labelOf = (mask: EditorMask, index: number) =>
    mask.name ?? $t('frameleaf_editor_mask_number', { values: { number: index + 1, kind: kindLabel(mask.kind) } });

  const add = (kind: AssetDevelopMaskKind) => {
    const mask = createMask(kind, masks);
    onChange([...masks, mask]);
    selectedId = mask.id;
  };
  const update = (id: string, patch: Partial<EditorMask>) =>
    onChange(masks.map((mask) => (mask.id === id ? { ...mask, ...patch } : mask)));
  const remove = (id: string) => {
    const index = masks.findIndex((mask) => mask.id === id);
    const next = masks.filter((mask) => mask.id !== id);
    onChange(next);
    if (selectedId === id) {
      selectedId = next[Math.min(index, next.length - 1)]?.id ?? null;
    }
  };
  const listKey = (event: KeyboardEvent) => {
    const index = masks.findIndex((mask) => mask.id === selectedId);
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    const next = forward ? index + 1 : back ? index - 1 : null;
    if (next === null || masks.length === 0) {
      return;
    }
    event.preventDefault();
    const target = masks[(next + masks.length) % masks.length];
    selectedId = target.id;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-mask="${CSS.escape(target.id)}"]`)?.focus();
  };
</script>

<div class="ed-panel-body">
  <div class="ed-panel-head">
    <h2>{$t('frameleaf_editor_tool_masks')}</h2>
    <button
      type="button"
      class="ed-icon"
      aria-label={$t('frameleaf_editor_masks_remove_all')}
      title={$t('frameleaf_editor_masks_remove_all')}
      disabled={masks.length === 0}
      onclick={() => {
        onChange([]);
        selectedId = null;
      }}
    >
      <Icon icon={mdiRestore} size="18" />
    </button>
  </div>
  <p>{$t('frameleaf_editor_masks_help')}</p>
  <div class="ed-grid-2">
    <button
      type="button"
      class="ed-button"
      disabled={masks.length >= MAX_MASKS}
      onclick={() => add(AssetDevelopMaskKind.Radial)}
    >
      <Icon icon={mdiVectorEllipse} size="18" />
      {$t('frameleaf_editor_mask_add_radial')}
    </button>
    <button
      type="button"
      class="ed-button"
      disabled={masks.length >= MAX_MASKS}
      onclick={() => add(AssetDevelopMaskKind.Linear)}
    >
      <Icon icon={mdiGradientVertical} size="18" />
      {$t('frameleaf_editor_mask_add_linear')}
    </button>
  </div>
  {#if masks.length >= MAX_MASKS}
    <p class="ed-note">{$t('frameleaf_editor_masks_limit', { values: { count: MAX_MASKS } })}</p>
  {/if}

  {#if masks.length === 0}
    <p class="ed-empty">{$t('frameleaf_editor_masks_empty')}</p>
  {:else}
    <div
      class="ed-masks"
      role="radiogroup"
      aria-label={$t('frameleaf_editor_tool_masks')}
      tabindex="-1"
      onkeydown={listKey}
    >
      {#each masks as mask, index (mask.id)}
        <div class={['ed-mask', mask.id === selectedId && 'selected', !mask.enabled && 'off']}>
          <button
            type="button"
            role="radio"
            data-mask={mask.id}
            class="ed-mask-pick"
            aria-checked={mask.id === selectedId}
            tabindex={mask.id === selectedId || (!selectedId && index === 0) ? 0 : -1}
            onclick={() => (selectedId = mask.id)}
          >
            <Icon icon={mask.kind === AssetDevelopMaskKind.Radial ? mdiVectorEllipse : mdiGradientVertical} size="16" />
            <span>{labelOf(mask, index)}</span>
            {#if !maskIsActive(mask) && mask.enabled}
              <small>{$t('frameleaf_editor_mask_no_effect')}</small>
            {/if}
          </button>
          <button
            type="button"
            class="ed-icon"
            aria-pressed={!mask.enabled}
            aria-label={mask.enabled ? $t('frameleaf_editor_mask_hide') : $t('frameleaf_editor_mask_show')}
            title={mask.enabled ? $t('frameleaf_editor_mask_hide') : $t('frameleaf_editor_mask_show')}
            onclick={() => update(mask.id, { enabled: !mask.enabled })}
          >
            <Icon icon={mask.enabled ? mdiEye : mdiEyeOff} size="18" />
          </button>
          <button
            type="button"
            class="ed-icon"
            aria-label={$t('frameleaf_editor_mask_delete', { values: { name: labelOf(mask, index) } })}
            title={$t('frameleaf_editor_mask_delete', { values: { name: labelOf(mask, index) } })}
            onclick={() => remove(mask.id)}
          >
            <Icon icon={mdiDeleteOutline} size="18" />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if selected}
    <h3>{labelOf(selected, masks.indexOf(selected))}</h3>
    <div class="ed-row spread">
      <button
        type="button"
        class="ed-button"
        aria-pressed={selected.invert}
        onclick={() => update(selected.id, { invert: !selected.invert })}
      >
        <Icon icon={mdiInvertColors} size="18" />
        {$t('frameleaf_editor_mask_invert')}
      </button>
      <button
        type="button"
        class="ed-icon"
        aria-label={$t('frameleaf_editor_mask_reset')}
        title={$t('frameleaf_editor_mask_reset')}
        disabled={MASK_KEYS.every((key) => selected.adjustments[key] === 0)}
        onclick={() => update(selected.id, { adjustments: emptyMaskAdjustments() })}
      >
        <Icon icon={mdiRestore} size="18" />
      </button>
    </div>
    <EditorSlider
      id="maskAmount"
      label={$t('frameleaf_editor_mask_amount')}
      value={selected.amount}
      min={0}
      max={100}
      defaultValue={100}
      format={(value) => `${value}%`}
      onChange={(value) => update(selected.id, { amount: value })}
    />
    {#if selected.kind === AssetDevelopMaskKind.Radial}
      <EditorSlider
        id="maskFeather"
        label={$t('frameleaf_editor_mask_feather')}
        value={selected.feather}
        min={0}
        max={100}
        defaultValue={50}
        format={(value) => `${value}%`}
        onChange={(value) => update(selected.id, { feather: value })}
      />
    {/if}
    {#each MASK_KEYS as key (key)}
      {@const spec = paramFor(key)}
      <EditorSlider
        id={`mask-${key}`}
        label={$t(spec.label)}
        value={selected.adjustments[key]}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        defaultValue={spec.default}
        format={(value) => formatParam(spec, value)}
        onChange={(value) => update(selected.id, { adjustments: { ...selected.adjustments, [key]: value } })}
      />
    {/each}
    <p class="ed-note">{$t('frameleaf_editor_mask_place_help')}</p>
  {/if}
</div>
