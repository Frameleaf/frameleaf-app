<script lang="ts">
  /**
   * Folders as columns (mock `Columns`, `10-folders-v2-columns`): pick a folder and the next column
   * lists what is inside it; the last pane previews the folder that is open. The fast way down a deep
   * tree on a wide screen.
   *
   * The arrow keys walk it like a file manager: up and down within a column (with Home and End),
   * right into the folder, left back out, Enter to open the folder in the grid. The open folder
   * follows the focused row, and everything shown comes from the folder tree, so moving through the
   * columns never loads a folder's files.
   */
  import AssetCollage from '$lib/components/frameleaf/AssetCollage.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import FolderStack from '$lib/components/frameleaf/folders/FolderStack.svelte';
  import {
    FOLDER_COVER_LIMIT,
    folderTrail,
    formatBytes,
    sortFolders,
    type FolderLabel,
    type FolderNode,
    type FolderSort,
  } from '$lib/frameleaf/folder-tree';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiContentCopy, mdiFolderOpenOutline, mdiTimelineClockOutline } from '@mdi/js';
  import { tick } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let {
    top,
    folder,
    sort,
    label,
    accountName,
    dateRange,
    onGo,
    onOpen,
    onCopy,
    onTimeline,
  }: {
    /** The top of the browser: its folders are the first column. */
    top: FolderNode;
    /** The open folder. */
    folder: FolderNode;
    sort: FolderSort;
    /** The name shown for a folder; the caller names the top "All folders". */
    label: FolderLabel;
    /** Whose uploads a folder holds, when it is named after a known account. */
    accountName: (folder: FolderNode) => string | null;
    /** "Jun – Aug 2026" for a folder, or nothing when its dates are unknown. */
    dateRange: (folder: FolderNode) => string;
    /** Make a folder the open one. `keyboard` moves are steps, not places to come back to. */
    onGo: (folder: FolderNode, options?: { keyboard?: boolean }) => void;
    /** Open a folder in the grid. */
    onOpen: (folder: FolderNode) => void;
    onCopy: (folder: FolderNode) => void;
    onTimeline: (folder: FolderNode) => void;
  } = $props();

  const chain = $derived(folderTrail(folder, top));
  const columns = $derived(
    chain
      .map((node, index) => ({
        node,
        rows: sortFolders(node.children, sort, label),
        chosen: chain.at(index + 1) ?? null,
      }))
      .filter((column) => column.rows.length > 0),
  );
  const isTop = $derived(folder === top);
  const account = $derived(accountName(folder));
  // Mock `Collage`: four photos as a 2 x 2, otherwise the newest one on its own.
  const collage = $derived(
    folder.coverAssetIds.length >= FOLDER_COVER_LIMIT ? folder.coverAssetIds : folder.coverAssetIds.slice(0, 1),
  );

  let scroller = $state<HTMLElement>();
  // Deliberately not $state: the folder a key press asked for, focused once it is the open one.
  let focusPath: string | null = null;

  const rowOf = (element: HTMLElement, path: string) =>
    [...element.querySelectorAll<HTMLElement>('[data-path]')].find((row) => row.dataset.path === path);

  $effect(() => {
    const path = folder.path;
    const element = scroller;
    if (!element) {
      return;
    }
    void tick().then(() => {
      // The newest column, the one the open folder just added, comes into view.
      const end = element.scrollWidth - element.clientWidth;
      element.scrollLeft = getComputedStyle(element).direction === 'rtl' ? -end : end;
      const row = rowOf(element, path);
      row?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      if (focusPath === path) {
        focusPath = null;
        row?.focus({ preventScroll: true });
      }
    });
  });

  const move = (target: FolderNode | null | undefined) => {
    if (!target || target === top || target === folder) {
      return;
    }
    focusPath = target.path;
    onGo(target, { keyboard: true });
  };

  const onKeydown = (event: KeyboardEvent, node: FolderNode, rows: readonly FolderNode[]) => {
    const rtl = getComputedStyle(event.currentTarget as Element).direction === 'rtl';
    const into = rtl ? 'ArrowLeft' : 'ArrowRight';
    const out = rtl ? 'ArrowRight' : 'ArrowLeft';
    const at = rows.indexOf(node);
    switch (event.key) {
      case 'ArrowDown': {
        move(rows.at(at + 1));
        break;
      }
      case 'ArrowUp': {
        move(at > 0 ? rows.at(at - 1) : null);
        break;
      }
      case 'Home': {
        move(rows.at(0));
        break;
      }
      case 'End': {
        move(rows.at(-1));
        break;
      }
      case into: {
        move(sortFolders(node.children, sort, label).at(0));
        break;
      }
      case out: {
        move(node.parent);
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
</script>

<div class="columns">
  <div class="cols" bind:this={scroller}>
    {#each columns as column (column.node.path)}
      <ul
        class="col"
        role="listbox"
        aria-label={column.node === top
          ? label(top)
          : $t('frameleaf_folders_in_folder', { values: { name: label(column.node) } })}
      >
        {#each column.rows as child, index (child.path)}
          {@const here = child === folder}
          {@const friendly = accountName(child)}
          <li
            class="row"
            class:here
            role="option"
            data-path={child.path}
            aria-selected={child === column.chosen}
            tabindex={here || (isTop && index === 0) ? 0 : -1}
            title={friendly ? $t('frameleaf_folders_on_disk', { values: { path: child.name } }) : undefined}
            onclick={() => onGo(child)}
            ondblclick={() => onOpen(child)}
            onkeydown={(event) => onKeydown(event, child, column.rows)}
          >
            <FolderStack ids={child.coverAssetIds} mini />
            <span class="text">
              <strong>{label(child)}</strong>
              <small>{$t('frameleaf_folders_item_count', { values: { count: child.count } })}</small>
            </span>
            {#if child.children.length > 0}
              <Icon icon={mdiChevronRight} size="16" aria-hidden />
            {/if}
          </li>
        {/each}
      </ul>
    {/each}
  </div>

  <aside class="preview" aria-label={$t('frameleaf_folders_details_of', { values: { name: label(folder) } })}>
    <div class="cover">
      <AssetCollage ids={collage} large />
    </div>
    <h2>{label(folder)}</h2>
    {#if account}
      <p class="about">{$t('frameleaf_folders_uploads_about', { values: { name: account } })}</p>
    {/if}
    <div class="actions">
      <Button variant="primary" onclick={() => onOpen(folder)}>
        <Icon icon={mdiFolderOpenOutline} size="18" aria-hidden />
        {$t('open')}
      </Button>
      <Button onclick={() => onTimeline(folder)} disabled={folder.count === 0}>
        <Icon icon={mdiTimelineClockOutline} size="18" aria-hidden />
        {$t('frameleaf_folders_show_in_timeline')}
      </Button>
    </div>
    <dl class="facts">
      <div>
        <dt>{$t('frameleaf_folders_fact_items')}</dt>
        <dd>{folder.count.toLocaleString($locale ?? undefined)}</dd>
      </div>
      <div>
        <dt>{$t('size')}</dt>
        <dd>{formatBytes(folder.size)}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_folders_fact_folders')}</dt>
        <dd>
          {folder.children.length > 0 ? folder.children.length.toLocaleString($locale ?? undefined) : $t('none')}
        </dd>
      </div>
      <div>
        <dt>{$t('frameleaf_folders_fact_taken')}</dt>
        <dd>{dateRange(folder) || '–'}</dd>
      </div>
    </dl>
    <div class="disk">
      <small>{$t('frameleaf_folders_path_on_disk')}</small>
      <span>{folder.path}</span>
      <Button onclick={() => onCopy(folder)}>
        <Icon icon={mdiContentCopy} size="16" aria-hidden />
        {$t('frameleaf_folders_copy_path')}
      </Button>
    </div>
  </aside>
</div>

<style>
  .columns {
    display: flex;
    height: clamp(420px, calc(100dvh - 320px), 720px);
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  :global(.frameleaf[data-theme='light']) .columns {
    border: 1px solid var(--fl-border);
  }
  .cols {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    scrollbar-width: thin;
  }
  .col {
    /* Four columns and the preview fit a 1440px window without scrolling sideways. */
    flex: 0 0 214px;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    list-style: none;
    scrollbar-width: thin;
  }
  .col + .col {
    border-inline-start: 1px solid var(--fl-border);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 48px;
    padding: 5px 4px 5px 8px;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
    /* A column can list hundreds of folders; rows out of view are not laid out or painted. */
    content-visibility: auto;
    contain-intrinsic-size: auto 48px;
  }
  .row:hover,
  .row[aria-selected='true'] {
    background: var(--fl-raised);
  }
  .row.here {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-panel) 86%);
  }
  .row:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-inset);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .text strong {
    overflow: hidden;
    font-size: var(--fl-font-callout);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
  }
  .row > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-muted);
    opacity: 0.7;
  }
  .row > :global(svg:dir(rtl)) {
    scale: -1 1;
  }
  .preview {
    display: flex;
    flex: 0 0 304px;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    overflow-y: auto;
    border-inline-start: 1px solid var(--fl-border);
    scrollbar-width: thin;
  }
  .cover {
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    --fl-collage-gap: var(--fl-panel);
  }
  .preview h2 {
    margin: 0;
    font-size: var(--fl-font-headline);
    font-weight: 600;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .about {
    margin: -10px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 14px;
    margin: 0;
  }
  .facts dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .facts dd {
    margin: 1px 0 0;
    font-size: var(--fl-font-callout);
    font-variant-numeric: tabular-nums;
  }
  .disk {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 12px;
    border-top: 1px solid var(--fl-border);
  }
  .disk small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .disk span {
    font-size: var(--fl-font-small);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .disk :global(.fl-control) {
    align-self: flex-start;
    margin-top: 4px;
  }
  /* Between the phone layout and a full window the columns and the preview share less room. */
  @media (max-width: 1100px) {
    .col {
      flex-basis: 176px;
    }
    .preview {
      flex-basis: 248px;
      padding: 14px;
    }
  }
</style>
