<script lang="ts">
  /**
   * Before-and-after split for a restoration (FL-115), ported from the prototype's `RestoreCompare`.
   *
   * The prototype faked the "after" side with a CSS sharpen filter. Here both sides are real files
   * the server produced: the preview input and the restored preview, or the original and the
   * finished result. For video the two clips play in step: the after side owns playback and the
   * before side follows its seeks, plays and pauses, so a comparison never drifts.
   */
  import { t } from 'svelte-i18n';

  type Props = {
    before: string;
    after: string;
    isVideo: boolean;
    beforeLabel: string;
    afterLabel: string;
    alt: string;
  };

  let { before, after, isVideo, beforeLabel, afterLabel, alt }: Props = $props();

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

<div class="rc-stage" bind:this={stageEl} data-testid="restoration-compare">
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
    <img class="rc-media" src={before} alt={`${beforeLabel}: ${alt}`} draggable="false" />
    <img
      class="rc-media rc-after"
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
</style>
