<script lang="ts">
  /**
   * FL-563: the framing of a vertical or square export, from the owner-approved mock
   * (`frameleaf-prototype` `src/StudioUpgrades.jsx` `ReframePreview`, `src/studio-upgrades.css` `.flu-reframe`).
   *
   * The current shot with the crop box and a dot where the subject is, the area outside the box dimmed;
   * how the shot will look at the export size; a slider through the shot, so the box can be seen
   * following the subject; and a strip of every shot with its crop. Drag the box sideways, or focus it
   * and use the arrow keys (Shift moves further), to move a shot's framing; the move applies to the
   * whole shot. Back to automatic undoes it.
   */
  import { t } from 'svelte-i18n';
  import {
    AssetMediaSize,
    StudioExportShape,
    StudioReframeSubject,
    type StudioReframeResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowLeftRight, mdiRestore } from '@mdi/js';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    REFRAME_STEP,
    REFRAME_STEP_LARGE,
    cropCentreAt,
    cropShare,
    isMoved,
    limitNudge,
    pathAt,
    sizeLabel,
  } from '$lib/frameleaf/studio/reframe';
  import { getAssetMediaUrl } from '$lib/utils';

  let {
    framing,
    shape,
    size,
    nudges = $bindable({}),
  }: {
    framing: StudioReframeResponseDto;
    shape: StudioExportShape;
    /** The exported file's size, shown on the preview. */
    size: { width: number; height: number } | null;
    /** The person's move of each shot, as a share of the frame width. */
    nudges?: Record<string, number>;
  } = $props();

  const shots = $derived(framing.shots);
  let shotId = $state<string | null>(null);
  let progress = $state(0.5);
  let frameElement = $state<HTMLDivElement>();

  const shot = $derived(shots.find((item) => item.clipId === shotId) ?? shots[0]);
  const index = $derived(shot ? shots.indexOf(shot) : -1);
  const frame = $derived({ width: framing.width, height: framing.height });
  const share = $derived(cropShare(shape, frame));
  const nudge = $derived(shot ? (nudges[shot.clipId] ?? 0) : 0);
  const centre = $derived(shot ? cropCentreAt(shot.path, progress, nudge, share) : 0.5);
  const subject = $derived(shot ? pathAt(shot.path, progress) : 0.5);
  const moved = $derived(isMoved(nudge));
  const left = $derived(centre - share / 2);
  /** Where the crop sits in the picture, for the preview's `object-position`. */
  const outPosition = $derived(`${share >= 1 ? 50 : ((left / (1 - share)) * 100).toFixed(1)}% 50%`);

  const thumbnail = (assetId: string | null) =>
    assetId ? getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Preview }) : null;

  const setNudge = (clipId: string, value: number) => {
    nudges = { ...nudges, [clipId]: limitNudge(value) };
  };

  const onPointerDown = (event: PointerEvent) => {
    const rect = frameElement?.getBoundingClientRect();
    if (!shot || !rect || rect.width === 0) {
      return;
    }
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    const clipId = shot.clipId;
    const startX = event.clientX;
    const start = nudges[clipId] ?? 0;
    const move = (moveEvent: PointerEvent) => setNudge(clipId, start + (moveEvent.clientX - startX) / rect.width);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!shot || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = (event.shiftKey ? REFRAME_STEP_LARGE : REFRAME_STEP) * (event.key === 'ArrowLeft' ? -1 : 1);
    setNudge(shot.clipId, (nudges[shot.clipId] ?? 0) + step);
  };

  const shapeLabel = $derived(
    shape === StudioExportShape.Square
      ? $t('frameleaf_studio_export_shape_square')
      : $t('frameleaf_studio_export_shape_vertical'),
  );
</script>

{#if shot}
  <div class="reframe" data-testid="studio-export-reframe">
    <div class="main">
      <div
        class="frame"
        bind:this={frameElement}
        style:aspect-ratio="{frame.width} / {frame.height}"
        data-testid="studio-reframe-frame"
      >
        {#if thumbnail(shot.assetId)}
          <img src={thumbnail(shot.assetId)} alt="" draggable="false" />
        {/if}
        <span class="shade" style:left="0" style:width="{left * 100}%"></span>
        <span class="shade" style:left="{(centre + share / 2) * 100}%" style:right="0"></span>
        <span
          class="box"
          role="slider"
          tabindex="0"
          aria-label={$t('frameleaf_studio_reframe_box', { values: { number: index + 1 } })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(centre * 100)}
          style:left="{left * 100}%"
          style:width="{share * 100}%"
          onpointerdown={onPointerDown}
          onkeydown={onKeyDown}
          data-testid="studio-reframe-box"
        >
          <Icon icon={mdiArrowLeftRight} size="18" aria-hidden={true} />
        </span>
        {#if shot.subject === StudioReframeSubject.Face}
          <span class="subject" style:left="{subject * 100}%" aria-hidden="true"></span>
        {/if}
      </div>
      <div
        class="out"
        class:square={shape === StudioExportShape.Square}
        role="img"
        aria-label={$t('frameleaf_studio_reframe_out')}
      >
        {#if thumbnail(shot.assetId)}
          <img src={thumbnail(shot.assetId)} alt="" style:object-position={outPosition} draggable="false" />
        {/if}
        {#if size}
          <span>{sizeLabel(size)}</span>
        {/if}
      </div>
    </div>

    <label class="scrub">
      <span>
        {$t('frameleaf_studio_reframe_shot', { values: { number: index + 1, count: shots.length } })} ·
        {shot.subject === StudioReframeSubject.Face
          ? $t('frameleaf_studio_reframe_follows_face')
          : $t('frameleaf_studio_reframe_centred')}
      </span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        bind:value={progress}
        aria-label={$t('frameleaf_studio_reframe_scrub')}
      />
    </label>

    <div class="shots" role="listbox" aria-label={$t('frameleaf_studio_reframe_shots')}>
      {#each shots as item, number (item.clipId)}
        {@const crop = cropCentreAt(item.path, 0.5, nudges[item.clipId] ?? 0, share)}
        <button
          type="button"
          role="option"
          aria-selected={item.clipId === shot.clipId}
          class="shot"
          class:on={item.clipId === shot.clipId}
          onclick={() => {
            shotId = item.clipId;
            progress = 0.5;
          }}
        >
          <span class="thumb">
            {#if thumbnail(item.assetId)}
              <img src={thumbnail(item.assetId)} alt="" draggable="false" />
            {/if}
            <i style:left="{(crop - share / 2) * 100}%" style:width="{share * 100}%"></i>
          </span>
          <small>
            {number + 1}{isMoved(nudges[item.clipId]) ? ` · ${$t('frameleaf_studio_reframe_moved')}` : ''}
          </small>
        </button>
      {/each}
    </div>

    <div class="foot">
      <span class="muted" role="status">
        {moved ? $t('frameleaf_studio_reframe_note_moved') : $t('frameleaf_studio_reframe_note_auto')}
      </span>
      <Button disabled={!moved} onclick={() => setNudge(shot.clipId, 0)}>
        <Icon icon={mdiRestore} size="16" aria-hidden={true} />
        {$t('frameleaf_studio_reframe_automatic')}
      </Button>
    </div>
    <p class="muted titles">{$t('frameleaf_studio_reframe_titles', { values: { shape: shapeLabel } })}</p>
  </div>
{/if}

<style>
  /* studio-upgrades.css `.flu-reframe` */
  .reframe {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--fl-border);
  }
  .main {
    display: grid;
    grid-template-columns: minmax(0, 560px) auto;
    justify-content: start;
    align-items: center;
    gap: 24px;
  }
  .frame {
    position: relative;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    background: #000;
    touch-action: none;
  }
  .frame img,
  .out img,
  .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    user-select: none;
  }
  .frame img {
    object-fit: contain;
  }
  .shade {
    position: absolute;
    top: 0;
    bottom: 0;
    background: #000a;
    pointer-events: none;
  }
  .box {
    position: absolute;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 12px;
    border: 2px solid #fff;
    border-radius: 4px;
    box-shadow: 0 0 0 1px #0006;
    color: #fff;
    cursor: grab;
  }
  .box :global(svg) {
    width: 30px;
    height: 30px;
    padding: 4px;
    border-radius: 50%;
    background: #0008;
  }
  .box:active {
    cursor: grabbing;
  }
  .box:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .subject {
    position: absolute;
    top: 38%;
    width: 14px;
    height: 14px;
    margin-left: -7px; /* rtl: physical (centres on the image-space left) */
    border: 2px solid #fff;
    border-radius: 50%;
    background: color-mix(in srgb, var(--fl-accent) 70%, transparent);
    pointer-events: none;
  }
  .out {
    position: relative;
    height: 300px;
    aspect-ratio: 9 / 16;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    background: #000;
    box-shadow: var(--fl-shadow-1);
  }
  .out.square {
    aspect-ratio: 1;
  }
  .out img {
    object-fit: cover;
  }
  .out span {
    position: absolute;
    left: 8px;
    bottom: 8px;
    padding: 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: #0009;
    color: #fff;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .scrub {
    display: grid;
    gap: 8px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .scrub input {
    width: 100%;
    margin: 0;
  }
  .shots {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 2px 2px 4px;
  }
  .shot {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .shot.on {
    color: var(--fl-text);
  }
  .thumb {
    position: relative;
    width: 80px;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 5px;
    outline: 2px solid transparent;
    outline-offset: 1px;
    background: #000;
  }
  .shot.on .thumb {
    outline-color: var(--fl-accent);
  }
  .thumb img {
    object-fit: cover;
    opacity: 0.55;
  }
  .thumb i {
    position: absolute;
    top: 0;
    bottom: 0;
    border: 1.5px solid #fff;
    border-radius: 2px;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .muted {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .titles {
    margin: 0;
  }
  @media (max-width: 720px) {
    .main {
      grid-template-columns: minmax(0, 1fr);
      justify-items: center;
    }
    .frame {
      width: 100%;
    }
    .out {
      height: 220px;
    }
  }
</style>
