<script lang="ts">
  import VideoNativeViewer from '$lib/components/asset-viewer/VideoNativeViewer.svelte';
  import VideoPanoramaViewer from '$lib/components/asset-viewer/VideoPanoramaViewer.svelte';
  import { isPanoramaVideoProjection, isStitchedVideoProjection } from '$lib/frameleaf/viewer-media';
  import type { AssetResponseDto } from '@frameleaf/sdk';

  interface Props {
    asset: AssetResponseDto;
    assetId?: string;
    projectionType: string | null | undefined;
    cacheKey: string | null;
    loopVideo: boolean;
    playOriginalVideo: boolean;
    extendedControls?: boolean;
    onClose?: () => void;
    onPreviousAsset?: () => void;
    onNextAsset?: () => void;
    onVideoEnded?: () => void;
    onVideoStarted?: () => void;
    onPlayEncoded?: () => void;
  }

  let {
    asset,
    assetId,
    projectionType,
    cacheKey,
    loopVideo,
    playOriginalVideo,
    extendedControls = false,
    onPreviousAsset,
    onClose,
    onNextAsset,
    onVideoEnded,
    onVideoStarted,
    onPlayEncoded,
  }: Props = $props();

  const effectiveAssetId = $derived(assetId ?? asset.id);
  // A raw dual-fisheye or cubemap original isn't equirectangular: it plays as 360° only once the
  // server has made the stitched playback copy; until then the ordinary player shows it as recorded.
  const lookAround = $derived(
    isPanoramaVideoProjection(projectionType) &&
      (!isStitchedVideoProjection(projectionType) || asset.playbackCopy === true),
  );
</script>

{#if lookAround}
  <VideoPanoramaViewer {asset} {projectionType} />
{:else}
  <VideoNativeViewer
    {loopVideo}
    {cacheKey}
    {asset}
    assetId={effectiveAssetId}
    {playOriginalVideo}
    {extendedControls}
    {onPreviousAsset}
    {onNextAsset}
    {onVideoEnded}
    {onVideoStarted}
    {onClose}
    {onPlayEncoded}
  />
{/if}
