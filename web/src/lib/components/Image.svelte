<script lang="ts" module>
  // The browser shares one request between <img> elements with the same URL, so cancelling it for a
  // destroyed element also fails every other element still loading it, including one that replaces
  // it in the same update. Only the last one may cancel. loadImage() loads are not counted here.
  const mounted = new Map<string, number>();
  const cancelling = new Set<string>();
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
    const source = src;
    capturedSource = source;
    loaded = false;
    if (source === undefined) {
      return;
    }

    untrack(() => {
      onStart?.();
    });
    if (destroyed) {
      return;
    }
    mounted.set(source, (mounted.get(source) ?? 0) + 1);
    return () => {
      const remaining = (mounted.get(source) ?? 1) - 1;
      if (remaining > 0) {
        mounted.set(source, remaining);
        return;
      }
      mounted.delete(source);
      if (cancelling.has(source)) {
        return;
      }
      cancelling.add(source);
      // A replacement in the same update may still need this shared request.
      setTimeout(() => {
        cancelling.delete(source);
        if (!mounted.has(source)) {
          cancelImageUrl(source);
        }
      }, 0);
    };
  });

  onDestroy(() => {
    destroyed = true;
  });

  const completeLoad = (image: HTMLImageElement) => {
    if (destroyed || image !== ref || src !== capturedSource || image.getAttribute('src') !== capturedSource) {
      return;
    }
    loaded = true;
    onLoad?.();
  };

  const handleLoad = (event: Event) => {
    const image = event.currentTarget as HTMLImageElement;
    if (destroyed || !src || image !== ref || image.getAttribute('src') !== src) {
      return;
    }

    if (isFirefox) {
      const complete = () => completeLoad(image);
      image.decode().then(complete).catch(complete);
      return;
    }

    completeLoad(image);
  };

  const handleError = (event: Event) => {
    const image = event.currentTarget as HTMLImageElement;
    if (destroyed || !src || image !== ref || image.getAttribute('src') !== src) {
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
