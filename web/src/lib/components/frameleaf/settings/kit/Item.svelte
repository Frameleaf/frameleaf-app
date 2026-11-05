<script lang="ts">
  /**
   * One row of an ItemList: an icon tile, a name, a status, a measure and one action, always in
   * those columns so a list of different things still lines up. `off` greys the tile for something
   * that is not in use; `quiet` does the same for a row that is only for reference. `media` takes
   * the tile's place when the row is a person or a picture.
   */
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { Icon } from '@frameleaf/ui';
  import type { Snippet } from 'svelte';

  let {
    icon,
    media,
    quiet = false,
    off = false,
    name,
    tag,
    detail,
    tone = 'off',
    status,
    note,
    measure,
    action,
  }: {
    icon?: string;
    media?: Snippet;
    quiet?: boolean;
    off?: boolean;
    name: string;
    /** A small tag after the name, such as "Supporter". */
    tag?: Snippet;
    detail?: string;
    tone?: KitTone;
    status?: string;
    note?: string;
    measure?: Snippet;
    action?: Snippet;
  } = $props();
</script>

<li class="kit-item" class:is-off={off}>
  {#if media}
    <span class="media">{@render media()}</span>
  {:else}
    <span class="tile" class:is-quiet={quiet || off} aria-hidden="true">
      {#if icon}<Icon {icon} size="22" />{/if}
    </span>
  {/if}
  <div class="name">
    <strong
      >{name}{#if tag}<span class="tag">{@render tag()}</span>{/if}</strong
    >
    {#if detail}<span>{detail}</span>{/if}
  </div>
  <div class="status">
    {#if status}<Pill {tone}>{status}</Pill>{/if}
    {#if note}<small>{note}</small>{/if}
  </div>
  <div class="measure">{@render measure?.()}</div>
  <div class="action">{@render action?.()}</div>
</li>

<style>
  .kit-item {
    display: grid;
    /* The columns of ItemList.svelte, for a row on its own. */
    grid-template-columns: 44px minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(128px, max-content);
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  /* Inside an ItemList the row takes the list's columns (ItemList.svelte). */
  :global(.kit-items) > .kit-item {
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
  }
  /* ItemList `noMeasure`, `wideName` and `plain` have no column for these. */
  :global(.kit-items.no-measure) > .kit-item > .measure,
  :global(.kit-items.wide-name) > .kit-item > .measure,
  :global(.kit-items.plain) > .kit-item > :is(.measure, .action) {
    display: none;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    border-radius: var(--fl-radius-card);
  }
  .media {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
  }
  .tile.is-quiet {
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .name {
    min-width: 0;
  }
  strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .tag {
    display: inline-flex;
    margin-inline-start: var(--fl-space-2);
    vertical-align: 1px;
  }
  .name > span {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .status {
    min-width: 0;
  }
  small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .measure {
    min-width: 0;
  }
  .action {
    display: flex;
    justify-content: flex-end;
    min-width: 0;
  }
  @container kit (max-width: 860px) {
    .kit-item {
      grid-template-columns: 44px minmax(0, 1fr) auto;
      row-gap: var(--fl-space-3);
    }
    /*
     * On a narrow page each row sizes its own action column: one row's wider button would otherwise
     * narrow the name in every row, including the rows whose actions have moved under the text.
     */
    :global(.kit-items) > .kit-item {
      grid-template-columns: 44px minmax(0, 1fr) auto;
    }
    .status,
    .measure {
      grid-column: 2 / -1;
    }
    .measure:empty {
      display: none;
    }
    .action {
      grid-row: 1;
      grid-column: 3;
    }
    /*
     * Two actions (Check one… and Check now) beside the name leave it a word per line, so they go
     * under the text, from the name's edge (backup-v2.css:1118-1128, settings-v2/kit.css:42-46).
     */
    .action:has(> :global(:nth-child(2)), > :global(div > :nth-child(2))) {
      grid-row: auto;
      grid-column: 2 / -1;
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .action:has(> :global(div > :nth-child(2))) > :global(div) {
      flex-wrap: wrap;
      justify-content: flex-start;
    }
    .action:empty {
      display: none;
    }
  }
</style>
