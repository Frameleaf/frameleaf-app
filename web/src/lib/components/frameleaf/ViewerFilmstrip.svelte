<script lang="ts">
  /**
   * The viewer filmstrip (FL-35) — client only.
   *
   * It shows the neighbours the caller already holds in memory (a gallery's asset list, or
   * the timeline month around the open asset) and navigates through the caller's own
   * authorized navigation callback. It never fetches a list of its own, so it cannot widen
   * what the signed-in user may see.
   */
  import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
  import { motionScrollBehavior } from '$lib/frameleaf/motion';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { t } from 'svelte-i18n';

  type Props = {
    assets: TimelineAsset[];
    currentAssetId: string;
    onSelect: (asset: TimelineAsset) => void;
  };

  let { assets, currentAssetId, onSelect }: Props = $props();

  // One tile for every strip in the viewer (see ViewerStackStrip).
  const tileWidth = 76;
  const tileHeight = 56;
  let strip = $state<HTMLElement>();
  let settled = false;

  // Keep the open item in view as the viewer moves through the collection: at once on open, gliding after.
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    currentAssetId;
    strip
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: settled ? motionScrollBehavior() : 'auto' });
    settled = true;
  });
</script>

{#if assets.length > 1}
  <nav bind:this={strip} aria-label={$t('frameleaf_viewer_filmstrip')} data-testid="viewer-filmstrip" class="fl-strip">
    {#each assets as asset (asset.id)}
      {@const isCurrent = asset.id === currentAssetId}
      <div class="fl-strip-tile" class:current={isCurrent} aria-current={isCurrent ? 'true' : undefined}>
        <Thumbnail
          {asset}
          brokenAssetClass="text-xs"
          thumbnailWidth={tileWidth}
          thumbnailHeight={tileHeight}
          onClick={() => !isCurrent && onSelect(asset)}
          readonly
          showStackedIcon={false}
          disableLinkMouseOver
        />
      </div>
    {/each}
  </nav>
{/if}

<style>
  .fl-strip {
    display: flex;
    gap: var(--fl-space-2);
    width: 100%;
    padding: var(--fl-space-2) var(--fl-space-3);
    overflow: auto hidden;
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--fl-viewer-text) 28%, transparent) transparent;
  }

  /* Green means "this one", here as everywhere else: the open item is at full strength inside an accent ring. */
  .fl-strip-tile {
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    opacity: 0.72;
    box-shadow: 0 0 0 2px transparent;
    transition:
      opacity var(--fl-duration-fade) var(--fl-ease),
      box-shadow var(--fl-duration-fade) var(--fl-ease);
  }

  .fl-strip-tile:hover,
  .fl-strip-tile:focus-within {
    opacity: 1;
  }

  .fl-strip-tile.current {
    opacity: 1;
    box-shadow: 0 0 0 2px var(--fl-accent);
  }
</style>
