<script lang="ts">
  /**
   * A list where every row has the same shape (see Item).
   *
   * `noMeasure`: the rows never have a measure, so the name and the status share its room (the
   * prototype's Overview checks). `plain`: the rows are only a name and a status, the status at the
   * end (the prototype's "What a licence gives"). `wideName`: a directory of things to open, the
   * name taking two thirds and the status the rest (the prototype's Tools). Use them for lists that are built that way, not for
   * a list whose measure or action is only missing in one state, so the page keeps its columns.
   */
  import type { Snippet } from 'svelte';

  let {
    noMeasure = false,
    plain = false,
    wideName = false,
    children,
  }: { noMeasure?: boolean; plain?: boolean; wideName?: boolean; children: Snippet } = $props();
</script>

<ul
  class="kit-items"
  class:no-measure={noMeasure && !plain && !wideName}
  class:wide-name={wideName && !plain}
  class:plain
>
  {@render children()}
</ul>

<style>
  /*
   * The list owns the columns and each row takes them as a subgrid (Item.svelte). The action column
   * has a fixed width (backup-v2.css:244, settings-v2/kit.css:26), so the name, status and measure
   * columns start at the same place in every list on every page: 128px holds the app's widest single
   * action ("See licences ›" at the 44px control size), 216px a row with two. A wider action still
   * widens its own list rather than running into the measure.
   */
  .kit-items {
    --kit-action-column: minmax(128px, max-content);
    display: grid;
    grid-template-columns: 44px minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) var(--kit-action-column);
    column-gap: var(--fl-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  /* A row with two actions (Check one… and Check now), side by side or in a wrapper of their own. */
  :global(.kit-items:has(> .kit-item > .action > :nth-child(2), > .kit-item > .action > div > :nth-child(2))) {
    --kit-action-column: minmax(216px, max-content);
  }
  .kit-items.no-measure {
    grid-template-columns: 44px minmax(0, 1fr) minmax(0, 1fr) var(--kit-action-column);
  }
  /* Every action is a short "Open ›", so the prototype's 104px column (status at x994 in Tools). */
  .kit-items.wide-name {
    grid-template-columns: 44px minmax(0, 2fr) minmax(0, 1fr) minmax(104px, max-content);
  }
  .kit-items.plain {
    grid-template-columns: 44px minmax(0, 1fr) 160px;
  }
  .kit-items > :global(:not(.kit-item)) {
    grid-column: 1 / -1;
  }
  @container kit (max-width: 860px) {
    .kit-items,
    .kit-items.no-measure,
    .kit-items.wide-name,
    .kit-items.plain {
      grid-template-columns: 44px minmax(0, 1fr) auto;
    }
  }
</style>
