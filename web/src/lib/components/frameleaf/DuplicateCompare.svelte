<script lang="ts">
  /**
   * Side-by-side comparison of two copies (FL-61), the prototype's `dr-compare-grid`.
   *
   * Comparison is synchronised: zooming one copy zooms the other at the same point, and moving over
   * one pans both, so detail is judged at the same place in each. Two videos play, pause and seek
   * together. Each copy carries the evidence behind the suggestion (format, resolution, size,
   * metadata) and the file facts that differ between the copies, which is where provenance shows.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { dimensionsOf, qualityReasonKey, type ReviewGroup } from '$lib/frameleaf/duplicate-review';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { computeDifferingMetadataFields, getAllMetadataItems } from '$lib/utils/duplicate-utils';
  import { AssetMediaSize, AssetTypeEnum } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Asset = ReviewGroup['assets'][number];

  type Props = {
    group: ReviewGroup;
    actionable: boolean;
    suggestedId: string | null;
    onKeep: (asset: Asset) => void;
    onOpen: (asset: Asset) => void;
  };

  let { group, actionable, suggestedId, onKeep, onOpen }: Props = $props();

  const ZOOM = 2.5;
  let zoom = $state<{ x: number; y: number } | null>(null);
  let videos = $state<HTMLVideoElement[]>([]);
  let syncing = false;

  const differing = $derived(computeDifferingMetadataFields(group.assets));
  const reasonsFor = (asset: Asset) => group.qualities.find((quality) => quality.assetId === asset.id)?.reasons ?? [];
  const differingItems = (asset: Asset) =>
    getAllMetadataItems(asset, $t, $locale)
      .filter(({ keys }) => keys.some((key) => differing[key]))
      .slice(0, 6);

  const pointAt = (event: PointerEvent | MouseEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100)),
    };
  };

  const toggleZoom = (event?: MouseEvent) => {
    zoom = zoom ? null : event ? pointAt(event) : { x: 50, y: 50 };
  };

  const pan = (event: PointerEvent) => {
    if (zoom) {
      zoom = pointAt(event);
    }
  };

  /** Mirror play, pause and seek from one video to the others. */
  const mirror = (source: HTMLVideoElement, kind: 'play' | 'pause' | 'seeked') => {
    if (syncing) {
      return;
    }
    syncing = true;
    for (const video of videos) {
      if (!video || video === source) {
        continue;
      }
      if (kind === 'seeked' && Math.abs(video.currentTime - source.currentTime) > 0.05) {
        video.currentTime = source.currentTime;
      } else if (kind === 'play' && video.paused) {
        void video.play().catch(() => {});
      } else if (kind === 'pause' && !video.paused) {
        video.pause();
      }
    }
    queueMicrotask(() => (syncing = false));
  };

  const playTogether = () => {
    for (const video of videos) {
      if (!video) {
        continue;
      }

      video.currentTime = 0;
      void video.play().catch(() => {});
    }
  };

  const hasVideo = $derived(group.assets.some((asset) => asset.type === AssetTypeEnum.Video));
  const zoomStyle = $derived(zoom ? `transform: scale(${ZOOM}); transform-origin: ${zoom.x}% ${zoom.y}%;` : '');
</script>

<div class="fl-dr-compare-tools">
  {#if hasVideo}
    <Button onclick={playTogether}>
      <Icon icon={mdiPlay} size="16" aria-hidden={true} />
      {$t('frameleaf_duplicates_play_together')}
    </Button>
  {:else}
    <Button pressed={!!zoom} onclick={() => toggleZoom()}>
      <Icon icon={zoom ? mdiMagnifyMinusOutline : mdiMagnifyPlusOutline} size="16" aria-hidden={true} />
      {zoom ? $t('frameleaf_duplicates_zoom_reset') : $t('frameleaf_duplicates_zoom_both')}
    </Button>
  {/if}
  <span>{$t('frameleaf_duplicates_compare_hint')}</span>
</div>

<div class="fl-dr-compare-grid" data-testid="frameleaf-duplicate-compare">
  {#each group.assets as asset, index (asset.id)}
    {@const size = dimensionsOf(asset)}
    {@const reasons = reasonsFor(asset)}
    {@const differs = differingItems(asset)}
    <article class:suggested={asset.id === suggestedId}>
      <div class="fl-dr-image">
        {#if asset.type === AssetTypeEnum.Video}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={videos[index]}
            src={getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash })}
            poster={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
            controls
            playsinline
            preload="metadata"
            onplay={(event) => mirror(event.currentTarget, 'play')}
            onpause={(event) => mirror(event.currentTarget, 'pause')}
            onseeked={(event) => mirror(event.currentTarget, 'seeked')}
          ></video>
        {:else}
          <button
            type="button"
            class="fl-dr-zoom"
            aria-pressed={!!zoom}
            aria-label={zoom
              ? $t('frameleaf_duplicates_zoom_reset')
              : $t('frameleaf_duplicates_zoom_at', { values: { name: asset.originalFileName } })}
            onclick={(event) => toggleZoom(event)}
            onpointermove={pan}
          >
            <img
              src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
              alt={asset.originalFileName}
              style={zoomStyle}
              draggable="false"
            />
          </button>
        {/if}
        <span class="fl-dr-index" aria-hidden="true">{index + 1}</span>
        {#if asset.id === suggestedId}
          <strong class="fl-dr-suggested">{$t('frameleaf_duplicates_suggested_keeper')}</strong>
        {/if}
      </div>
      <div class="fl-dr-copy">
        <strong>{asset.originalFileName}</strong>
        {#if reasons.length > 0}
          <ul class="fl-dr-reasons" aria-label={$t('frameleaf_duplicates_quality_label')}>
            {#each reasons as reason (reason)}
              <li>{$t(qualityReasonKey(reason))}</li>
            {/each}
          </ul>
        {/if}
        <div class="fl-dr-facts">
          <span>
            {size
              ? `${size.width.toLocaleString($locale)} × ${size.height.toLocaleString($locale)}`
              : $t('frameleaf_duplicates_size_unknown')}
          </span>
          <span>{getByteUnitString(asset.exifInfo?.fileSizeInByte ?? 0, $locale)}</span>
        </div>
        {#if differs.length > 0}
          <dl class="fl-dr-differs" aria-label={$t('frameleaf_duplicates_differs_label')}>
            {#each differs as item (item.title)}
              <div title={item.tooltip}>
                <dt>{item.title}</dt>
                <dd>{item.render}</dd>
              </div>
            {/each}
          </dl>
        {/if}
        <div class="fl-dr-copy-actions">
          <Button
            variant={asset.id === suggestedId ? 'primary' : 'default'}
            disabled={!actionable}
            onclick={() => onKeep(asset)}
          >
            {$t('frameleaf_duplicates_keep_this_copy')}
            {#if index < 9}<kbd>{index + 1}</kbd>{/if}
          </Button>
          <Button
            variant="quiet"
            label={$t('frameleaf_duplicates_open_photo', { values: { name: asset.originalFileName } })}
            onclick={() => onOpen(asset)}
          >
            <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
          </Button>
        </div>
      </div>
    </article>
  {/each}
</div>

<style>
  .fl-dr-compare-tools {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .fl-dr-compare-tools span {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .fl-dr-compare-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  article {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
  }
  article.suggested {
    border-color: color-mix(in srgb, var(--fl-accent) 55%, var(--fl-border));
  }
  .fl-dr-image {
    position: relative;
    overflow: hidden;
    background: var(--fl-canvas);
  }
  .fl-dr-zoom {
    display: block;
    width: 100%;
    padding: 0;
    overflow: hidden;
    cursor: zoom-in;
    background: none;
    border: 0;
  }
  .fl-dr-zoom[aria-pressed='true'] {
    cursor: zoom-out;
  }
  .fl-dr-image img,
  .fl-dr-image video {
    display: block;
    width: 100%;
    aspect-ratio: 1.35;
    object-fit: contain;
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-dr-index,
  .fl-dr-suggested {
    position: absolute;
    top: 9px;
    padding: 5px 7px;
    font-size: var(--fl-font-micro);
    font-weight: 500;
    color: #f0f7f3;
    background: #081311cc;
    border-radius: var(--fl-radius);
    pointer-events: none;
  }
  .fl-dr-index {
    left: 9px;
  }
  .fl-dr-suggested {
    right: 9px;
    color: #9ae4b6;
  }
  .fl-dr-copy {
    padding: 13px;
  }
  .fl-dr-copy > strong {
    display: block;
    font-size: var(--fl-font-small);
    font-weight: 600;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .fl-dr-reasons {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    padding: 0;
    margin: 6px 0 0;
    list-style: none;
  }
  .fl-dr-reasons li {
    padding: 2px 7px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .fl-dr-facts {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 0 0;
    margin-top: 10px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    border-top: 1px solid var(--fl-border);
  }
  .fl-dr-differs {
    display: grid;
    gap: 4px;
    margin: 10px 0 0;
    font-size: var(--fl-font-micro);
  }
  .fl-dr-differs div {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .fl-dr-differs dt {
    color: var(--fl-muted);
  }
  .fl-dr-differs dd {
    margin: 0;
    text-align: end;
    overflow-wrap: anywhere;
  }
  .fl-dr-copy-actions {
    display: flex;
    gap: 6px;
    margin-top: 12px;
  }
  .fl-dr-copy-actions :global(button:first-child) {
    flex: 1;
    justify-content: space-between;
  }
  kbd {
    font-size: var(--fl-font-micro);
    opacity: 0.65;
  }
  @media (max-width: 700px) {
    .fl-dr-compare-grid {
      gap: 8px;
    }
    .fl-dr-image img,
    .fl-dr-image video {
      aspect-ratio: 1;
    }
    .fl-dr-suggested {
      position: static;
      display: block;
      padding: 6px;
      border-radius: 0;
    }
    .fl-dr-copy {
      padding: 10px;
    }
    kbd {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-dr-image img {
      transition: none;
    }
  }
</style>
