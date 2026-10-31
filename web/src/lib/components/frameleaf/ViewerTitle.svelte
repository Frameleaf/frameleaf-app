<script lang="ts">
  /**
   * The viewer's file name with the short EXIF line underneath (FL-35).
   *
   * The data is the metadata the detail panel already receives on `AssetResponseDto`;
   * this is layout only, matching `mv-title` in the approved template. The line collapses
   * to nothing when the asset carries no metadata. It shows at every width, as in the template:
   * on phones the actions move to the bottom toolbar, so the header has room for it.
   *
   * VIEWER-P8 (MediaViewer.jsx:1019-1031, media-viewer.css:74-80): "3 of 19" sits beside the name,
   * then the kind (Video, Live, Panorama). Phones leave the position to the footer
   * (media-viewer.css:2039-2041).
   */
  import { viewerHeadlineText } from '$lib/frameleaf/viewer-headline';
  import { isLivePhoto, isPanorama, isVideoAsset } from '$lib/frameleaf/viewer-media';
  import type { ViewerPosition } from '$lib/frameleaf/viewer-position';
  import type { AssetResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    position?: ViewerPosition | null;
  };

  let { asset, position = null }: Props = $props();

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

<div class="dark flex min-w-0 flex-col justify-center ps-1 text-white" data-testid="viewer-title">
  <div class="flex min-w-0 items-baseline gap-2">
    <strong class="truncate text-sm font-semibold" title={asset.originalFileName}>
      {asset.originalFileName}
    </strong>
    {#if position || kind}
      <small class="fl-title-meta shrink-0 text-xs text-white/70">
        {#if position}
          <span class="fl-title-position" aria-live="polite" data-testid="viewer-title-position">
            {$t('frameleaf_viewer_position', { values: { index: position.index + 1, total: position.total } })}
          </span>
        {/if}
        {#if kind}
          <span class="fl-title-kind">{kind}</span>
        {/if}
      </small>
    {/if}
  </div>
  {#if headline}
    <span class="truncate text-xs text-white/70" data-testid="viewer-exif-line" title={headline}>
      {headline}
    </span>
  {/if}
</div>

<style>
  /* FL-707 item 14: the one "N of M" counter, beside the file name on every screen size. */
  .fl-title-meta {
    font-variant-numeric: tabular-nums;
  }

  .fl-title-position + .fl-title-kind::before {
    content: '· ';
  }

</style>
