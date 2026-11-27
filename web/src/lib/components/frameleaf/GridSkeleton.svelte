<script lang="ts">
  /**
   * Tiles that stand in for a grid of photos while it loads (FL-1810, prototype `GridSkeleton`).
   * `columns` and `aspect` match the grid that replaces it; `minTile` instead fills the width with
   * tiles at least that wide, for grids whose column count follows the window.
   */
  import { t } from 'svelte-i18n';

  let {
    tiles = 8,
    columns = 4,
    aspect = '1',
    minTile,
  }: { tiles?: number; columns?: number; aspect?: string; minTile?: string } = $props();

  const items = $derived(Array.from({ length: Math.max(1, Math.floor(tiles)) }, (_, index) => index));
</script>

<div
  class="fl-skeleton-grid"
  style:grid-template-columns={minTile ? `repeat(auto-fill, minmax(${minTile}, 1fr))` : `repeat(${columns}, 1fr)`}
  aria-busy="true"
  aria-label={$t('loading')}
  data-testid="frameleaf-grid-skeleton"
>
  {#each items as index (index)}
    <span class="fl-skeleton" style:aspect-ratio={aspect} aria-hidden="true"></span>
  {/each}
</div>

<style>
  /* FL-1810: the placeholder carries its own look, so it shows in portalled surfaces outside
     .frameleaf too (the photo viewer's info panel, the font viewer); base.css keeps the same rule. */
  .fl-skeleton {
    display: block;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
    animation: fl-skeleton-pulse var(--fl-duration-pulse) var(--fl-ease) infinite alternate;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-skeleton {
      animation: none;
    }
  }
  div {
    display: grid;
    gap: var(--fl-space-2);
  }
</style>
