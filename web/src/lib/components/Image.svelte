<script lang="ts" module>
  // The browser shares one request between <img> elements with the same URL, so cancelling it for a
  // destroyed element also fails every other element still loading it, including one that replaces
  // it in the same update. Only the last one may cancel. loadImage() loads are not counted here.
  const mounted = new Map<string, number>();
</script>

<script lang="ts">
  import { isFirefox } from '$lib/utils/asset-utils';
  import { cancelImageUrl } from '$lib/utils/sw-messaging';
  import { onDestroy, untrack } from 'svelte';
  import type { HTMLImgAttributes } from 'svelte/elements';

  type Props = Omit<HTMLImgAttributes, 'onload' | 'onerror'> & {
    src: string | undefined;
    onStart?: () => void;
    onLoad?: () => void;
    onError?: (error: Error) => void;
    ref?: HTMLImageElement;
  };

  let { src, onStart, onLoad, onError, ref = $bindable(), ...rest }: Props = $props();

  let capturedSource: string | undefined = $state();
  let loaded = $state(false);
  let destroyed = false;

  $effect(() => {
    if (src === undefined || capturedSource !== undefined) {
      return;
    }

    capturedSource = src;
    mounted.set(src, (mounted.get(src) ?? 0) + 1);
    untrack(() => {
      onStart?.();
    });
  });

  onDestroy(() => {
    destroyed = true;
    const source = capturedSource;
    if (source === undefined) {
      return;
    }
    const remaining = (mounted.get(source) ?? 1) - 1;
    if (remaining > 0) {
      mounted.set(source, remaining);
      return;
    }
    mounted.delete(source);
    // A replacement mounted in the same update joins the request still in flight, so look again
    // once that update has finished.
    setTimeout(() => {
      if (!mounted.has(source)) {
        cancelImageUrl(source);
      }
    }, 0);
  });

  const completeLoad = () => {
    if (destroyed) {
      return;
    }
    loaded = true;
    onLoad?.();
  };

  const handleLoad = () => {
    if (destroyed || !src) {
      return;
    }

    if (isFirefox && ref) {
      ref.decode().then(completeLoad).catch(completeLoad);
      return;
    }

    completeLoad();
  };

  const handleError = () => {
    if (destroyed || !src) {
      return;
    }
    onError?.(new Error(`Failed to load image: ${src}`));
  };
</script>

{#if capturedSource}
  {#key capturedSource}
    <img
      bind:this={ref}
      src={capturedSource}
      {...rest}
      style:visibility={isFirefox && !loaded ? 'hidden' : undefined}
      onload={handleLoad}
      onerror={handleError}
    />
  {/key}
{/if}
