<script lang="ts">
  /**
   * FL-522, after the prototype's `Thumbs`/`Samples`: a few small pictures beside a row, so a count reads
   * as the photos it is. Only ever ids the server chose for this reader.
   */
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@frameleaf/sdk';

  let { ids, label }: { ids: string[]; label: string } = $props();
</script>

{#if ids.length > 0}
  <ul class="kit-thumbs" aria-label={label}>
    {#each ids as id (id)}
      <li><img src={getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" /></li>
    {/each}
  </ul>
{/if}

<style>
  .kit-thumbs {
    display: flex;
    gap: var(--fl-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  img {
    display: block;
    width: 36px;
    height: 36px;
    object-fit: cover;
    background: var(--fl-raised);
    border-radius: 8px;
  }
</style>
