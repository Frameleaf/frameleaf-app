<script lang="ts">
  /**
   * Handles for the selected mask on the stage (FL-64). It sits inside the straightened media
   * layer, so its percentages are fractions of the oriented frame — the mask's own coordinate
   * space. A radial mask has a centre handle and two radius handles, a linear mask a start
   * handle (full effect) and an end handle (faded out). Every handle takes arrow keys too
   * (Shift moves further), so a mask can be placed without a pointer.
   */
  import { type EditorMask } from '$lib/frameleaf/photo-tools';
  import { AssetDevelopMaskKind } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Handle = 'centre' | 'radiusX' | 'radiusY' | 'start' | 'end';

  let {
    mask,
    onPreview,
    onCommit,
  }: {
    mask: EditorMask;
    /** Live geometry while dragging; null when the drag ends. */
    onPreview: (mask: EditorMask | null) => void;
    onCommit: (mask: EditorMask) => void;
  } = $props();

  let layer = $state<HTMLDivElement>();
  const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const round = (value: number) => Math.round(value * 10_000) / 10_000;

  const moved = (start: EditorMask, handle: Handle, dx: number, dy: number): EditorMask => {
    switch (handle) {
      case 'centre': {
        return { ...start, x: round(clamp(start.x + dx)), y: round(clamp(start.y + dy)) };
      }
      case 'radiusX': {
        return { ...start, radiusX: round(clamp(start.radiusX + dx, 0.01)) };
      }
      case 'radiusY': {
        return { ...start, radiusY: round(clamp(start.radiusY + dy, 0.01)) };
      }
      case 'start': {
        return { ...start, x: round(clamp(start.x + dx)), y: round(clamp(start.y + dy)) };
      }
      case 'end': {
        return { ...start, endX: round(clamp(start.endX + dx)), endY: round(clamp(start.endY + dy)) };
      }
    }
  };
  const valid = (candidate: EditorMask) =>
    candidate.kind !== AssetDevelopMaskKind.Linear || candidate.x !== candidate.endX || candidate.y !== candidate.endY;

  const beginDrag = (handle: Handle) => (event: PointerEvent) => {
    if ((event.pointerType === 'mouse' && event.button !== 0) || !layer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const width = layer.offsetWidth || 1;
    const height = layer.offsetHeight || 1;
    const origin = { x: event.clientX, y: event.clientY };
    const start = mask;
    let latest = start;
    const pointerId = event.pointerId;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // capture is best effort
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      const next = moved(start, handle, (e.clientX - origin.x) / width, (e.clientY - origin.y) / height);
      if (valid(next)) {
        latest = next;
        onPreview(next);
      }
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      onPreview(null);
      if (latest !== start) {
        onCommit(latest);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  const nudge = (handle: Handle) => (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[event.key];
    if (!d) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = moved(mask, handle, d[0], d[1]);
    if (valid(next)) {
      onCommit(next);
    }
  };

  const pct = (value: number) => `${value * 100}%`;
  const inner = $derived(1 - mask.feather / 100);
</script>

<div
  class={['ed-mask-layer', mask.invert && 'inverted']}
  bind:this={layer}
  aria-label={$t('frameleaf_editor_mask_handles')}
>
  {#if mask.kind === AssetDevelopMaskKind.Radial}
    <div
      class="ed-mask-ellipse"
      style="left:{pct(mask.x - mask.radiusX)};top:{pct(mask.y - mask.radiusY)};width:{pct(
        mask.radiusX * 2,
      )};height:{pct(mask.radiusY * 2)}"
    >
      {#if inner > 0 && inner < 1}
        <div class="ed-mask-ellipse feather" style="inset:{((1 - inner) / 2) * 100}%"></div>
      {/if}
    </div>
    <button
      type="button"
      class="ed-mask-handle fl-no-press centre"
      style="left:{pct(mask.x)};top:{pct(mask.y)}"
      aria-label={$t('frameleaf_editor_mask_move')}
      onpointerdown={beginDrag('centre')}
      onkeydown={nudge('centre')}
    ></button>
    <button
      type="button"
      class="ed-mask-handle fl-no-press"
      style="left:{pct(mask.x + mask.radiusX)};top:{pct(mask.y)}"
      aria-label={$t('frameleaf_editor_mask_width')}
      onpointerdown={beginDrag('radiusX')}
      onkeydown={nudge('radiusX')}
    ></button>
    <button
      type="button"
      class="ed-mask-handle fl-no-press"
      style="left:{pct(mask.x)};top:{pct(mask.y + mask.radiusY)}"
      aria-label={$t('frameleaf_editor_mask_height')}
      onpointerdown={beginDrag('radiusY')}
      onkeydown={nudge('radiusY')}
    ></button>
  {:else}
    <svg class="ed-mask-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1={mask.x * 100} y1={mask.y * 100} x2={mask.endX * 100} y2={mask.endY * 100} />
    </svg>
    <button
      type="button"
      class="ed-mask-handle fl-no-press centre"
      style="left:{pct(mask.x)};top:{pct(mask.y)}"
      aria-label={$t('frameleaf_editor_mask_start')}
      onpointerdown={beginDrag('start')}
      onkeydown={nudge('start')}
    ></button>
    <button
      type="button"
      class="ed-mask-handle fl-no-press"
      style="left:{pct(mask.endX)};top:{pct(mask.endY)}"
      aria-label={$t('frameleaf_editor_mask_end')}
      onpointerdown={beginDrag('end')}
      onkeydown={nudge('end')}
    ></button>
  {/if}
</div>
