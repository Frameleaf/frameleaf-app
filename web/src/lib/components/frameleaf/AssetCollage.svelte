<script lang="ts">
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageMultipleOutline } from '@mdi/js';

  /**
   * Cover collage of up to four items with a "+N" for the rest: the design's `AssetCollage`
   * (`SharedLinkForm.jsx:31-53`), drawn from the items' real thumbnails. Decorative: the caller
   * names what is shared in text beside it.
   */
  let { ids, count = ids.length, class: className = '' }: { ids: string[]; count?: number; class?: string } = $props();

  const shown = $derived(ids.slice(0, 4));
</script>

<div class="fl-collage {className}" data-count={shown.length} aria-hidden="true">
  {#each shown as id (id)}
    <img src={getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
  {:else}
    <span class="fl-collage-blank"><Icon icon={mdiImageMultipleOutline} size="28" /></span>
  {/each}
  {#if shown.length > 0 && count > shown.length}
    <span class="fl-collage-more">+{count - shown.length}</span>
  {/if}
</div>

<style>
  .fl-collage {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-auto-rows: 1fr;
    aspect-ratio: 4 / 3;
    gap: 2px;
    overflow: hidden;
    background: var(--fl-border);
  }
  .fl-collage[data-count='0'],
  .fl-collage[data-count='1'] {
    grid-template-columns: 1fr;
  }
  .fl-collage[data-count='3'] img:first-child {
    grid-row: span 2;
  }
  .fl-collage img {
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: cover;
    display: block;
  }
  .fl-collage-blank {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .fl-collage-more {
    position: absolute;
    right: 8px;
    bottom: 8px;
    padding: 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, black, transparent 40%);
    color: white;
    font-size: var(--fl-font-micro);
  }
</style>
