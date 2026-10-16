<script lang="ts" module>
  export type TellRow = {
    id: string;
    label: string;
    help?: string;
    /** A link under the help, to the page where this is acted on. */
    link?: { text: string; href: string };
  };
</script>

<script lang="ts">
  /**
   * "Tell me about…": one row per kind of news, one column per way of hearing about it. The page
   * draws each cell (a Switch, or a word such as "Always") through `cell`.
   */
  import type { Snippet } from 'svelte';

  let {
    heading,
    columns,
    rows,
    cell,
    detail,
  }: {
    heading: string;
    columns: string[];
    rows: TellRow[];
    cell: Snippet<[TellRow, number]>;
    /** More about one row under its help, such as a closed "options" disclosure (Tools & sidebar). */
    detail?: Snippet<[TellRow]>;
  } = $props();
</script>

<div class="kit-tell" role="table" aria-label={heading} style:--kit-tell-columns={columns.length}>
  <div class="head" role="row">
    <span role="columnheader"><span class="sr-only">{heading}</span></span>
    {#each columns as column (column)}
      <span role="columnheader">{column}</span>
    {/each}
  </div>
  {#each rows as row (row.id)}
    <div class="row" role="row">
      <div role="rowheader">
        <strong>{row.label}</strong>
        {#if row.help}<p>{row.help}</p>{/if}
        {#if row.link}<a href={row.link.href}>{row.link.text}</a>{/if}
        {@render detail?.(row)}
      </div>
      {#each columns as column, index (column)}
        <div class="cell" role="cell">
          <span class="cap" aria-hidden="true">{column}</span>
          {@render cell(row, index)}
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .kit-tell {
    padding-bottom: var(--fl-space-2);
  }
  .head,
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) repeat(var(--kit-tell-columns), 132px);
    align-items: center;
    gap: var(--fl-space-4);
  }
  .head {
    padding-bottom: var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .row {
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  strong {
    display: block;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  p {
    max-width: 520px;
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  a {
    display: inline-block;
    margin-top: var(--fl-space-2);
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
    font-weight: 600;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-sm);
  }
  .cell {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .cap {
    display: none;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @container kit (max-width: 620px) {
    .head {
      display: none;
    }
    .row {
      grid-template-columns: repeat(var(--kit-tell-columns), minmax(0, 1fr));
      gap: var(--fl-space-3);
    }
    .row > [role='rowheader'] {
      grid-column: 1 / -1;
    }
    .cell {
      display: grid;
      align-content: start;
      gap: var(--fl-space-1);
    }
    .cap {
      display: block;
    }
  }
</style>
