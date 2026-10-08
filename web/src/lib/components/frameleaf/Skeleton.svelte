<script lang="ts">
  /**
   * A loading placeholder in the shape of what is coming, so content does not jump when it lands.
   * Wrap the group in something with `aria-busy="true"`; the placeholders themselves are hidden
   * from assistive technology.
   *
   * - `variant="text"`: `lines` bars of body text, the last one shorter.
   * - `variant="block"`: one box; give it `width`/`height` or an `aspect` ratio (a card, a chart).
   * - `variant="tile"`: a photo placeholder. With `thumbhash` (the data URL from
   *   `thumbHashToDataURL`) the blurred preview shows at once and does not pulse; without one it is
   *   a quiet square. Fade the real image in over it with the `fl-reveal` class.
   * - `variant="circle"`: an avatar.
   *
   * It breathes slowly and holds still under Reduce Motion (base.css `fl-skeleton`).
   */
  let {
    variant = 'text',
    lines = 1,
    width,
    height,
    aspect,
    thumbhash,
  }: {
    variant?: 'text' | 'block' | 'tile' | 'circle';
    lines?: number;
    /** Any CSS length. */
    width?: string;
    height?: string;
    /** A CSS aspect-ratio such as `4 / 3`; tiles default to square. */
    aspect?: string;
    thumbhash?: string;
  } = $props();

  const rows = $derived(Array.from({ length: Math.max(1, Math.floor(lines)) }, (_, index) => index));
</script>

{#if variant === 'text'}
  <span class="fl-skeleton-text" style:width aria-hidden="true">
    {#each rows as row (row)}
      <span class="fl-skeleton line" class:short={rows.length > 1 && row === rows.length - 1}></span>
    {/each}
  </span>
{:else}
  <span
    class="fl-skeleton {variant}"
    class:still={!!thumbhash}
    style:width
    style:height
    style:aspect-ratio={aspect}
    style:background-image={thumbhash ? `url("${thumbhash}")` : undefined}
    aria-hidden="true"
  ></span>
{/if}

<style>
  .fl-skeleton-text {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    width: 100%;
  }
  .line {
    height: 0.75em;
    margin-block: 0.25em;
    border-radius: var(--fl-radius-xs);
  }
  .line.short {
    width: 60%;
  }
  .block {
    width: 100%;
    min-height: var(--fl-space-6);
    border-radius: var(--fl-radius-card);
  }
  .tile {
    width: 100%;
    aspect-ratio: 1;
    border-radius: 0;
    background-size: cover;
    background-position: center;
  }
  .circle {
    width: var(--fl-space-10);
    aspect-ratio: 1;
    border-radius: 50%;
  }
  /* A thumbhash is already a picture of what is coming: it does not pulse. */
  .still {
    animation: none;
  }
</style>
