<script lang="ts">
  /**
   * The photo in the RAW develop editor (FL-420, PhotographyEditor.jsx stage): the server's rendered
   * preview fitted or zoomed, with the crop frame and the selected mask drawn over it, and the pointer
   * gestures that make a crop, place a radial or gradient mask, or paint brush strokes.
   *
   * Coordinates are fractions of the image on screen. With the crop tool open that image is the whole
   * frame (the crop is left out of its preview); on the Masks tab it is the whole sensor image, the
   * space native masks are stored in.
   */
  import { t } from 'svelte-i18n';
  import type { NativeMask } from '$lib/frameleaf/native-develop';
  import { nativeStrokeOverlay } from '$lib/frameleaf/native-editor-state';
  import {
    FULL_FRAME,
    MAX_STROKE_POINTS,
    histogram,
    isPainted,
    isSuggested,
    normalizeCrop,
    type CropRect,
    type Histogram,
  } from '$lib/frameleaf/raw-develop';
  import type { DevelopTools } from '$lib/frameleaf/raw-develop-session.svelte';

  type Stroke = NonNullable<NativeMask['strokes']>[number];
  type Draft =
    | { kind: 'crop'; start: [number, number]; rect: CropRect }
    | { kind: 'place'; start: [number, number]; mask: NativeMask }
    | { kind: 'stroke'; stroke: Stroke };

  let {
    src,
    placeholder,
    alt,
    busy,
    mode,
    crop,
    masks,
    tools,
    onCrop,
    onMask,
    onHistogram,
  }: {
    src: string | null;
    placeholder: string;
    alt: string;
    busy: boolean;
    mode: 'develop' | 'masks' | 'crop';
    crop: CropRect | undefined;
    masks: NativeMask[];
    tools: DevelopTools;
    onCrop: (rect: CropRect) => void;
    onMask: (mask: NativeMask) => void;
    onHistogram: (bins: Histogram | null) => void;
  } = $props();

  const uid = $props.id();
  let stageWidth = $state(800);
  let stageHeight = $state(600);
  let natural = $state({ width: 3, height: 2 });
  let draft = $state<Draft | null>(null);
  let pointerId: number | null = null;

  const shown = $derived(src ?? placeholder);
  const active = $derived(
    mode === 'masks' ? (masks.find((mask) => mask.id === tools.maskId) ?? masks.at(-1)) : undefined,
  );
  const ratio = $derived(natural.width / natural.height);
  const fitWidth = $derived(Math.max(80, Math.min(stageWidth - 48, (stageHeight - 48) * ratio)));
  const frameWidth = $derived(tools.zoom === 'fit' ? fitWidth : (natural.width * Number(tools.zoom)) / 100);
  const frameHeight = $derived(frameWidth / ratio);
  const interactive = $derived(
    !tools.compare &&
      (mode === 'crop' || (mode === 'masks' && !!active && (active.enabled || active.kind === 'brush'))),
  );
  const shownCrop = $derived(draft?.kind === 'crop' ? draft.rect : (crop ?? FULL_FRAME));
  const shownMask = $derived(draft?.kind === 'place' ? draft.mask : active);
  const strokes = $derived([
    ...(shownMask && isPainted(shownMask.kind) ? (shownMask.strokes ?? []) : []),
    ...(draft?.kind === 'stroke' ? [draft.stroke] : []),
  ]);
  const W = $derived(natural.width);
  const H = $derived(natural.height);
  const colour = $derived(shownMask && isSuggested(shownMask.kind) ? '#818cf8' : '#72ba95');

  const hint = $derived(
    tools.compare
      ? null
      : mode === 'crop'
        ? $t('frameleaf_develop_hint_crop')
        : mode === 'masks' && active
          ? tools.gesture === 'place' && active.kind === 'radial'
            ? $t('frameleaf_develop_hint_radial')
            : tools.gesture === 'place' && active.kind === 'linear'
              ? $t('frameleaf_develop_hint_gradient')
              : tools.brushMode === 'subtract'
                ? $t('frameleaf_develop_hint_subtract')
                : $t('frameleaf_develop_hint_add')
          : null,
  );

  function point(event: PointerEvent): [number, number] {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width))),
      Math.min(1, Math.max(0, (event.clientY - box.top) / Math.max(1, box.height))),
    ];
  }

  function down(event: PointerEvent) {
    if (!interactive || event.button !== 0) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    pointerId = event.pointerId;
    const start = point(event);
    if (mode === 'crop') {
      draft = { kind: 'crop', start, rect: shownCrop };
    } else if (active && tools.gesture === 'place' && (active.kind === 'radial' || active.kind === 'linear')) {
      draft = { kind: 'place', start, mask: { ...active } };
    } else if (active && isPainted(active.kind)) {
      draft = {
        kind: 'stroke',
        stroke: {
          points: [start],
          radius: Math.max(0.001, tools.brushSize / 2),
          erase: tools.brushMode === 'subtract',
        },
      };
    }
  }

  function move(event: PointerEvent) {
    if (!draft || event.pointerId !== pointerId) {
      return;
    }
    const [x, y] = point(event);
    if (draft.kind === 'crop') {
      const [sx, sy] = draft.start;
      draft = {
        ...draft,
        rect: { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) },
      };
    } else if (draft.kind === 'place') {
      const [sx, sy] = draft.start;
      draft = {
        ...draft,
        mask:
          draft.mask.kind === 'radial'
            ? {
                ...draft.mask,
                x: sx,
                y: sy,
                radiusX: Math.max(0.02, Math.abs(x - sx)),
                radiusY: Math.max(0.02, Math.abs(y - sy)),
              }
            : { ...draft.mask, x: sx, y: sy, endX: x, endY: y },
      };
    } else if (draft.stroke.points.length < MAX_STROKE_POINTS) {
      draft = { ...draft, stroke: { ...draft.stroke, points: [...draft.stroke.points, [x, y]] } };
    }
  }

  function up(event: PointerEvent, cancelled = false) {
    if (!draft || event.pointerId !== pointerId) {
      return;
    }
    const done = draft;
    draft = null;
    pointerId = null;
    if (cancelled) {
      return;
    }
    if (done.kind === 'crop') {
      if (done.rect.w > 0.01 && done.rect.h > 0.01) {
        onCrop(normalizeCrop(done.rect));
      }
    } else if (done.kind === 'place') {
      const mask = done.mask;
      if (mask.kind === 'linear' && Math.hypot(mask.endX - mask.x, mask.endY - mask.y) < 0.01) {
        return;
      }
      onMask(mask);
    } else if (active) {
      onMask({ ...active, enabled: true, strokes: [...(active.strokes ?? []), done.stroke].slice(-64) });
    }
  }

  function loaded(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    if (image.naturalWidth && image.naturalHeight) {
      natural = { width: image.naturalWidth, height: image.naturalHeight };
    }
    if (!src) {
      onHistogram(null);
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 64;
      const context = canvas.getContext('2d');
      if (!context) {
        return;
      }
      context.drawImage(image, 0, 0, 96, 64);
      onHistogram(histogram(context.getImageData(0, 0, 96, 64).data));
    } catch {
      onHistogram(null);
    }
  }
</script>

<div class="rde-stage" bind:clientWidth={stageWidth} bind:clientHeight={stageHeight}>
  <div class="rde-stage-inner">
    <div class="rde-frame" style:width={`${frameWidth}px`} style:height={`${frameHeight}px`}>
      <img src={shown} {alt} draggable="false" onload={loaded} />
      <svg
        class="rde-overlay"
        class:enabled={interactive}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="presentation"
        onpointerdown={down}
        onpointermove={move}
        onpointerup={(event) => up(event)}
        onpointercancel={(event) => up(event, true)}
      >
        {#if mode === 'crop'}
          <path
            d={`M0 0H${W}V${H}H0Z M${shownCrop.x * W} ${shownCrop.y * H}h${shownCrop.w * W}v${shownCrop.h * H}h${-shownCrop.w * W}Z`}
            fill="black"
            fill-opacity="0.64"
            fill-rule="evenodd"
          />
          <rect
            x={shownCrop.x * W}
            y={shownCrop.y * H}
            width={shownCrop.w * W}
            height={shownCrop.h * H}
            fill="none"
            stroke="white"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
          />
          {#each [1, 2] as n (n)}
            <g stroke="white" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0.5">
              <path
                d={`M${(shownCrop.x + (shownCrop.w * n) / 3) * W} ${shownCrop.y * H}v${shownCrop.h * H}`}
                vector-effect="non-scaling-stroke"
              />
              <path
                d={`M${shownCrop.x * W} ${(shownCrop.y + (shownCrop.h * n) / 3) * H}h${shownCrop.w * W}`}
                vector-effect="non-scaling-stroke"
              />
            </g>
          {/each}
        {:else if mode === 'masks' && shownMask && !tools.compare}
          <defs>
            {#if shownMask.kind === 'linear'}<linearGradient
                id={`${uid}-gradient`}
                gradientUnits="userSpaceOnUse"
                x1={shownMask.x * W}
                y1={shownMask.y * H}
                x2={shownMask.endX * W}
                y2={shownMask.endY * H}
                ><stop offset="0" stop-color={shownMask.invert ? 'black' : 'white'} /><stop
                  offset="1"
                  stop-color={shownMask.invert ? 'white' : 'black'}
                /></linearGradient
              >{/if}
            <mask id={`${uid}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width={W} height={H}>
              <rect width={W} height={H} fill={shownMask.invert && shownMask.kind !== 'linear' ? 'white' : 'black'} />
              {#if shownMask.kind === 'radial'}<ellipse
                  cx={shownMask.x * W}
                  cy={shownMask.y * H}
                  rx={shownMask.radiusX * W}
                  ry={shownMask.radiusY * H}
                  fill={shownMask.invert ? 'black' : 'white'}
                />{:else if shownMask.kind === 'linear'}<rect
                  width={W}
                  height={H}
                  fill={`url(#${uid}-gradient)`}
                />{/if}
              {#each strokes as stroke, index (index)}
                {@const drawn = nativeStrokeOverlay(stroke, W, H)}
                {#if stroke.points.length === 1}<circle
                    cx={drawn.first.x}
                    cy={drawn.first.y}
                    r={drawn.radius}
                    fill={stroke.erase !== shownMask.invert ? 'black' : 'white'}
                  />{:else}<polyline
                    points={drawn.points}
                    fill="none"
                    stroke={stroke.erase !== shownMask.invert ? 'black' : 'white'}
                    stroke-width={drawn.radius * 2}
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />{/if}
              {/each}
            </mask>
          </defs>
          {#if tools.overlay}<rect width={W} height={H} fill={colour} opacity="0.4" mask={`url(#${uid}-mask)`} />{/if}
          {#if shownMask.kind === 'radial'}<ellipse
              cx={shownMask.x * W}
              cy={shownMask.y * H}
              rx={shownMask.radiusX * W}
              ry={shownMask.radiusY * H}
              fill="none"
              stroke="white"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
            />{:else if shownMask.kind === 'linear'}<path
              d={`M${shownMask.x * W} ${shownMask.y * H}L${shownMask.endX * W} ${shownMask.endY * H}`}
              stroke="white"
              stroke-width="1.5"
              stroke-dasharray="4 4"
              vector-effect="non-scaling-stroke"
            />{/if}
        {/if}
      </svg>
    </div>
  </div>
  <div class="rde-stage-chips">
    <span>
      {#if tools.compare}<span class="rde-chip">{$t('frameleaf_develop_original')}</span>{:else if hint}<span
          class="rde-chip">{hint}</span
        >{/if}
    </span>
    {#if busy || !src}<span class="rde-chip" role="status">{$t('frameleaf_develop_rendering_preview')}</span>{/if}
  </div>
</div>
