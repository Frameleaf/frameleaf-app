<script lang="ts">
  /**
   * A burst, or a group of more than two copies, reviewed as a contact sheet (FL-61), the
   * prototype's `dr-burst-intro`, `dr-frame-preview` and `dr-contact-sheet`.
   *
   * Clicking a frame inspects it; its checkbox marks it a keeper, and shift-click marks a range. A
   * burst's frames are different moments, so nothing is suggested for the trash: the person keeps the
   * moments they want, keeps them all, or stacks the whole burst.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    DUPLICATE_FRAME_PAGE_SIZE,
    dimensionsOf,
    frameOffsetSeconds,
    isBurst,
    type ReviewGroup,
    qualityReasonKey,
  } from '$lib/frameleaf/duplicate-review';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { AssetMediaSize } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiImageMultipleOutline, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Asset = ReviewGroup['assets'][number];

  type Props = {
    group: ReviewGroup;
    actionable: boolean;
    suggestedId: string | null;
    keeperIds: string[];
    focused: Asset;
    framePage: number;
    onToggle: (index: number, shift: boolean) => void;
    onFocus: (asset: Asset) => void;
    onSelectAll: () => void;
    onClear: () => void;
    onStack: () => void;
    onOpen: (asset: Asset) => void;
    onPage: (page: number) => void;
  };

  let {
    group,
    actionable,
    suggestedId,
    keeperIds,
    focused,
    framePage,
    onToggle,
    onFocus,
    onSelectAll,
    onClear,
    onStack,
    onOpen,
    onPage,
  }: Props = $props();

  const burst = $derived(isBurst(group));
  const start = $derived(framePage * DUPLICATE_FRAME_PAGE_SIZE);
  const frames = $derived(group.assets.slice(start, start + DUPLICATE_FRAME_PAGE_SIZE));
  const focusedIndex = $derived(group.assets.findIndex((asset) => asset.id === focused.id));
  const focusedSize = $derived(dimensionsOf(focused));
  const focusedOffset = $derived(frameOffsetSeconds(group, focused));
  const focusedReasons = $derived(group.qualities.find((quality) => quality.assetId === focused.id)?.reasons ?? []);
</script>

<div class="fl-dr-intro">
  <Icon icon={mdiImageMultipleOutline} size="22" aria-hidden={true} />
  <div>
    <strong>{burst ? $t('frameleaf_duplicates_burst_title') : $t('frameleaf_duplicates_sheet_title')}</strong>
    <p>{burst ? $t('frameleaf_duplicates_burst_body') : $t('frameleaf_duplicates_sheet_body')}</p>
  </div>
  <Button variant={burst ? 'primary' : 'default'} disabled={!actionable} onclick={onStack}>
    {burst ? $t('frameleaf_duplicates_stack_burst') : $t('frameleaf_duplicates_stack_group')}
  </Button>
</div>

<div class="fl-dr-preview">
  <div class="fl-dr-preview-image">
    <img
      src={getAssetMediaUrl({ id: focused.id, size: AssetMediaSize.Preview, cacheKey: focused.thumbhash })}
      alt={$t('frameleaf_duplicates_preview_of', { values: { name: focused.originalFileName } })}
    />
  </div>
  <aside>
    <span class="fl-dr-eyebrow">
      {$t('frameleaf_duplicates_frame_of', { values: { index: focusedIndex + 1, total: group.assets.length } })}
    </span>
    <strong>{focused.originalFileName}</strong>
    {#if focusedReasons.length > 0}
      <p>
        {focusedReasons.map((reason) => $t(qualityReasonKey(reason))).join(' · ')}
      </p>
    {/if}
    <small>
      {focusedSize
        ? `${focusedSize.width.toLocaleString($locale)} × ${focusedSize.height.toLocaleString($locale)} · `
        : ''}{getByteUnitString(focused.exifInfo?.fileSizeInByte ?? 0, $locale)}
    </small>
    {#if focusedOffset !== null}
      <small>{$t('frameleaf_duplicates_frame_offset', { values: { seconds: focusedOffset.toFixed(2) } })}</small>
    {/if}
    <div class="fl-dr-preview-actions">
      <Button
        disabled={!actionable}
        pressed={keeperIds.includes(focused.id)}
        onclick={() => onToggle(focusedIndex, false)}
      >
        {$t(keeperIds.includes(focused.id) ? 'frameleaf_duplicates_unmark_keeper' : 'frameleaf_duplicates_mark_keeper')}
      </Button>
      <Button
        variant="quiet"
        label={$t('frameleaf_duplicates_open_photo', { values: { name: focused.originalFileName } })}
        onclick={() => onOpen(focused)}
      >
        <Icon icon={mdiOpenInNew} size="16" aria-hidden={true} />
      </Button>
    </div>
  </aside>
</div>

<div class="fl-dr-sheet-toolbar">
  <strong>
    {$t('frameleaf_duplicates_keepers_selected', {
      values: { count: keeperIds.length, total: group.assets.length },
    })}
  </strong>
  <Button disabled={!actionable} onclick={onSelectAll}>{$t('frameleaf_duplicates_select_all')}</Button>
  <Button disabled={keeperIds.length === 0} onclick={onClear}>{$t('frameleaf_duplicates_clear')}</Button>
  <span>{$t('frameleaf_duplicates_sheet_hint')}</span>
</div>

<div class="fl-dr-sheet" role="group" aria-label={$t('frameleaf_duplicates_sheet_label')}>
  {#each frames as asset, offset (asset.id)}
    {@const index = start + offset}
    {@const keeper = keeperIds.includes(asset.id)}
    <article class:focused={focused.id === asset.id} class:keeper>
      <button
        type="button"
        class="fl-dr-frame"
        aria-label={$t('frameleaf_duplicates_inspect_frame', { values: { index: index + 1 } })}
        aria-pressed={focused.id === asset.id}
        onclick={() => onFocus(asset)}
      >
        <img
          src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
          alt={asset.originalFileName}
          loading="lazy"
          draggable="false"
        />
      </button>
      <label>
        <input
          type="checkbox"
          aria-label={$t('frameleaf_duplicates_keep_frame', { values: { index: index + 1 } })}
          checked={keeper}
          disabled={!actionable}
          onclick={(event) => {
            event.preventDefault();
            onToggle(index, event.shiftKey);
          }}
        />
        <span>{String(index + 1).padStart(2, '0')}</span>
        {#if asset.id === suggestedId}
          <small>{$t('frameleaf_duplicates_suggested')}</small>
        {:else if keeper}
          <small>{$t('frameleaf_duplicates_keeper')}</small>
        {/if}
      </label>
    </article>
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
    <Button disabled={start + DUPLICATE_FRAME_PAGE_SIZE >= group.assets.length} onclick={() => onPage(framePage + 1)}>
      {$t('frameleaf_duplicates_next_frames')}
    </Button>
  </div>
{/if}

<style>
  .fl-dr-intro {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 13px 15px;
    margin-bottom: 14px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-intro > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .fl-dr-intro > div {
    flex: 1;
  }
  .fl-dr-intro strong {
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .fl-dr-intro p {
    max-width: 560px;
    margin: 5px 0 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-preview {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 200px;
    gap: 18px;
    margin-bottom: 16px;
    overflow: hidden;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-preview-image {
    height: 240px;
    overflow: hidden;
    background: var(--fl-canvas);
  }
  .fl-dr-preview-image img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .fl-dr-preview aside {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: 8px;
    min-width: 0;
    padding: 18px 14px 14px 0;
  }
  .fl-dr-eyebrow {
    font-size: var(--fl-font-micro);
    letter-spacing: 0.09em;
    color: var(--fl-muted);
    text-transform: uppercase;
  }
  .fl-dr-preview strong {
    font-size: var(--fl-font-small);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .fl-dr-preview p {
    margin: 0;
    font-size: var(--fl-font-micro);
  }
  .fl-dr-preview small {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-preview-actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .fl-dr-sheet-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 12px 0;
  }
  .fl-dr-sheet-toolbar strong {
    margin-inline-end: 4px;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .fl-dr-sheet-toolbar span {
    margin-inline-start: auto;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-sheet {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
    gap: 9px;
  }
  article {
    overflow: hidden;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  article.focused {
    outline: 1px solid var(--fl-text);
    outline-offset: 1px;
  }
  article.keeper {
    background: color-mix(in srgb, var(--fl-accent) 10%, var(--fl-panel));
    border-color: var(--fl-accent);
  }
  .fl-dr-frame {
    display: block;
    width: 100%;
    aspect-ratio: 1.4;
    padding: 0;
    overflow: hidden;
    background: var(--fl-canvas);
    border: 0;
  }
  .fl-dr-frame img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  label {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 34px;
    padding: 5px 8px;
    font-size: var(--fl-font-micro);
    cursor: pointer;
  }
  label small {
    margin-inline-start: auto;
    font-size: var(--fl-font-micro);
    color: var(--fl-accent);
  }
  .fl-dr-pages {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin: 16px 0;
    font-size: var(--fl-font-micro);
  }
  @media (max-width: 700px) {
    .fl-dr-intro {
      flex-wrap: wrap;
    }
    .fl-dr-intro > div {
      flex-basis: calc(100% - 40px);
    }
    .fl-dr-intro > :global(button) {
      width: 100%;
    }
    .fl-dr-preview {
      grid-template-columns: 1fr;
      gap: 0;
    }
    .fl-dr-preview-image {
      height: 200px;
    }
    .fl-dr-preview aside {
      flex-flow: row wrap;
      align-items: center;
      gap: 8px 12px;
      padding: 12px;
    }
    .fl-dr-preview strong {
      flex-basis: 100%;
    }
    .fl-dr-sheet {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
    }
    label small {
      display: none;
    }
    .fl-dr-sheet-toolbar span {
      width: 100%;
      margin-inline-start: 0;
    }
  }
</style>
