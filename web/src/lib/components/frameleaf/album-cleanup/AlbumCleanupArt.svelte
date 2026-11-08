<script lang="ts">
  import '$lib/frameleaf/album-cleanup.css';
  import { getAssetMediaUrl } from '$lib/utils';
  import type { CleanupPlan } from '$lib/frameleaf/album-cleanup';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /** Messy album names turning into tidy collections, drawn from the person's own covers and names. */
  interface Props {
    plan: CleanupPlan;
    /** Names to scatter on the pile, the messiest first. */
    names: string[];
    covers: string[];
  }

  let { plan, names, covers }: Props = $props();

  const pile = $derived(names.slice(0, 5));
  const cover = (index: number) => {
    const id = covers[index % Math.max(covers.length, 1)];
    return id ? getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail }) : undefined;
  };
  const tidy = $derived(plan.structure.slice(0, 3));
</script>

<div class="ac-art" aria-hidden="true">
  <div class="ac-pile">
    {#each pile as name, index (`${name}-${index}`)}
      <span class={`ac-pile-card c${index}`}>
        {#if cover(index + 12)}
          <img src={cover(index + 12)} alt="" draggable="false" loading="lazy" />
        {:else}
          <span class="ac-pile-blank"></span>
        {/if}
        <small>{name}</small>
      </span>
    {/each}
  </div>
  <span class="ac-art-arrow"><Icon icon={mdiArrowRight} size="22" /></span>
  <div class="ac-tidy">
    {#each tidy as node, group (node.id)}
      <span class="ac-tidy-row">
        <span class="ac-tidy-mosaic">
          {#each [0, 1, 2, 3] as tile (tile)}
            {#if cover(group * 4 + tile)}
              <img src={cover(group * 4 + tile)} alt="" draggable="false" loading="lazy" />
            {:else}
              <i></i>
            {/if}
          {/each}
        </span>
        <span class="ac-tidy-text">
          <strong>{node.name}</strong>
          <small>{$t('frameleaf_album_cleanup_album_count', { values: { count: node.albumCount } })}</small>
        </span>
      </span>
    {/each}
  </div>
</div>
