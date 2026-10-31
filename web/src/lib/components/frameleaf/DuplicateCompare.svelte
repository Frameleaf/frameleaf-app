<script lang="ts">
  /**
   * Copies of one photo, compared (FL-61, FL-558): the prototype's `dt-compare` table.
   *
   * Each copy is a column. Clicking a copy (or pressing its number) makes it the one to keep; the
   * review preselects the suggested copy. Below the photos, one row per fact lines the copies up:
   * where they came from, when, how large, which camera, where, and which albums hold them. Values
   * that differ stand out and values that match are muted, which is where provenance shows.
   *
   * Comparison is synchronised: "Zoom both" zooms every copy at the same point and moving over one
   * pans them all, so detail is judged at the same place in each. Videos play, pause and seek together.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    comparisonRows,
    dimensionsOf,
    folderOf,
    qualityReasonKey,
    type ReviewGroup,
  } from '$lib/frameleaf/duplicate-review';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { AssetMediaSize, AssetTypeEnum } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiMagnifyMinusOutline, mdiMagnifyPlusOutline, mdiOpenInNew, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Asset = ReviewGroup['assets'][number];

  type Props = {
    group: ReviewGroup;
    actionable: boolean;
    suggestedId: string | null;
    /** The copies chosen to keep; one for a comparison. */
    keeperIds: string[];
    /** With the trash off, a copy not kept is deleted, and its mark says so. */
    trashEnabled: boolean;
    onChoose: (index: number) => void;
    onOpen: (asset: Asset) => void;
  };

  let { group, actionable, suggestedId, keeperIds, trashEnabled, onChoose, onOpen }: Props = $props();

  const ZOOM = 2.5;
  const NONE = '—';
  let zoom = $state<{ x: number; y: number } | null>(null);
  let videos = $state<HTMLVideoElement[]>([]);
  let syncing = false;

  const taken = (asset: Asset) => {
    const value = asset.exifInfo?.dateTimeOriginal ?? asset.localDateTime;
    const date = value ? new Date(value) : null;
    // local capture times are stored as UTC wall-clock time, so they are shown in UTC
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString($locale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' })
      : NONE;
  };
  const sizeOf = (asset: Asset) => {
    const size = dimensionsOf(asset);
    const bytes = getByteUnitString(asset.exifInfo?.fileSizeInByte ?? 0, $locale);
    return size ? `${size.width.toLocaleString($locale)} × ${size.height.toLocaleString($locale)} · ${bytes}` : bytes;
  };
  const cameraOf = (asset: Asset) => {
    const body = [asset.exifInfo?.make, asset.exifInfo?.model].filter(Boolean).join(' ');
    return [body, asset.exifInfo?.lensModel].filter(Boolean).join(' · ') || NONE;
  };
  const placeOf = (asset: Asset) =>
    [asset.exifInfo?.city, asset.exifInfo?.state, asset.exifInfo?.country].filter(Boolean).join(', ') || NONE;
  const albumsOf = (asset: Asset) =>
    group.albums?.find((entry) => entry.assetId === asset.id)?.names.join(', ') || NONE;
  const sourceOf = (asset: Asset) => {
    const reasons = group.qualities.find((quality) => quality.assetId === asset.id)?.reasons ?? [];
    const labels = reasons.map((reason) => $t(qualityReasonKey(reason, asset.originalFileName)));
    if (asset.isEdited) {
      labels.push($t('frameleaf_duplicates_fact_edited'));
    }
    return labels.join(' · ') || NONE;
  };

  const rows = $derived(
    comparisonRows([
      { key: 'frameleaf_duplicates_fact_file', values: group.assets.map((asset) => asset.originalFileName) },
      {
        key: 'frameleaf_duplicates_fact_folder',
        values: group.assets.map((asset) => folderOf(asset.originalPath) || NONE),
      },
      { key: 'frameleaf_duplicates_fact_taken', values: group.assets.map((asset) => taken(asset)) },
      { key: 'frameleaf_duplicates_fact_size', values: group.assets.map((asset) => sizeOf(asset)) },
      { key: 'frameleaf_duplicates_fact_camera', values: group.assets.map((asset) => cameraOf(asset)) },
      { key: 'frameleaf_duplicates_fact_location', values: group.assets.map((asset) => placeOf(asset)) },
      { key: 'frameleaf_duplicates_fact_albums', values: group.assets.map((asset) => albumsOf(asset)) },
      { key: 'frameleaf_duplicates_fact_source', values: group.assets.map((asset) => sourceOf(asset)) },
    ]),
  );

  const pointAt = (event: PointerEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((event.clientX - box.left) / box.width) * 100)),
      y: Math.min(100, Math.max(0, ((event.clientY - box.top) / box.height) * 100)),
    };
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

<div class="fl-dr-compare" data-testid="frameleaf-duplicate-compare">
  <div class="fl-dr-table" style:--copies={group.assets.length}>
    <div class="fl-dr-table-grid" role="radiogroup" aria-label={$t('frameleaf_duplicates_choose_copy')}>
      <!-- The table's empty corner holds the comparison tool. -->
      <div class="fl-dr-compare-tools">
        {#if hasVideo}
          <Button label={$t('frameleaf_duplicates_play_together')} onclick={playTogether}>
            <Icon icon={mdiPlay} size="18" aria-hidden={true} />
          </Button>
        {:else}
          <Button
            pressed={!!zoom}
            label={zoom ? $t('frameleaf_duplicates_zoom_reset') : $t('frameleaf_duplicates_zoom_both')}
            onclick={() => (zoom = zoom ? null : { x: 50, y: 50 })}
          >
            <Icon icon={zoom ? mdiMagnifyMinusOutline : mdiMagnifyPlusOutline} size="18" aria-hidden={true} />
          </Button>
        {/if}
        <small>{$t('frameleaf_duplicates_compare_hint')}</small>
      </div>
      {#each group.assets as asset, index (asset.id)}
        {@const keep = keeperIds.includes(asset.id)}
        <div class="fl-dr-copy" class:keep class:trash={!keep} data-asset-id={asset.id}>
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
            <img
              src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
              alt=""
              style={zoomStyle}
              draggable="false"
            />
          {/if}
          <!-- The whole photo chooses the copy; a video keeps its own controls and is chosen by its badge. -->
          <button
            type="button"
            role="radio"
            class="fl-dr-choose"
            class:badge-only={asset.type === AssetTypeEnum.Video}
            aria-checked={keep}
            aria-label={$t('frameleaf_duplicates_keep_copy_named', { values: { name: asset.originalFileName } })}
            disabled={!actionable}
            onclick={() => onChoose(index)}
            onpointermove={pan}
          >
            <span class="fl-dr-mark"
              >{keep
                ? $t('frameleaf_duplicates_mark_keep')
                : trashEnabled
                  ? $t('frameleaf_duplicates_mark_trash')
                  : $t('frameleaf_duplicates_mark_delete')}</span
            >
          </button>
          <span class="fl-dr-index" aria-hidden="true">{index + 1}</span>
          {#if asset.id === suggestedId}
            <strong class="fl-dr-suggested">{$t('frameleaf_duplicates_best_copy')}</strong>
          {/if}
          <span class="fl-dr-open">
            <Button
              variant="quiet"
              label={$t('frameleaf_duplicates_open_photo', { values: { name: asset.originalFileName } })}
              onclick={() => onOpen(asset)}
            >
              <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
            </Button>
          </span>
        </div>
      {/each}
    </div>
    <dl class="fl-dr-table-grid fl-dr-facts">
      {#each rows as row (row.key)}
        <dt>{$t(row.key as never)}</dt>
        {#each row.values as value, index (index)}
          <dd class:differs={row.differs} title={value}>{value}</dd>
        {/each}
      {/each}
    </dl>
  </div>
</div>

<style>
  .fl-dr-compare {
    height: 100%;
    min-height: 0;
  }
  .fl-dr-compare-tools {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: 8px;
  }
  .fl-dr-compare-tools small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    line-height: 1.4;
  }
  /* Many copies scroll sideways; the photo row takes the room the facts leave. */
  .fl-dr-table {
    display: grid;
    height: 100%;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 8px;
    min-height: 0;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .fl-dr-table-grid {
    display: grid;
    grid-template-columns: 88px repeat(var(--copies), minmax(200px, 1fr));
    column-gap: 14px;
    min-height: 0;
    margin: 0;
  }
  /* The photo row takes what the facts leave; a photo never sets its own height. */
  .fl-dr-table-grid[role='radiogroup'] {
    grid-template-rows: minmax(0, 1fr);
  }
  .fl-dr-copy {
    position: relative;
    min-height: 0;
    overflow: hidden;
    background: var(--fl-canvas);
    border: 2px solid transparent;
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-copy.keep {
    border-color: var(--fl-accent);
  }
  .fl-dr-copy.trash img,
  .fl-dr-copy.trash video {
    opacity: 0.55;
  }
  .fl-dr-copy img,
  .fl-dr-copy video {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    transition:
      transform var(--fl-motion-fast) var(--fl-ease),
      opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-dr-choose {
    position: absolute;
    inset: 0;
    padding: 0;
    cursor: pointer;
    background: none;
    border: 0;
  }
  .fl-dr-choose.badge-only {
    inset: auto auto 9px 9px;
  }
  .fl-dr-choose:disabled {
    cursor: default;
  }
  .fl-dr-mark,
  .fl-dr-index,
  .fl-dr-suggested {
    position: absolute;
    padding: 4px var(--fl-space-2);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-canvas) 80%, transparent);
    border-radius: var(--fl-radius);
    pointer-events: none;
  }
  .fl-dr-mark {
    bottom: 9px;
    left: 9px;
  }
  .fl-dr-choose.badge-only .fl-dr-mark {
    position: static;
    display: block;
    pointer-events: auto;
  }
  .fl-dr-copy.keep .fl-dr-mark,
  .fl-dr-suggested {
    color: var(--fl-canvas);
    background: var(--fl-accent);
  }
  .fl-dr-copy.trash .fl-dr-mark {
    color: #fff;
    background: var(--fl-danger);
  }
  .fl-dr-index {
    top: 9px;
    left: 9px;
  }
  .fl-dr-suggested {
    top: 9px;
    right: 9px;
  }
  .fl-dr-open {
    position: absolute;
    right: 6px;
    bottom: 6px;
  }
  .fl-dr-facts dt,
  .fl-dr-facts dd {
    margin: 0;
    padding: 4px 0;
    overflow: hidden;
    font-size: var(--fl-font-micro);
    line-height: 18px;
    white-space: nowrap;
    text-overflow: ellipsis;
    border-top: 1px solid color-mix(in srgb, var(--fl-border) 60%, transparent);
  }
  .fl-dr-facts dt,
  .fl-dr-facts dd {
    color: var(--fl-muted);
  }
  .fl-dr-facts dd.differs {
    color: var(--fl-text);
    font-weight: 600;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-dr-copy img {
      transition: none;
    }
  }
</style>
