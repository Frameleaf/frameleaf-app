<script lang="ts">
  /**
   * Before-and-after split for a restoration (FL-115), ported from the prototype's `RestoreCompare`.
   *
   * The prototype faked the "after" side with a CSS sharpen filter. Here both sides are real files
   * the server produced: the preview input and the restored preview, or the original and the
   * finished result. For video the two clips play in step: the after side owns playback and the
   * before side follows its seeks, plays and pauses, so a comparison never drifts.
   *
   * The loupe (prototype `RestoreCompare`, `Studio.jsx:1517-1567`, `.fls-loupe` in `studio.css`) is
   * a round magnifier that follows the pointer. The prototype magnified a CSS-filtered frame; here it
   * draws the real pixels, at 100%, from whichever side of the divider the pointer is on.
   */
  import { t } from 'svelte-i18n';

  type Props = {
    before: string;
    after: string;
    isVideo: boolean;
    beforeLabel: string;
    afterLabel: string;
    alt: string;
    /** Show the 100% magnifier under the pointer. */
    loupe?: boolean;
  };

  let { before, after, isVideo, beforeLabel, afterLabel, alt, loupe = false }: Props = $props();

  /** Diameter of the loupe in CSS pixels (`.fls-loupe`: 140 px). */
  const LOUPE_SIZE = 140;
  let beforeImage = $state<HTMLImageElement>();
  let afterImage = $state<HTMLImageElement>();
  let loupeCanvas = $state<HTMLCanvasElement>();
  let pointer = $state<{ x: number; y: number } | null>(null);

  const mediaSize = (element: HTMLImageElement | HTMLVideoElement) =>
    element instanceof HTMLVideoElement
      ? { width: element.videoWidth, height: element.videoHeight }
      : { width: element.naturalWidth, height: element.naturalHeight };

  /** Draw the pixels under the pointer at 100% from the side of the divider it is on. */
  const drawLoupe = () => {
    const box = stageEl?.getBoundingClientRect();
    const context = loupeCanvas?.getContext('2d');
    if (!loupe || !pointer || !box || !context || !loupeCanvas) {
      return;
    }
    const onAfter = pointer.x / box.width >= split;
    const source = isVideo ? (onAfter ? afterVideo : beforeVideo) : onAfter ? afterImage : beforeImage;
    if (!source) {
      return;
    }
    const { width, height } = mediaSize(source);
    const ratio = window.devicePixelRatio || 1;
    loupeCanvas.width = LOUPE_SIZE * ratio;
    loupeCanvas.height = LOUPE_SIZE * ratio;
    context.fillStyle = '#000';
    context.fillRect(0, 0, loupeCanvas.width, loupeCanvas.height);
    if (!width || !height) {
      return;
    }
    // object-fit: contain — where the media sits inside the stage, and at what scale.
    const scale = Math.min(box.width / width, box.height / height);
    const left = (box.width - width * scale) / 2;
    const top = (box.height - height * scale) / 2;
    const mediaX = (pointer.x - left) / scale;
    const mediaY = (pointer.y - top) / scale;
    // 100%: one media pixel per device pixel of the loupe.
    const span = LOUPE_SIZE * ratio;
    try {
      context.drawImage(source, mediaX - span / 2, mediaY - span / 2, span, span, 0, 0, span, span);
    } catch {
      // A frame that is not decodable yet simply leaves the loupe dark.
    }
  };

  const track = (event: PointerEvent) => {
    if (!loupe || !stageEl) {
      return;
    }
    const box = stageEl.getBoundingClientRect();
    pointer = { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  $effect(() => {
    // Redraw when the pointer, the divider or the loupe itself changes; a playing video redraws per frame.
    void [pointer, split, loupe];
    drawLoupe();
    if (!loupe || !pointer || !isVideo) {
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      drawLoupe();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  });

  let split = $state(0.5);
  let stageEl = $state<HTMLDivElement>();
  let beforeVideo = $state<HTMLVideoElement>();
  let afterVideo = $state<HTMLVideoElement>();

  const clamp = (value: number) => Math.max(0.04, Math.min(0.96, value));

  const beginDrag = (event: PointerEvent) => {
    event.preventDefault();
    const box = stageEl?.getBoundingClientRect();
    if (!box) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId) {
        split = clamp((e.clientX - box.left) / box.width);
      }
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // best effort
    }
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  const onKey = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowLeft': {
        event.preventDefault();
        split = clamp(split - 0.02);

        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        split = clamp(split + 0.02);

        break;
      }
      case 'Home': {
        event.preventDefault();
        split = 0.04;

        break;
      }
      case 'End': {
        event.preventDefault();
        split = 0.96;

        break;
      }
      // No default
    }
  };

  /* Keep the before clip in step with the after clip. */
  const follow = () => {
    if (!beforeVideo || !afterVideo) {
      return;
    }
    if (Math.abs(beforeVideo.currentTime - afterVideo.currentTime) > 0.08) {
      beforeVideo.currentTime = afterVideo.currentTime;
    }
  };
  const followPlay = () => {
    follow();
    void beforeVideo?.play().catch(() => undefined);
  };
  const followPause = () => {
    beforeVideo?.pause();
    follow();
  };

  const afterClip = $derived(`inset(0 0 0 ${split * 100}%)`);
</script>

<div
  class="rc-stage"
  bind:this={stageEl}
  data-testid="restoration-compare"
  role="presentation"
  onpointermove={track}
  onpointerleave={() => (pointer = null)}
>
  {#if isVideo}
    <video
      class="rc-media"
      bind:this={beforeVideo}
      src={before}
      muted
      playsinline
      preload="metadata"
      aria-label={beforeLabel}
    ></video>
    <!-- svelte-ignore a11y_media_has_caption (a restoration render has no caption track to offer) -->
    <video
      class="rc-media rc-after"
      bind:this={afterVideo}
      src={after}
      controls
      playsinline
      preload="metadata"
      style="clip-path: {afterClip}"
      aria-label={afterLabel}
      onplay={followPlay}
      onpause={followPause}
      onseeked={follow}
      ontimeupdate={follow}
      onratechange={() => {
        if (beforeVideo && afterVideo) {
          beforeVideo.playbackRate = afterVideo.playbackRate;
        }
      }}
    ></video>
  {:else}
    <img class="rc-media" bind:this={beforeImage} src={before} alt={`${beforeLabel}: ${alt}`} draggable="false" />
    <img
      class="rc-media rc-after"
      bind:this={afterImage}
      src={after}
      alt={`${afterLabel}: ${alt}`}
      draggable="false"
      style="clip-path: {afterClip}"
    />
  {/if}

  <span class="ed-badge">{beforeLabel}</span>
  <span class="ed-badge right">{afterLabel}</span>

  <button
    type="button"
    class="ed-divider"
    role="slider"
    aria-label={$t('frameleaf_restoration_compare_divider')}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(split * 100)}
    style="left:{split * 100}%"
    onpointerdown={beginDrag}
    onkeydown={onKey}
  ></button>

  {#if loupe && pointer}
    <div
      class="rc-loupe"
      style="left:{pointer.x}px; top:{pointer.y}px"
      aria-hidden="true"
      data-testid="restoration-loupe"
    >
      <canvas bind:this={loupeCanvas}></canvas>
      <span>100%</span>
    </div>
  {/if}
</div>

<style>
  .rc-stage {
    position: relative;
    width: 100%;
    height: 100%;
    background: #000;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
  }
  .rc-media {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  .rc-after {
    z-index: 1;
  }
  /* Studio.css `.fls-loupe`: a 140 px round magnifier with a white rim and a 100% tag. */
  .rc-loupe {
    position: absolute;
    width: 140px;
    height: 140px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 6px 24px #000a;
    transform: translate(-50%, -50%);
    pointer-events: none;
    overflow: hidden;
    background: #000;
    z-index: 4;
  }
  .rc-loupe canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .rc-loupe span {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 10px;
    background: #000b;
    color: #fff;
    padding: 1px 6px;
    border-radius: var(--fl-radius-pill);
  }
</style>
