<script lang="ts">
  /**
   * The viewer's file name with the short EXIF line underneath (FL-35).
   *
   * The data is the metadata the detail panel already receives on `AssetResponseDto`;
   * this is layout only, matching `mv-title` in the approved template. The line collapses
   * to nothing when the asset carries no metadata, and is hidden below `md` so the narrow
   * navbar keeps room for the actions.
   */
  import { viewerHeadlineText } from '$lib/frameleaf/viewer-headline';
  import { isLivePhoto, isPanorama, isVideoAsset } from '$lib/frameleaf/viewer-media';
  import type { AssetResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
  };

  let { asset }: Props = $props();

  const headline = $derived(viewerHeadlineText(asset));
  const kind = $derived.by(() => {
    if (isVideoAsset(asset)) {
      return $t('video');
    }
    if (isPanorama(asset)) {
      return $t('frameleaf_viewer_kind_panorama');
    }
    if (isLivePhoto(asset)) {
      return $t('frameleaf_viewer_kind_live');
    }
    return null;
  });
</script>

<div class="dark hidden min-w-0 flex-col justify-center ps-1 text-white md:flex" data-testid="viewer-title">
  <div class="flex min-w-0 items-baseline gap-2">
    <strong class="truncate text-sm font-medium" title={asset.originalFileName}>
      {asset.originalFileName}
    </strong>
    {#if kind}
      <small class="shrink-0 text-xs text-white/70">{kind}</small>
    {/if}
  </div>
  {#if headline}
    <span class="truncate text-xs text-white/70" data-testid="viewer-exif-line" title={headline}>
      {headline}
    </span>
  {/if}
</div>
