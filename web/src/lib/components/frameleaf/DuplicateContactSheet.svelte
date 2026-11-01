<script lang="ts">
  /**
   * A burst or a group of look-alikes, reviewed as a contact sheet (FL-61, FL-558): the prototype's
   * `dt-sheet`.
   *
   * Every photo of the group is on screen at once, beside a large preview of the one under the
   * pointer. Clicking a photo marks it a keeper and shift-click marks a range. These are different
   * moments, so nothing is suggested: the person keeps the moments they want, keeps them all, or
   * stacks them (the decision bar's Stack, the primary action for a burst).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    DUPLICATE_FRAME_PAGE_SIZE,
    dimensionsOf,
    frameOffsetSeconds,
    type ReviewGroup,
  } from '$lib/frameleaf/duplicate-review';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircle, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Asset = ReviewGroup['assets'][number];

  type Props = {
    group: ReviewGroup;
    actionable: boolean;
    keeperIds: string[];
    focused: Asset;
    framePage: number;
    onToggle: (index: number, shift: boolean) => void;
    onFocus: (asset: Asset) => void;
    onSelectAll: () => void;
    onClear: () => void;
    onOpen: (asset: Asset) => void;
    onPage: (page: number) => void;
  };

  let {
    group,
    actionable,
    keeperIds,
    focused,
    framePage,
    onToggle,
    onFocus,
    onSelectAll,
    onClear,
    onOpen,
    onPage,
  }: Props = $props();

  const start = $derived(framePage * DUPLICATE_FRAME_PAGE_SIZE);
  const frames = $derived(group.assets.slice(start, start + DUPLICATE_FRAME_PAGE_SIZE));
  const focusedIndex = $derived(group.assets.findIndex((asset) => asset.id === focused.id));
  const focusedSize = $derived(dimensionsOf(focused));

  /** A burst frame reads as seconds after the first; a look-alike as the time it was taken. */
  const when = (asset: Asset) => {
    const offset = frameOffsetSeconds(group, asset);
    if (offset !== null) {
      return $t('frameleaf_duplicates_frame_offset', { values: { seconds: offset.toFixed(1) } });
    }
    const value = asset.localDateTime ?? asset.exifInfo?.dateTimeOriginal;
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString($locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })
      : '';
  };
</script>

<div class="fl-dr-sheet-layout">
  <div class="fl-dr-sheet-side">
    <div class="fl-dr-sheet-toolbar">
      <strong>
        {$t('frameleaf_duplicates_keepers_selected', {
          values: { count: keeperIds.length, total: group.assets.length },
        })}
      </strong>
      <Button disabled={!actionable} onclick={onSelectAll}>{$t('frameleaf_duplicates_select_all')}</Button>
      <Button disabled={keeperIds.length === 0} onclick={onClear}>{$t('frameleaf_duplicates_clear')}</Button>
    </div>

    <div class="fl-dr-sheet" role="group" aria-label={$t('frameleaf_duplicates_sheet_label')}>
      {#each frames as asset, offset (asset.id)}
        {@const index = start + offset}
        {@const keeper = keeperIds.includes(asset.id)}
        <button
          type="button"
          class="fl-dr-frame"
          class:focused={focused.id === asset.id}
          class:keeper
          data-asset-id={asset.id}
          aria-pressed={keeper}
          aria-label={$t('frameleaf_duplicates_keep_frame', { values: { index: index + 1 } })}
          disabled={!actionable}
          onclick={(event) => onToggle(index, event.shiftKey)}
          onpointerenter={() => onFocus(asset)}
          onfocus={() => onFocus(asset)}
        >
          <img
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
            alt=""
            loading="lazy"
            draggable="false"
          />
          <span>{when(asset)}</span>
          {#if keeper}
            <Icon icon={mdiCheckCircle} size="20" aria-hidden={true} />
          {/if}
        </button>
      {/each}
    </div>

    {#if group.assets.length > DUPLICATE_FRAME_PAGE_SIZE}
      <div class="fl-dr-pages">
        <Button disabled={framePage === 0} onclick={() => onPage(framePage - 1)}>
          {$t('frameleaf_duplicates_previous_frames')}
        </Button>
        <span>
          {$t('frameleaf_duplicates_frames_range', {
            values: {
              from: start + 1,
              to: Math.min(group.assets.length, start + DUPLICATE_FRAME_PAGE_SIZE),
              total: group.assets.length,
            },
          })}
        </span>
        <Button
          disabled={start + DUPLICATE_FRAME_PAGE_SIZE >= group.assets.length}
          onclick={() => onPage(framePage + 1)}
        >
          {$t('frameleaf_duplicates_next_frames')}
        </Button>
      </div>
    {/if}
  </div>

  <aside class="fl-dr-preview">
    <div class="fl-dr-preview-image">
      <img
        src={getAssetMediaUrl({ id: focused.id, size: AssetMediaSize.Preview, cacheKey: focused.thumbhash })}
        alt={$t('frameleaf_duplicates_preview_of', { values: { name: focused.originalFileName } })}
      />
    </div>
    <div class="fl-dr-preview-text">
      <strong>
        {$t('frameleaf_duplicates_frame_of', { values: { index: focusedIndex + 1, total: group.assets.length } })}
        · {when(focused)}
      </strong>
      <small>
        {focused.originalFileName} ·
        {focusedSize
          ? `${focusedSize.width.toLocaleString($locale)} × ${focusedSize.height.toLocaleString($locale)} · `
          : ''}{getByteUnitString(focused.exifInfo?.fileSizeInByte ?? 0, $locale)}
      </small>
    </div>
    <Button
      variant="quiet"
      label={$t('frameleaf_duplicates_open_photo', { values: { name: focused.originalFileName } })}
      onclick={() => onOpen(focused)}
    >
      <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
    </Button>
  </aside>
</div>

<style>
  .fl-dr-sheet-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 40%);
    gap: 18px;
    height: 100%;
    min-height: 0;
  }
  .fl-dr-sheet-side {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 10px;
    min-height: 0;
  }
  .fl-dr-sheet-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .fl-dr-sheet-toolbar strong {
    margin-inline-end: auto;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .fl-dr-sheet {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    grid-auto-rows: max-content;
    align-content: start;
    gap: 8px;
    min-height: 0;
    padding: 3px;
    overflow: auto;
    scrollbar-width: thin;
  }
  .fl-dr-frame {
    position: relative;
    display: block;
    padding: 0;
    overflow: hidden;
    cursor: pointer;
    background: var(--fl-canvas);
    border: 2px solid transparent;
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-frame:disabled {
    cursor: default;
  }
  .fl-dr-frame.focused {
    outline: var(--fl-focus-ring);
    outline-offset: 1px;
  }
  .fl-dr-frame.keeper {
    border-color: var(--fl-accent);
  }
  .fl-dr-frame img {
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
  }
  .fl-dr-frame span {
    position: absolute;
    bottom: 5px;
    left: 5px;
    padding: 1px 6px;
    font-size: var(--fl-font-micro);
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-canvas) 70%, transparent);
    border-radius: var(--fl-radius);
  }
  .fl-dr-frame :global(svg) {
    position: absolute;
    top: 5px;
    right: 5px;
    color: var(--fl-accent);
    background: var(--fl-viewer-text);
    border-radius: 50%;
  }
  .fl-dr-preview {
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr) auto;
    align-content: start;
    align-items: start;
    gap: 8px;
    min-height: 0;
  }
  .fl-dr-preview-image {
    grid-column: 1 / -1;
    aspect-ratio: 4 / 3;
    max-height: calc(var(--fl-dr-stage, 480px) - 140px);
    overflow: hidden;
    background: var(--fl-canvas);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-preview-image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .fl-dr-preview-text {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  .fl-dr-preview-text strong {
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .fl-dr-preview-text small {
    overflow: hidden;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fl-dr-pages {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    font-size: var(--fl-font-micro);
  }
  @media (max-width: 900px) {
    .fl-dr-sheet-layout {
      grid-template-columns: 1fr;
    }
    .fl-dr-preview {
      display: none;
    }
  }
</style>
