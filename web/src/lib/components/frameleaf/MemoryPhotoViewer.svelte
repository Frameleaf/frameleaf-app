<script lang="ts">
  import { assetViewerFadeDuration } from '$lib/constants';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { AssetMediaSize } from '@immich/sdk';
  import DelayedLoadingSpinner from '$lib/components/DelayedLoadingSpinner.svelte';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';

  interface Props {
    asset: TimelineAsset;
    onImageLoad: () => void;
    /**
     * Extra class applied to the rendered `<img>`, on top of the base sizing/rounding
     * classes. Used by the Frameleaf memory player (FL-62) to apply its Ken Burns pan/zoom
     * animation without this component needing to know about that presentation.
     */
    motionClass?: string;
    /** Inline style forwarded to the same `<img>`, e.g. to set the animation's duration. */
    motionStyle?: string;
  }

  const { asset, onImageLoad, motionClass = '', motionStyle = '' }: Props = $props();

  let assetFileUrl: string = $state('');
  let imageLoaded: boolean = $state(false);
  let loader = $state<HTMLImageElement>();

  const onLoadCallback = () => {
    imageLoaded = true;
    assetFileUrl = imageLoaderUrl;
    onImageLoad();
  };

  onMount(() => {
    if (loader?.complete) {
      onLoadCallback();
    }
    loader?.addEventListener('load', onLoadCallback);
    return () => {
      loader?.removeEventListener('load', onLoadCallback);
    };
  });

  const imageLoaderUrl = $derived(getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview }));
</script>

{#if !imageLoaded}
  <!-- svelte-ignore a11y_missing_attribute -->
  <img bind:this={loader} style="display:none" src={imageLoaderUrl} aria-hidden="true" />
{/if}

{#if !imageLoaded}
  <DelayedLoadingSpinner />
{:else if imageLoaded}
  <div transition:fade={{ duration: assetViewerFadeDuration }} class="size-full">
    <img
      class="size-full rounded-2xl object-contain transition-all {motionClass}"
      style={motionStyle}
      src={assetFileUrl}
      alt={$getAltText(asset)}
      draggable="false"
    />
  </div>
{/if}
