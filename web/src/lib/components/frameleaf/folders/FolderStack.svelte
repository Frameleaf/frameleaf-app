<script lang="ts">
  /**
   * A folder's cover: up to three of its photos, slightly offset like a pile of prints, with the
   * newest in front (mock `Stack`, `discovery-v2.css` "cards with a pile of prints"). A folder with
   * no cover yet shows a quiet folder tile. Decorative: the caller names the folder beside it.
   *
   * The ring between the prints is the colour of the surface under the pile; set `--fl-stack-ring`
   * where that is not the page canvas (the columns view sits on a panel).
   */
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiFolderOutline } from '@mdi/js';

  let {
    ids,
    mini = false,
  }: {
    /** The folder's cover asset ids, the front print first. */
    ids: readonly string[];
    /** The 40px pile beside a row of the columns view. */
    mini?: boolean;
  } = $props();

  // Back print first, so the front one is drawn last and sits on top.
  const prints = $derived(
    ids
      .slice(0, 3)
      .map((id, layer) => ({ id, layer }))
      .reverse(),
  );
</script>

{#if prints.length === 0}
  <span class="stack empty" class:mini aria-hidden="true">
    <Icon icon={mdiFolderOutline} size={mini ? '16' : '28'} />
  </span>
{:else}
  <span class="stack" class:mini data-prints={prints.length} aria-hidden="true">
    {#each prints as print (print.id)}
      <span class="print" data-layer={print.layer}>
        <img
          src={getAssetMediaUrl({ id: print.id, size: AssetMediaSize.Thumbnail })}
          alt=""
          loading="lazy"
          draggable="false"
        />
      </span>
    {/each}
  </span>
{/if}

<style>
  .stack {
    position: relative;
    display: block;
    aspect-ratio: 4 / 3;
  }
  .print {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    /* The ring that separates overlapping avatars, used here between prints. */
    box-shadow:
      0 0 0 2px var(--fl-stack-ring, var(--fl-canvas)),
      var(--fl-shadow-1);
  }
  .print img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .stack[data-prints='3'] .print[data-layer='0'] {
    inset: 14% 0 0 0;
  }
  .stack[data-prints='3'] .print[data-layer='1'] {
    inset: 7% 6% 7% 6%;
  }
  .stack[data-prints='3'] .print[data-layer='2'] {
    inset: 0 12% 14% 12%;
  }
  .stack[data-prints='2'] .print[data-layer='0'] {
    inset: 8% 0 0 0;
  }
  .stack[data-prints='2'] .print[data-layer='1'] {
    inset: 0 6% 8% 6%;
  }
  /* The prints behind are dimmed, not faded, so they read as depth in both themes. */
  .print[data-layer='1'] img {
    filter: brightness(0.8);
  }
  .print[data-layer='2'] img {
    filter: brightness(0.62);
  }
  .stack.empty {
    display: grid;
    place-items: center;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-muted);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fl-text), transparent 91%);
  }
  .stack.mini {
    width: 40px;
    flex-shrink: 0;
  }
  .stack.mini .print {
    border-radius: 5px;
    box-shadow: 0 0 0 1.5px var(--fl-stack-ring, var(--fl-panel));
  }
  .stack.mini.empty {
    border-radius: 5px;
  }
</style>
