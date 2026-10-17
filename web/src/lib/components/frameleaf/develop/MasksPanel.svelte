<script lang="ts">
  /**
   * The Masks tab (PhotographyEditor.jsx): brush, radial and gradient masks, Subject and Sky found by
   * the server's own ML worker, and each mask's settings. Native masks are drawn on the whole sensor
   * image, before crop and rotation, so the photo shows uncropped while this tab is open.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiBrush, mdiCircleOutline, mdiClose, mdiCreation, mdiEraser, mdiGradientVertical } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import DevelopSlider from '$lib/components/frameleaf/develop/DevelopSlider.svelte';
  import { proposeNativeMask, type NativeMask } from '$lib/frameleaf/native-develop';
  import { MAX_MASKS, createMask, isPainted, isPlaced, isSuggested, type MaskKind } from '$lib/frameleaf/raw-develop';
  import type { DevelopTools, RawDevelopSession } from '$lib/frameleaf/raw-develop-session.svelte';
  import { onDestroy } from 'svelte';

  let {
    session,
    tools,
    id,
    say,
  }: { session: RawDevelopSession; tools: DevelopTools; id: string; say: (message: string) => void } = $props();

  const recipe = $derived(session.record(id).recipe);
  const masks = $derived(recipe.masks ?? []);
  const active = $derived(masks.find((mask) => mask.id === tools.maskId) ?? masks.at(-1));
  let finding = $state<'subject' | 'sky' | null>(null);
  let abort: AbortController | undefined;
  onDestroy(() => abort?.abort());

  const NAMES: Record<MaskKind, string> = {
    brush: 'frameleaf_develop_mask_name_brush',
    radial: 'frameleaf_develop_mask_name_radial',
    linear: 'frameleaf_develop_mask_name_linear',
    subject: 'frameleaf_develop_mask_name_subject',
    sky: 'frameleaf_develop_mask_name_sky',
    background: 'frameleaf_develop_mask_name_background',
  };
  const icon = (kind: MaskKind) =>
    isSuggested(kind)
      ? mdiCreation
      : kind === 'radial'
        ? mdiCircleOutline
        : kind === 'linear'
          ? mdiGradientVertical
          : mdiBrush;

  function add(kind: MaskKind, artifact?: string) {
    if (masks.length >= MAX_MASKS) {
      say($t('frameleaf_develop_mask_limit', { values: { count: MAX_MASKS } }));
      return;
    }
    const mask = createMask(kind, $t(NAMES[kind] as never, { values: { number: masks.length + 1 } }), artifact);
    session.change(id, { ...recipe, masks: [...masks, mask] });
    tools.maskId = mask.id;
    tools.gesture = isPlaced(kind) ? 'place' : 'brush';
    tools.brushMode = 'add';
    tools.overlay = true;
    tools.cropOpen = false;
  }

  async function suggest(target: 'subject' | 'sky') {
    if (masks.length >= MAX_MASKS || finding) {
      return;
    }
    finding = target;
    abort?.abort();
    abort = new AbortController();
    try {
      const artifact = await proposeNativeMask(id, target, abort.signal);
      add(target, artifact.id);
    } catch {
      if (!abort.signal.aborted) {
        say($t('frameleaf_develop_suggest_unavailable'));
      }
    } finally {
      finding = null;
    }
  }

  const edit = (patch: Partial<NativeMask>, coalesce?: string) => {
    if (!active) {
      return;
    }
    session.change(
      id,
      { ...recipe, masks: masks.map((mask) => (mask.id === active.id ? { ...mask, ...patch } : mask)) },
      { coalesce: coalesce && `${active.id}:${coalesce}` },
    );
  };
  const percent = (value: number) => `${Math.round(value)}%`;
</script>

<div class="rde-inspector-heading">
  <strong>{$t('frameleaf_develop_local_adjustments')}</strong><span>{masks.length}</span>
</div>
<div class="rde-mask-tools">
  {#each [['brush', mdiBrush, 'frameleaf_develop_mask_brush'], ['radial', mdiCircleOutline, 'frameleaf_develop_mask_radial'], ['linear', mdiGradientVertical, 'frameleaf_develop_mask_gradient']] as const as [kind, path, label] (kind)}
    <button type="button" class="rde-button" onclick={() => add(kind)}
      ><Icon icon={path} size="15" aria-hidden={true} />{$t(label)}</button
    >
  {/each}
</div>
<div class="rde-ai-tools">
  {#each [['subject', 'frameleaf_develop_mask_subject'], ['sky', 'frameleaf_develop_mask_sky']] as const as [target, label] (target)}
    <button type="button" class="rde-button rde-ai" disabled={!!finding} onclick={() => void suggest(target)}
      ><Icon icon={mdiCreation} size="15" aria-hidden={true} />{finding === target
        ? $t('frameleaf_develop_finding')
        : $t(label)}</button
    >
  {/each}
</div>
<p class="rde-muted">{$t('frameleaf_develop_suggest_note')}</p>

{#if masks.length === 0}
  <div class="rde-empty-mask">
    <Icon icon={mdiBrush} size="28" aria-hidden={true} />
    <p>{$t('frameleaf_develop_mask_empty')}</p>
  </div>
{/if}

{#each masks as mask (mask.id)}
  <div class="rde-mask-row" class:active={active?.id === mask.id}>
    <button
      type="button"
      aria-pressed={active?.id === mask.id}
      onclick={() => {
        tools.maskId = mask.id;
        tools.gesture = isPlaced(mask.kind) ? 'place' : 'brush';
      }}
      ><Icon
        icon={icon(mask.kind)}
        size="16"
        class={isSuggested(mask.kind) ? 'rde-ai' : undefined}
        aria-hidden={true}
      /><span>{mask.name ?? $t(NAMES[mask.kind] as never, { values: { number: '' } })}</span></button
    >
    <input
      type="checkbox"
      aria-label={$t('frameleaf_develop_mask_enable', { values: { name: mask.name ?? '' } })}
      checked={mask.enabled}
      disabled={mask.kind === 'brush' && !mask.strokes?.length}
      onchange={(event) =>
        session.change(id, {
          ...recipe,
          masks: masks.map((item) => (item.id === mask.id ? { ...item, enabled: event.currentTarget.checked } : item)),
        })}
    />
    <button
      type="button"
      aria-label={$t('frameleaf_develop_mask_delete', { values: { name: mask.name ?? '' } })}
      onclick={() => {
        session.change(id, { ...recipe, masks: masks.filter((item) => item.id !== mask.id) });
        if (tools.maskId === mask.id) {
          tools.maskId = null;
        }
      }}><Icon icon={mdiClose} size="15" aria-hidden={true} /></button
    >
  </div>
{/each}

{#if active}
  <div class="rde-mask-settings">
    <div class="rde-section-heading">
      <strong>{active.name}</strong>{#if isSuggested(active.kind)}<span class="rde-ai"
          >{$t('frameleaf_develop_suggested')}</span
        >{/if}
    </div>
    {#if isPainted(active.kind)}
      <div class="rde-brush-mode">
        <button
          type="button"
          aria-pressed={tools.brushMode === 'add'}
          onclick={() => {
            tools.brushMode = 'add';
            tools.gesture = 'brush';
          }}>{$t('frameleaf_develop_brush_add')}</button
        >
        <button
          type="button"
          aria-pressed={tools.brushMode === 'subtract'}
          onclick={() => {
            tools.brushMode = 'subtract';
            tools.gesture = 'brush';
          }}>{$t('frameleaf_develop_brush_subtract')}</button
        >
      </div>
      <DevelopSlider
        label={$t('frameleaf_develop_brush_size')}
        value={Math.round(tools.brushSize * 100)}
        min={1}
        max={40}
        format={percent}
        onChange={(value) => (tools.brushSize = value / 100)}
      />
    {/if}
    <DevelopSlider
      label={$t('frameleaf_editor_mask_feather')}
      value={active.feather}
      min={0}
      max={100}
      onChange={(value) => edit({ feather: value }, 'feather')}
    />
    <DevelopSlider
      label={$t('frameleaf_develop_mask_exposure')}
      value={active.adjustments.exposureEV}
      min={-2}
      max={2}
      step={0.05}
      format={(value) => `${value.toFixed(2)} EV`}
      onChange={(value) => edit({ adjustments: { ...active.adjustments, exposureEV: value } }, 'exposure')}
    />
    <label class="rde-check"
      ><input
        type="checkbox"
        checked={active.invert}
        onchange={(event) => edit({ invert: event.currentTarget.checked })}
      />{$t('frameleaf_editor_mask_invert')}</label
    >
    <label class="rde-check"
      ><input type="checkbox" bind:checked={tools.overlay} />{$t('frameleaf_develop_mask_overlay')}</label
    >
    {#if active.kind === 'radial'}
      <DevelopSlider
        label={$t('frameleaf_develop_centre_x')}
        value={Math.round(active.x * 100)}
        min={0}
        max={100}
        onChange={(value) => edit({ x: value / 100 }, 'x')}
      />
      <DevelopSlider
        label={$t('frameleaf_develop_centre_y')}
        value={Math.round(active.y * 100)}
        min={0}
        max={100}
        onChange={(value) => edit({ y: value / 100 }, 'y')}
      />
      <DevelopSlider
        label={$t('frameleaf_develop_radius_x')}
        value={Math.round(active.radiusX * 100)}
        min={2}
        max={100}
        onChange={(value) => edit({ radiusX: value / 100 }, 'radiusX')}
      />
      <DevelopSlider
        label={$t('frameleaf_develop_radius_y')}
        value={Math.round(active.radiusY * 100)}
        min={2}
        max={100}
        onChange={(value) => edit({ radiusY: value / 100 }, 'radiusY')}
      />
    {:else if active.kind === 'linear'}
      <DevelopSlider
        label={$t('frameleaf_develop_gradient_start')}
        value={Math.round(active.y * 100)}
        min={0}
        max={100}
        onChange={(value) => edit({ y: value / 100 }, 'y')}
      />
      <DevelopSlider
        label={$t('frameleaf_develop_gradient_end')}
        value={Math.round(active.endY * 100)}
        min={0}
        max={100}
        onChange={(value) => edit({ endY: value / 100 }, 'endY')}
      />
    {/if}
    {#if isPainted(active.kind)}
      <button
        type="button"
        class="rde-button"
        disabled={!active.strokes?.length}
        onclick={() => edit({ strokes: [], ...(active.kind === 'brush' && { enabled: false }) })}
        ><Icon icon={mdiEraser} size="15" aria-hidden={true} />{$t('frameleaf_develop_clear_brush')}</button
      >
    {/if}
  </div>
{/if}
<p class="rde-muted">{$t('frameleaf_develop_masks_whole_photo')}</p>
