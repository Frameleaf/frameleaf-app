<script lang="ts">
  import { decodeBase64 } from '$lib/utils';
  import { TUNABLES } from '$lib/utils/tunables';
  import type { HTMLCanvasAttributes } from 'svelte/elements';
  import { prefersReducedMotion, REDUCED_MOTION_FADE_MS } from '$lib/frameleaf/motion';
  import { thumbHashToRGBA } from 'thumbhash';

  type Props = HTMLCanvasAttributes & {
    base64ThumbHash: string;
    fadeOut?: boolean;
  };

  const { base64ThumbHash, fadeOut = false, class: className, ...restProps }: Props = $props();

  // The placeholder gives way to the photo over the brand's base duration (--fl-motion); the
  // tunable's default is that token, and a value set in local storage still overrides it.
  const fadeDuration = TUNABLES.IMAGE_THUMBNAIL.THUMBHASH_FADE_DURATION;

  // Not `motionFade`: Svelte's `fade` reads getComputedStyle for the starting opacity, which forced a
  // style recalculation for every thumbnail whose photo arrived while a large grid scrolled. The
  // placeholder is always fully opaque, so the fade starts at 1 (and is as short under Reduce Motion).
  const fadeAway = (_node: Element, { duration }: { duration: number }) => ({
    duration: prefersReducedMotion() ? REDUCED_MOTION_FADE_MS : duration,
    css: (t: number) => `opacity: ${t}`,
  });

  let canvas = $state<HTMLCanvasElement>();

  $effect(() => {
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      return;
    }
    const { w, h, rgba } = thumbHashToRGBA(decodeBase64(base64ThumbHash));
    canvas.width = w;
    canvas.height = h;
    const pixels = ctx.createImageData(w, h);
    pixels.data.set(rgba);
    ctx.putImageData(pixels, 0, 0);
  });
</script>

<canvas bind:this={canvas} class={className} out:fadeAway={{ duration: fadeOut ? fadeDuration : 0 }} {...restProps}
></canvas>
