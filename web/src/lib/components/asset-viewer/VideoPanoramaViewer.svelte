<script lang="ts">
  import { getAssetPlaybackUrl, getAssetUrl } from '$lib/utils';
  import type { AssetResponseDto } from '@frameleaf/sdk';
  import { LoadingSpinner } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import { motionFade } from '$lib/frameleaf/motion';
  import { isStitchedVideoProjection } from '$lib/frameleaf/viewer-media';

  interface Props {
    asset: AssetResponseDto;
    projectionType?: string | null;
  }

  const { asset, projectionType = asset.exifInfo?.projectionType }: Props = $props();

  // FL-968: a raw 360° original (two fisheye circles, a GoPro cubemap) only looks right stitched, so
  // the playback copy is the only resolution offered; zooming in must not swap to the raw file.
  const originalPanorama = $derived(
    isStitchedVideoProjection(projectionType) ? undefined : { source: getAssetUrl({ asset, forceOriginal: true })! },
  );

  const modules = Promise.all([
    import('./PhotoSphereViewerAdapter.svelte').then((module) => module.default),
    import('@photo-sphere-viewer/equirectangular-video-adapter').then((module) => module.EquirectangularVideoAdapter),
    import('@photo-sphere-viewer/video-plugin').then((module) => module.VideoPlugin),
    import('@photo-sphere-viewer/video-plugin/index.css'),
  ]);
</script>

<div transition:motionFade={{ duration: 150 }} class="flex h-full place-content-center place-items-center select-none">
  {#await modules}
    <LoadingSpinner />
  {:then [PhotoSphereViewer, adapter, videoPlugin]}
    <PhotoSphereViewer
      panorama={{ source: getAssetPlaybackUrl({ id: asset.id }) }}
      {originalPanorama}
      plugins={[videoPlugin]}
      {adapter}
      navbar
    />
  {:catch}
    {$t('errors.failed_to_load_asset')}
  {/await}
</div>
