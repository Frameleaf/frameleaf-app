<script lang="ts">
  /**
   * Tiles that stand in for a grid of photos while it loads (FL-1810, prototype `GridSkeleton`).
   * `columns` and `aspect` match the grid that replaces it.
   */
  import { t } from 'svelte-i18n';

  let { tiles = 8, columns = 4, aspect = '1' }: { tiles?: number; columns?: number; aspect?: string } = $props();

  const items = $derived(Array.from({ length: Math.max(1, Math.floor(tiles)) }, (_, index) => index));
</script>

<div
  class="fl-skeleton-grid"
  style:grid-template-columns="repeat({columns}, 1fr)"
  aria-busy="true"
  aria-label={$t('loading')}
  data-testid="frameleaf-grid-skeleton"
>
  {#each items as index (index)}
    <span class="fl-skeleton" style:aspect-ratio={aspect} aria-hidden="true"></span>
  {/each}
</div>

<style>
  div {
    display: grid;
    gap: var(--fl-space-2);
  }
</style>
