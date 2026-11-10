<script lang="ts">
  /**
   * The picture with its Boards annotations on top (FL-652, approved prototype `AnnotatedImage`).
   * The drawing is measured in screen pixels, so lines, numbers and text keep their size at any
   * preview size. In the viewer's annotate mode every annotation is focusable, in list order and
   * with the list's number; in the details panel the list beside it is the way in, so the drawing
   * is hidden from screen readers.
   *
   * FL-1359: text can carry a style: a font from Boards, a size, a colour and a variable font's
   * axis values. A font that cannot be loaded (removed, or a shared link without downloads) leaves
   * the text in the standard font.
   */
  import { loadBoardsFont, variationCss } from '$lib/frameleaf/boards-fonts';
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

  /** CSS family names of the Boards fonts loaded so far, by font item. */
  let families = $state<Record<string, string>>({});
  /** Each font is asked for once: one that cannot be loaded is not asked for again on every edit. */
  const asked = new Set<string>();
  $effect(() => {
    for (const id of new Set(items.flatMap((item) => item.style?.fontAssetId ?? []))) {
      if (!asked.has(id)) {
        asked.add(id);
        void loadBoardsFont(id)
          .then((family) => (families[id] = family))
          .catch(() => {});
      }
    }
  });

  let measure: CanvasRenderingContext2D | null | undefined;
  const textWidth = (label: string, size: number, family?: string, weight = 400) => {
    if (family) {
      try {
        measure ??= document.createElement('canvas').getContext('2d');
        if (measure) {
          measure.font = `${size}px "${family}"`;
          // ponytail: canvas measures the font at its default weight, so heavier variable weights
          // get an allowance; measure the drawn text instead if labels ever clip.
          return measure.measureText(label).width * (1 + Math.max(0, weight - 400) / 2500) + size;
        }
      } catch {
        // no canvas here: estimate below
      }
    }
    return label.length * size * 0.56 + size;
  };
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
        {@const style = item.kind === AssetAnnotationKind.Text ? item.style : undefined}
        {@const size = FONT * (style?.size ?? 1)}
        {@const family = style?.fontAssetId ? families[style.fontAssetId] : undefined}
        {@const badgeY = item.kind === AssetAnnotationKind.Text ? y - size * 1.2 : y}
        {#snippet body()}
          {#if item.kind === AssetAnnotationKind.Rect}
            <rect {x} {y} width={(g.width ?? 0) * width} height={(g.height ?? 0) * height} rx={STROKE} />
          {:else if item.kind === AssetAnnotationKind.Arrow}
            {@const x2 = (g.endX ?? g.x) * width}
            {@const y2 = (g.endY ?? g.y) * height}
            <line x1={x} y1={y} {x2} {y2} />
            <polygon points={arrowHead(x, y, x2, y2, STROKE * 5)} class="head" />
          {:else}
            <rect
              {x}
              y={y - size * 1.2}
              width={textWidth(label, size, family, style?.variation?.wght)}
              height={size * 1.6}
              rx={STROKE}
              class="label"
            />
            <text
              x={x + size * 0.5}
              {y}
              font-size={size}
              style:font-family={family ? `"${family}"` : undefined}
              style:font-weight={family ? 'normal' : undefined}
              style:font-variation-settings={family ? variationCss(style?.variation) : undefined}>{label}</text
            >
          {/if}
        {/snippet}
        <g
          class="ann {item.kind}"
          class:on={selected === item.id}
          class:coloured={!!style?.color}
          style:--ann-colour={style?.color}
        >
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
  .ann.coloured.text .line > :global(text) {
    fill: var(--ann-colour);
  }
  .ann.coloured.text .line > :global(.label) {
    stroke: var(--ann-colour);
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
