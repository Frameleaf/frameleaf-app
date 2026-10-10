<script lang="ts">
  import TagDot from '$lib/components/frameleaf/tags/TagDot.svelte';
  import { tagTrail, type FrameleafTagNode } from '$lib/frameleaf/tag-tree';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronDown, mdiChevronRight } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * The list view: the tag tree as one compact table, for a library with hundreds of tags. A row
   * per tag with its items, the tags inside it and the date of its newest item.
   *
   * The table is one tab stop. Up, Down, Home and End move between rows; Right opens a branch and
   * then steps into it, Left closes it and then steps out to its parent; Enter opens the tag. The
   * row's "…" button follows the row that has focus, so Tab from a row reaches that row's menu.
   *
   * While "Find a tag" has text the rows are the matches as a flat list (`flat`), each saying where
   * it sits, and nothing expands.
   */
  let {
    rows,
    flat = false,
    expanded,
    onToggle,
    onOpen,
    menu,
  }: {
    /** The rows to draw, in order: the page decides the order and which branches are open. */
    rows: FrameleafTagNode[];
    flat?: boolean;
    expanded: ReadonlySet<string>;
    onToggle: (node: FrameleafTagNode) => void;
    onOpen: (node: FrameleafTagNode) => void;
    menu: Snippet<[FrameleafTagNode]>;
  } = $props();

  let table = $state<HTMLDivElement>();
  let focused = $state<string | null>(null);
  // The row that holds the tab stop: the last one focused while it is still shown, else the first.
  const focusId = $derived(rows.some((row) => row.id === focused) ? focused : (rows[0]?.id ?? null));

  // The capture day comes as a date at UTC midnight (like an album's), so it is read in UTC.
  const dayFormat = $derived(new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium', timeZone: 'UTC' }));
  const newest = (node: FrameleafTagNode) => {
    const date = node.endDate ? new Date(node.endDate) : null;
    return date && !Number.isNaN(date.getTime()) ? dayFormat.format(date) : '–';
  };

  const focusRow = (id: string | undefined) => {
    if (!id) {
      return;
    }
    focused = id;
    for (const row of table?.querySelectorAll<HTMLElement>('[data-tag-id]') ?? []) {
      if (row.dataset.tagId === id) {
        row.focus();
        return;
      }
    }
  };

  const onRowKeydown = (event: KeyboardEvent, node: FrameleafTagNode) => {
    // Keys pressed inside the row's own controls (its menu) belong to them.
    if (event.target !== event.currentTarget) {
      return;
    }
    const at = rows.findIndex((row) => row.id === node.id);
    const branch = !flat && node.children.length > 0;
    const open = branch && expanded.has(node.id);
    switch (event.key) {
      case 'ArrowDown': {
        focusRow(rows[at + 1]?.id);
        break;
      }
      case 'ArrowUp': {
        focusRow(rows[at - 1]?.id);
        break;
      }
      case 'Home': {
        focusRow(rows[0]?.id);
        break;
      }
      case 'End': {
        focusRow(rows.at(-1)?.id);
        break;
      }
      case 'ArrowRight': {
        if (branch && !open) {
          onToggle(node);
        } else if (open) {
          // Its first tag is the row right under it.
          focusRow(rows[at + 1]?.id);
        }
        break;
      }
      case 'ArrowLeft': {
        if (open) {
          onToggle(node);
        } else if (!flat && node.parent) {
          focusRow(node.parent.id);
        }
        break;
      }
      case 'Enter': {
        onOpen(node);
        break;
      }
      default: {
        return;
      }
    }
    event.preventDefault();
  };

  const onRowClick = (event: MouseEvent, node: FrameleafTagNode) => {
    // The name is a real link (it opens in a new tab like any other); a click on it is its own.
    if ((event.target as HTMLElement).closest('a, button')) {
      return;
    }
    onOpen(node);
  };

  /** The row's "…" button is in the tab order only for the row that holds the tab stop. */
  const rovingMenu = (cell: HTMLElement, active: boolean) => {
    const apply = (on: boolean) => {
      const button = cell.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
      if (button) {
        button.tabIndex = on ? 0 : -1;
      }
    };
    apply(active);
    return { update: apply };
  };
</script>

<div class="tag-table" role="treegrid" aria-label={$t('tags')} bind:this={table}>
  <div class="row head" role="row">
    <span role="columnheader">{$t('tag')}</span>
    <span role="columnheader" class="num">{$t('frameleaf_tags_column_items')}</span>
    <span role="columnheader" class="num inside">{$t('frameleaf_tags_inside_title')}</span>
    <span role="columnheader" class="num newest">{$t('frameleaf_tags_column_newest')}</span>
    <span role="columnheader"><span class="sr-only">{$t('frameleaf_tags_column_actions')}</span></span>
  </div>
  {#each rows as node (node.id)}
    {@const depth = flat ? 0 : node.depth}
    {@const branch = !flat && node.children.length > 0}
    {@const open = branch && expanded.has(node.id)}
    {@const trail = flat ? tagTrail(node) : []}
    <div
      role="row"
      class="row"
      data-tag-id={node.id}
      aria-level={depth + 1}
      aria-expanded={branch ? open : undefined}
      tabindex={focusId === node.id ? 0 : -1}
      onclick={(event) => onRowClick(event, node)}
      onfocus={(event) => {
        if (event.target === event.currentTarget) {
          focused = node.id;
        }
      }}
      onkeydown={(event) => onRowKeydown(event, node)}
    >
      <span role="gridcell" class="name" style:--depth={depth}>
        {#if branch}
          <button
            type="button"
            class="twist"
            tabindex="-1"
            aria-label={open
              ? $t('frameleaf_tags_collapse_node', { values: { name: node.name } })
              : $t('frameleaf_tags_expand_node', { values: { name: node.name } })}
            onclick={() => onToggle(node)}
          >
            <Icon icon={open ? mdiChevronDown : mdiChevronRight} size="18" aria-hidden />
          </button>
        {:else}
          <span class="twist" aria-hidden="true"></span>
        {/if}
        <TagDot color={node.color} />
        <a class="label" href={Route.tags({ path: node.value })} tabindex="-1">{node.name}</a>
        {#if trail.length > 0}
          <small>{$t('frameleaf_tags_in_trail', { values: { path: trail.join(' › ') } })}</small>
        {/if}
      </span>
      <span role="gridcell" class="num items">{node.total.toLocaleString($locale ?? undefined)}</span>
      <span role="gridcell" class="num inside">{node.children.length > 0 ? node.children.length : '–'}</span>
      <span role="gridcell" class="num newest">{newest(node)}</span>
      <span role="gridcell" class="menu" use:rovingMenu={focusId === node.id}>
        {@render menu(node)}
      </span>
    </div>
  {/each}
</div>

<style>
  /* Not `.table`: that name is a Tailwind utility (display: table) and would shrink it to its content. */
  .tag-table {
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  /* On the light canvas the panel needs an edge to read as a table. */
  :global(.frameleaf[data-theme='light']) .tag-table {
    border: 1px solid var(--fl-border);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 84px 104px 132px 36px;
    align-items: center;
    gap: var(--fl-space-3);
    min-height: 44px;
    padding-inline: var(--fl-space-3) var(--fl-space-2);
    border-top: 1px solid var(--fl-border);
    cursor: pointer;
  }
  .row:first-child {
    border-top: 0;
    border-radius: var(--fl-radius-card) var(--fl-radius-card) 0 0;
  }
  .row:last-child {
    border-radius: 0 0 var(--fl-radius-card) var(--fl-radius-card);
  }
  .row.head {
    min-height: 36px;
    cursor: default;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .row:not(.head):hover {
    background: var(--fl-raised);
  }
  .row:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-inset);
  }
  .name {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
    padding-inline-start: calc(var(--depth, 0) * 22px);
  }
  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
    color: inherit;
    text-decoration: none;
  }
  .label:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .row[aria-level='1'] .label {
    font-weight: 600;
  }
  .name small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .twist {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    min-width: 0;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: transparent;
    color: var(--fl-muted);
  }
  button.twist:hover {
    background: color-mix(in srgb, var(--fl-text) 8%, transparent);
    color: var(--fl-text);
  }
  .num {
    text-align: end;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .row:not(.head) .num.items {
    color: var(--fl-text);
  }
  .menu {
    display: flex;
    justify-content: flex-end;
  }
  .menu :global(.menu-root > button) {
    min-width: 30px;
    min-height: 30px;
    padding: 4px;
    border-color: transparent;
    background: transparent;
  }
  .menu :global(.menu-root > button:hover),
  .menu :global(.menu-root > button[aria-expanded='true']) {
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
  }
  @media (max-width: 1000px) {
    .row {
      grid-template-columns: minmax(0, 1fr) 72px 96px 36px;
    }
    .newest {
      display: none;
    }
  }
  @media (max-width: 700px) {
    .row {
      grid-template-columns: minmax(0, 1fr) 56px 44px;
      min-height: 48px;
      gap: var(--fl-space-2);
    }
    .inside {
      display: none;
    }
    .name {
      padding-inline-start: calc(var(--depth, 0) * 16px);
    }
    .twist {
      width: 32px;
      height: 32px;
    }
    .menu :global(.menu-root > button) {
      min-width: 40px;
      min-height: 40px;
    }
  }
</style>
