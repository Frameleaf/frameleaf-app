<script lang="ts">
  /**
   * The viewer's stack card (FL-35, VIEWER-P3).
   *
   * The template's `StackStrip` (MediaViewer.jsx:2026-2063, media-viewer.css:616-685): a small card
   * centred above the footer with "Stack · N items" and a square thumbnail per member, the open one
   * ringed in the accent and the primary marked along its bottom edge. Choosing a member opens it;
   * pointing at one previews it. The decisions about the stack (keep this and remove the rest, set as
   * primary, unstack) live in the More menu's Stack group, as in the template
   * (`media-viewer.mjs` `viewerActionGroups`), so nothing destructive is one tap away here.
   */
  import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AssetResponseDto, StackResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCrownOutline, mdiLayersTripleOutline } from '@mdi/js';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    stack: StackResponseDto;
    asset: AssetResponseDto;
    onSelect: (asset: AssetResponseDto) => void;
    onPreview: (asset: AssetResponseDto | undefined) => void;
  };

  let { stack, asset, onSelect, onPreview }: Props = $props();

  /** media-viewer.css:647-651, 1996-1999: 60px square tiles inside a 2px ring, 52px on phones. */
  const TILE = $derived(mediaQueryManager.maxMd ? 48 : 56);
</script>

<section
  class="fl-stack fl-continuous-corners dark"
  data-testid="viewer-stack-strip"
  aria-label={$t('frameleaf_viewer_stack_count', { values: { count: stack.assets.length } })}
>
  <div class="fl-stack-head">
    <Icon icon={mdiLayersTripleOutline} size={ICON_SIZE.sm} aria-hidden />
    <span>{$t('frameleaf_viewer_stack_count', { values: { count: stack.assets.length } })}</span>
  </div>

  <ul class="fl-stack-items">
    {#each stack.assets as stackedAsset (stackedAsset.id)}
      {@const isCurrent = stackedAsset.id === asset.id}
      <li class="fl-stack-tile" class:current={isCurrent} aria-current={isCurrent ? 'true' : undefined}>
        <Thumbnail
          brokenAssetClass="text-xs"
          asset={toTimelineAsset(stackedAsset)}
          onClick={() => !isCurrent && onSelect(stackedAsset)}
          onMouseEvent={({ isMouseOver }) => onPreview(isMouseOver ? stackedAsset : undefined)}
          readonly
          thumbnailWidth={TILE}
          thumbnailHeight={TILE}
          showStackedIcon={false}
          disableLinkMouseOver
        />

        {#if stack.primaryAssetId === stackedAsset.id}
          <span class="fl-stack-primary">
            <Icon icon={mdiCrownOutline} size={ICON_SIZE.xs} aria-hidden />
            {$t('frameleaf_viewer_stack_primary')}
          </span>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  /* media-viewer.css:616-629: a small frosted card, centred by its slot above the footer. */
  .fl-stack {
    max-width: calc(100vw - var(--fl-space-8));
    padding: var(--fl-space-2) 10px 10px;
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-card);
    background: color-mix(in srgb, var(--fl-viewer-panel) 90%, transparent);
    backdrop-filter: var(--fl-material-blur);
    box-shadow: var(--fl-shadow-1);
    color: var(--fl-viewer-text);
  }

  /* media-viewer.css:630-637 */
  .fl-stack-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: var(--fl-space-2);
    color: var(--fl-viewer-muted);
    font-size: var(--fl-font-micro);
  }

  /* media-viewer.css:638-646 */
  .fl-stack-items {
    display: flex;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    overflow: auto hidden;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--fl-viewer-text) 28%, transparent) transparent;
  }

  /* media-viewer.css:647-668: the open member ringed in the accent. */
  .fl-stack-tile {
    position: relative;
    flex-shrink: 0;
    width: 60px;
    height: 60px;
    overflow: hidden;
    border: 2px solid transparent;
    border-radius: var(--fl-radius-control);
    background: var(--fl-viewer-raised);
  }

  .fl-stack-tile.current {
    border-color: var(--fl-accent);
  }

  .fl-stack-tile :global(img) {
    object-fit: cover;
  }

  /* media-viewer.css:669-685: "Primary" along the bottom edge. */
  .fl-stack-primary {
    position: absolute;
    inset-inline: 0;
    bottom: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: var(--fl-space-half) var(--fl-space-1);
    background: rgb(0 0 0 / 67%);
    color: #fff;
    font-size: 10px;
    font-weight: 550;
    pointer-events: none;
  }

  @media (max-width: 767px) {
    .fl-stack-tile {
      width: 52px;
      height: 52px;
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-stack {
      background: var(--fl-viewer-panel);
      backdrop-filter: none;
    }
  }
</style>
