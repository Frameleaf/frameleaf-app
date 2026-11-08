<script lang="ts">
  import VideoNativeViewer from '$lib/components/asset-viewer/VideoNativeViewer.svelte';
  import VideoPanoramaViewer from '$lib/components/asset-viewer/VideoPanoramaViewer.svelte';
  import { isPanoramaVideoProjection } from '$lib/frameleaf/viewer-media';
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
</script>

{#if isPanoramaVideoProjection(projectionType)}
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
