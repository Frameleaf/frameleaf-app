<script lang="ts">
  /**
   * The picture with its Boards annotations on top (FL-652, approved prototype `AnnotatedImage`).
   * The drawing is measured in screen pixels, so lines, numbers and text keep their size at any
   * preview size. In the viewer's annotate mode every annotation is focusable, in list order and
   * with the list's number; in the details panel the list beside it is the way in, so the drawing
   * is hidden from screen readers.
   */
  import { arrowHead, createAnnotation, type AnnotationTool, type Point } from '$lib/frameleaf/boards-annotations';
  import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    src: string;
    /** The picture's name, read out in the viewer. */
    name: string;
    items: AssetAnnotationItem[];
    show?: boolean;
    selected?: string | null;
    interactive?: boolean;
    tool?: AnnotationTool;
    /** Screen-reader label for the annotation at `index`. */
    labelFor?: (item: AssetAnnotationItem, index: number) => string;
    onSelect?: (id: string | null) => void;
    onDraw?: (item: AssetAnnotationItem) => void;
    /** Moves by a fraction of the picture while dragging; `end` once the drag lets go. */
    onMove?: (id: string, dx: number, dy: number, end: boolean) => void;
    onKey?: (event: KeyboardEvent, id: string) => void;
    /** Limits the picture's height, for the details panel. */
    maxHeight?: string;
  };

  let {
    src,
    name,
    items,
    show = true,
    selected = null,
    interactive = false,
    tool = 'select',
    labelFor,
    onSelect,
    onDraw,
    onMove,
    onKey,
    maxHeight,
  }: Props = $props();

  let width = $state(0);
  let height = $state(0);
  let svg = $state<SVGSVGElement>();
  let draft = $state<AssetAnnotationItem | null>(null);
  let drag: { kind: 'draw'; start: Point } | { kind: 'move'; id: string; last: Point } | null = null;

  const STROKE = 2.5;
  const BADGE = 10;
  const FONT = 13;
  const defaultText = $derived($t('frameleaf_boards_annotate_text'));

  const at = (event: PointerEvent): Point => {
    const box = svg!.getBoundingClientRect();
    return {
      x: box.width ? (event.clientX - box.left) / box.width : 0,
      y: box.height ? (event.clientY - box.top) / box.height : 0,
    };
  };

  const drawing = $derived(interactive && tool !== 'select');
  const shown = $derived(draft ? [...items, draft] : items);

  const onPointerDown = (event: PointerEvent) => {
    if (!interactive) {
      return;
    }
    if (tool === 'select') {
      if (event.target === svg) {
        onSelect?.(null);
      }
      return;
    }
    event.preventDefault();
    svg?.setPointerCapture?.(event.pointerId);
    const start = at(event);
    drag = { kind: 'draw', start };
    draft = createAnnotation(tool, start, tool === AssetAnnotationKind.Text ? null : start, 'draft', defaultText);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) {
      return;
    }
    const point = at(event);
    if (drag.kind === 'draw' && tool !== 'select' && tool !== AssetAnnotationKind.Text) {
      draft = createAnnotation(tool, drag.start, point, 'draft', defaultText);
    } else if (drag.kind === 'move') {
      onMove?.(drag.id, point.x - drag.last.x, point.y - drag.last.y, false);
      drag.last = point;
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (drag?.kind === 'draw' && tool !== 'select') {
      onDraw?.(
        createAnnotation(tool, drag.start, tool === AssetAnnotationKind.Text ? null : at(event), 'new', defaultText),
      );
    } else if (drag?.kind === 'move') {
      onMove?.(drag.id, 0, 0, true);
    }
    drag = null;
    draft = null;
  };

  /** The browser took the pointer away: settle a move where it stands, and drop an unfinished drawing. */
  const onPointerCancel = () => {
    if (drag?.kind === 'move') {
      onMove?.(drag.id, 0, 0, true);
    }
    drag = null;
    draft = null;
  };

  // Hiding the drawing mid-gesture removes the layer before its pointerup, so end the gesture here.
  $effect(() => {
    if (!show) {
      untrack(onPointerCancel);
    }
  });

  const startMove = (event: PointerEvent, id: string) => {
    if (tool !== 'select') {
      return;
    }
    event.stopPropagation();
    svg?.setPointerCapture?.(event.pointerId);
    onSelect?.(id);
    drag = { kind: 'move', id, last: at(event) };
  };

  const textWidth = (label: string) => label.length * FONT * 0.56 + FONT;
</script>

<div
  class="annotated"
  class:interactive
  class:drawing
  style:--max-height={maxHeight}
  bind:clientWidth={width}
  bind:clientHeight={height}
  data-testid="boards-annotated-image"
>
  <img {src} alt={interactive ? name : ''} draggable="false" />
  {#if show}
    <svg
      bind:this={svg}
      viewBox="0 0 {Math.max(width, 1)} {Math.max(height, 1)}"
      aria-hidden={interactive ? undefined : 'true'}
      role={interactive ? 'group' : undefined}
      aria-label={interactive ? $t('frameleaf_boards_annotations_on', { values: { name } }) : undefined}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerCancel}
    >
      {#snippet shape(item: AssetAnnotationItem, index: number)}
        {@const g = item.geometry}
        {@const x = g.x * width}
        {@const y = g.y * height}
        {@const label = item.text || defaultText}
        {@const badgeY = item.kind === AssetAnnotationKind.Text ? y - FONT * 1.2 : y}
        {#snippet body()}
          {#if item.kind === AssetAnnotationKind.Rect}
            <rect {x} {y} width={(g.width ?? 0) * width} height={(g.height ?? 0) * height} rx={STROKE} />
          {:else if item.kind === AssetAnnotationKind.Arrow}
            {@const x2 = (g.endX ?? g.x) * width}
            {@const y2 = (g.endY ?? g.y) * height}
            <line x1={x} y1={y} {x2} {y2} />
            <polygon points={arrowHead(x, y, x2, y2, STROKE * 5)} class="head" />
          {:else}
            <rect {x} y={y - FONT * 1.2} width={textWidth(label)} height={FONT * 1.6} rx={STROKE} class="label" />
            <text x={x + FONT * 0.5} {y} font-size={FONT}>{label}</text>
          {/if}
        {/snippet}
        <g class="ann {item.kind}" class:on={selected === item.id}>
          <g class="halo">{@render body()}</g>
          <g class="line">{@render body()}</g>
          <circle cx={x} cy={badgeY} r={BADGE} class="badge" />
          <text {x} y={badgeY} dy="0.35em" text-anchor="middle" font-size={BADGE * 1.1} class="badge-text"
            >{index + 1}</text
          >
        </g>
      {/snippet}
      {#each shown as item, index (item.id)}
        {#if interactive && item.id !== 'draft'}
          <g
            tabindex="0"
            role="button"
            aria-pressed={selected === item.id}
            aria-label={labelFor?.(item, index)}
            data-annotation={item.id}
            onfocus={() => onSelect?.(item.id)}
            onkeydown={(event) => onKey?.(event, item.id)}
            onpointerdown={(event) => startMove(event, item.id)}
          >
            {@render shape(item, index)}
          </g>
        {:else}
          {@render shape(item, index)}
        {/if}
      {/each}
    </svg>
  {/if}
</div>

<style>
  .annotated {
    position: relative;
    display: inline-block;
    max-width: 100%;
    line-height: 0;
  }
  img {
    display: block;
    max-width: 100%;
    max-height: var(--max-height, none);
    user-select: none;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    touch-action: none;
  }
  .drawing svg {
    cursor: crosshair;
  }
  /* Warning amber with a dark edge so it shows on light and dark pictures; the chosen one turns accent green. */
  .ann .halo > :global(*) {
    fill: none;
    stroke: rgb(0 0 0 / 0.55);
    stroke-width: 6px;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .ann .line > :global(*) {
    fill: none;
    stroke: var(--fl-warning);
    stroke-width: 2.5px;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .ann .line > :global(.head) {
    fill: var(--fl-warning);
  }
  .ann .halo > :global(.head) {
    fill: rgb(0 0 0 / 0.55);
  }
  .ann.text .line > :global(.label) {
    fill: rgb(0 0 0 / 0.72);
    stroke: var(--fl-warning);
  }
  .ann.text .line > :global(text) {
    fill: var(--fl-warning);
    stroke: none;
    font-weight: 600;
  }
  .ann.text .halo > :global(text) {
    fill: none;
  }
  .badge {
    fill: var(--fl-warning);
    stroke: rgb(0 0 0 / 0.55);
    stroke-width: 2px;
  }
  .badge-text {
    fill: #111;
    font-weight: 700;
  }
  .ann.on .line > :global(*),
  .ann.on.text .line > :global(.label) {
    stroke: var(--fl-accent);
  }
  .ann.on .line > :global(.head),
  .ann.on .badge,
  .ann.on.text .line > :global(text) {
    fill: var(--fl-accent);
  }
  g[tabindex] {
    outline: none;
    cursor: move;
  }
  g[tabindex]:focus-visible .halo > :global(*) {
    stroke: var(--fl-text);
  }
  .drawing g[tabindex] {
    cursor: crosshair;
  }
</style>
