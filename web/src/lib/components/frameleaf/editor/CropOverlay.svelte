<script lang="ts">
  /**
   * The draggable crop rectangle over the stage (FL-113). Eight handles resize it, the body
   * moves it, and with the group focused the arrow keys nudge it (Shift moves further). The
   * geometry lives in `$lib/frameleaf/develop`; this component only translates pointer and key
   * events into normalized deltas and reports the committed rectangle.
   */
  import { CROP_HANDLES, resizeCropRect, type CropHandle, type CropRect } from '$lib/frameleaf/develop';
  import { t } from 'svelte-i18n';

  let {
    rect,
    frame,
    ratio,
    sourceWidth,
    sourceHeight,
    aspectLabel,
    onPreview,
    onCommit,
    onDragging,
  }: {
    rect: CropRect;
    /** The drawn frame in stage pixels: its size and its top-left offset inside the stage. */
    frame: { width: number; height: number; left: number; top: number };
    ratio: number | null;
    /** Source pixel size of the oriented frame, for the size read-out. */
    sourceWidth: number;
    sourceHeight: number;
    aspectLabel?: string;
    /** Live rectangle while dragging, or null when the drag ends. */
    onPreview: (rect: CropRect | null) => void;
    onCommit: (rect: CropRect) => void;
    onDragging?: (dragging: boolean) => void;
  } = $props();

  const same = (a: CropRect, b: CropRect) => JSON.stringify(a) === JSON.stringify(b);

  const beginDrag = (handle: CropHandle) => (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const origin = { x: event.clientX, y: event.clientY };
    const start = rect;
    let latest = start;
    const pointerId = event.pointerId;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // capture is best effort
    }
    onDragging?.(true);
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      const dx = (e.clientX - origin.x) / frame.width;
      const dy = (e.clientY - origin.y) / frame.height;
      latest = resizeCropRect(start, handle, dx, dy, { ratio, frameWidth: frame.width, frameHeight: frame.height });
      onPreview(latest);
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      try {
        target.releasePointerCapture(pointerId);
      } catch {
        // already released
      }
      onDragging?.(false);
      onPreview(null);
      if (!same(latest, start)) {
        onCommit(latest);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  const nudge = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) {
      return;
    }
    event.preventDefault();
    onCommit(resizeCropRect(rect, 'move', move[0], move[1]));
  };

  const handlePosition = (handle: string) => {
    const left = handle.includes('w') ? '0' : handle.includes('e') ? '100%' : '50%';
    const top = handle.includes('n') ? '0' : handle.includes('s') ? '100%' : '50%';
    return `left:${left};top:${top}`;
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="ed-crop"
  role="group"
  tabindex="0"
  aria-label={$t('frameleaf_editor_crop_area_label')}
  style="left:{frame.left + rect.x * frame.width}px;top:{frame.top + rect.y * frame.height}px;width:{rect.w *
    frame.width}px;height:{rect.h * frame.height}px"
  onpointerdown={beginDrag('move')}
  onkeydown={nudge}
>
  {#each CROP_HANDLES as handle (handle)}
    <span class="ed-handle {handle}" aria-hidden="true" style={handlePosition(handle)} onpointerdown={beginDrag(handle)}
    ></span>
  {/each}
  <span class="ed-crop-size" aria-hidden="true">
    {Math.round(rect.w * sourceWidth)} × {Math.round(rect.h * sourceHeight)}{aspectLabel ? ` · ${aspectLabel}` : ''}
  </span>
</div>
