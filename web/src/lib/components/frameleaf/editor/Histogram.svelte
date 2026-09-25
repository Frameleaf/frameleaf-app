<script lang="ts">
  /**
   * The Adjust panel's histogram (FL-113). It samples the image the stage is showing: the
   * server's rendered preview when one has arrived for the current recipe, otherwise the
   * original with the CSS approximation applied to the sampled pixels, and says which it is.
   * Sampling runs on the next animation frame after any input changes.
   */
  import { histogramBins, tonePixels, type CssFilterInfo } from '$lib/frameleaf/develop';
  import { t } from 'svelte-i18n';

  let {
    source,
    approximation,
    fromServer,
    tick = 0,
  }: {
    /** The image or video element currently shown on the stage, once it has loaded (a clip samples its current frame). */
    source: HTMLImageElement | HTMLVideoElement | undefined;
    /** Applied to sampled pixels only while the stage shows the CSS approximation. */
    approximation: CssFilterInfo;
    fromServer: boolean;
    /** Bumped by the owner when the stage image finishes loading, so the sample is fresh. */
    tick?: number;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let status = $state<'idle' | 'ok' | 'unavailable'>('idle');
  let clipped = $state({ shadows: 0, highlights: 0 });
  let sampler: HTMLCanvasElement | undefined;

  const draw = (target: HTMLCanvasElement, bins: ReturnType<typeof histogramBins>) => {
    const ratio = globalThis.devicePixelRatio || 1;
    const width = target.clientWidth || 268;
    const height = target.clientHeight || 90;
    target.width = Math.round(width * ratio);
    target.height = Math.round(height * ratio);
    const context = target.getContext('2d');
    if (!context) {
      return;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const max = bins.max || 1;
    const trace = (values: number[], fill: string | null, stroke?: string) => {
      const last = values.length - 1;
      const path = new Path2D();
      path.moveTo(0, height);
      for (const [index, value] of values.entries()) {
        path.lineTo((index / last) * width, height - (value / max) ** 0.65 * (height - 6));
      }
      path.lineTo(width, height);
      path.closePath();
      if (fill) {
        context.fillStyle = fill;
        context.fill(path);
      }
      if (stroke) {
        context.strokeStyle = stroke;
        context.lineWidth = 1;
        context.stroke(path);
      }
    };
    context.globalCompositeOperation = 'screen';
    trace(bins.red, 'rgba(240, 92, 92, 0.55)');
    trace(bins.green, 'rgba(96, 214, 132, 0.55)');
    trace(bins.blue, 'rgba(96, 150, 255, 0.55)');
    context.globalCompositeOperation = 'source-over';
    trace(bins.luma, null, 'rgba(236, 238, 241, 0.85)');
  };

  $effect(() => {
    const target = canvas;
    const image = source;
    const info = approximation;
    const server = fromServer;
    void tick;
    if (!target || !image) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const isVideo = image instanceof HTMLVideoElement;
      const sourceWidth = isVideo ? image.videoWidth : image.naturalWidth;
      const sourceHeight = isVideo ? image.videoHeight : image.naturalHeight;
      if ((isVideo ? image.readyState < 2 : !image.complete) || sourceWidth === 0) {
        return;
      }
      try {
        const width = 128;
        const height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
        sampler ??= document.createElement('canvas');
        sampler.width = width;
        sampler.height = height;
        const context = sampler.getContext('2d', { willReadFrequently: true });
        if (!context) {
          status = 'unavailable';
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height);
        if (!server) {
          tonePixels(pixels.data, info.numeric, info.params);
        }
        const bins = histogramBins(pixels, 64);
        draw(target, bins);
        clipped = bins.clipped;
        status = 'ok';
      } catch {
        // A cross-origin or not-yet-decoded image taints the canvas; say so instead of guessing.
        status = 'unavailable';
      }
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class="ed-histogram" role="img" aria-label={$t('frameleaf_editor_histogram_label')}>
  <canvas bind:this={canvas}></canvas>
  {#if status === 'ok' && clipped.shadows > 0.01}
    <span class="ed-clip left" title={$t('frameleaf_editor_histogram_shadows_clipping')}></span>
  {/if}
  {#if status === 'ok' && clipped.highlights > 0.01}
    <span class="ed-clip right" title={$t('frameleaf_editor_histogram_highlights_clipping')}></span>
  {/if}
  {#if status === 'unavailable'}
    <span class="ed-histogram-note">{$t('frameleaf_editor_histogram_unavailable')}</span>
  {:else if status === 'ok'}
    <span class="ed-histogram-source">
      {fromServer ? $t('frameleaf_editor_histogram_from_render') : $t('frameleaf_editor_histogram_approximate')}
    </span>
  {/if}
</div>
