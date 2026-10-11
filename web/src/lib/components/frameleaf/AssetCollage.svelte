<script lang="ts">
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageMultipleOutline } from '@mdi/js';

  /**
   * Cover collage of up to four items with a "+N" for the rest: the design's `AssetCollage`
   * (`SharedLinkForm.jsx:31-53`, `.sl-collage` in sharing.css:154-198), drawn from the items' real
   * thumbnails. One item fills the cover, two sit side by side, three put the first beside the other
   * two, four make the 2 x 2. Decorative: the caller names what is shared in text beside it.
   *
   * The caller sizes it: `--fl-collage-aspect` (4 / 3 unless set) and `--fl-collage-gap`, the colour
   * between the pictures.
   */
  let {
    ids,
    count = ids.length,
    large = false,
    class: className = '',
  }: {
    ids: string[];
    count?: number;
    /** A card-wide cover: a picture on its own is then drawn well beyond a thumbnail's size. */
    large?: boolean;
    class?: string;
  } = $props();

  const shown = $derived(ids.slice(0, 4));
  const size = $derived(large && shown.length === 1 ? AssetMediaSize.Preview : AssetMediaSize.Thumbnail);
</script>

<div class="fl-collage {className}" data-count={shown.length} aria-hidden="true">
  {#each shown as id (id)}
    <img src={getAssetMediaUrl({ id, size })} alt="" loading="lazy" />
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
    aspect-ratio: var(--fl-collage-aspect, 4 / 3);
    gap: 2px;
    overflow: hidden;
    background: var(--fl-collage-gap, var(--fl-border));
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
    /* Shown until the picture arrives (.sl-collage img, sharing.css:176-187). */
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 4%);
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
    padding: 3px 8px;
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, black, transparent 33%);
    color: white;
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
</style>
