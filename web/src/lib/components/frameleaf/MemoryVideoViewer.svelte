<script lang="ts">
  import { assetViewerFadeDuration } from '$lib/constants';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { autoPlayVideo } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { AssetMediaSize } from '@immich/sdk';
  import 'media-chrome/media-controller';
  import { onMount } from 'svelte';
  import { on } from 'svelte/events';
  import { fade } from 'svelte/transition';

  interface Props {
    asset: TimelineAsset;
    videoPlayer: HTMLVideoElement | undefined;
    /**
     * FL-62: where the video starts, in milliseconds (its evidence position: the owner's cover time or
     * the best frame). It may arrive after the video has started; it is applied once.
     */
    startAtMs?: number | null;
  }

  let { asset, videoPlayer = $bindable(), startAtMs = null }: Props = $props();

  let started = false;
  $effect(() => {
    const player = videoPlayer;
    const start = startAtMs;
    if (!player || start === null || start <= 0 || started) {
      return;
    }
    const seek = () => {
      if (started) {
        return;
      }
      started = true;
      player.currentTime = start / 1000;
    };
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seek();
      return;
    }
    return on(player, 'loadedmetadata', seek, { once: true });
  });

  let showVideo: boolean = $state(false);

  onMount(() => {
    // Show video after mount to ensure fading in.
    showVideo = true;
  });
</script>

{#if showVideo}
  <div class="bg-pink-9000 size-full" transition:fade={{ duration: assetViewerFadeDuration }}>
    <media-controller id="memory-video" nohotkeys class="size-full rounded-2xl object-contain transition-all">
      <video
        bind:this={videoPlayer}
        slot="media"
        autoplay={$autoPlayVideo}
        muted
        playsinline
        disablepictureinpicture
        class="size-full"
        src={getAssetPlaybackUrl({ id: asset.id })}
        poster={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview })}
        draggable="false"
      ></video>
    </media-controller>
  </div>
{/if}
