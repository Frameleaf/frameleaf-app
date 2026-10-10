<script lang="ts">
  /**
   * The open folder's path as a row of pills (mock `PathBar`): "All folders › photos › 2026 ›
   * Rockies". Each pill goes to its folder; its up/down control lists the folders beside it. The
   * row starts at the top of the browser, not at "/": the folders above only pass through.
   */
  import FolderSiblingMenu from '$lib/components/frameleaf/folders/FolderSiblingMenu.svelte';
  import { folderSiblings, type FolderLabel, type FolderNode } from '$lib/frameleaf/folder-tree';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiHarddisk } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    trail,
    label,
    href,
    title,
    onGo,
  }: {
    /** The top of the browser first, the open folder last. */
    trail: readonly FolderNode[];
    /** The name shown for a folder; the caller names the top "All folders". */
    label: FolderLabel;
    href: (folder: FolderNode) => string;
    /** A tooltip, e.g. the real name on disk behind a friendly one. */
    title?: (folder: FolderNode) => string | undefined;
    /** Go to a folder picked from a pill's list. */
    onGo: (folder: FolderNode) => void;
  } = $props();
</script>

<nav class="path" aria-label={$t('frameleaf_folders_path')}>
  <!-- By position, so a pill and its open list stay in place when a neighbouring folder is picked. -->
  {#each trail as crumb, index (index)}
    {@const here = index === trail.length - 1}
    {@const menu = index > 0 && folderSiblings(crumb).length > 1}
    {#if index > 0}
      <Icon icon={mdiChevronRight} size="15" aria-hidden />
    {/if}
    <span class="pill" class:here class:has-menu={menu}>
      <a class="go" href={href(crumb)} aria-current={here ? 'page' : undefined} title={title?.(crumb)}>
        {#if index === 0}
          <Icon icon={mdiHarddisk} size="15" aria-hidden />
        {/if}
        <span class="name">{label(crumb)}</span>
      </a>
      {#if menu}
        <FolderSiblingMenu folder={crumb} name={label(crumb)} {label} {onGo} />
      {/if}
    </span>
  {/each}
</nav>

<style>
  .path {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 3px;
    min-width: 0;
  }
  .path > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-muted);
    opacity: 0.6;
  }
  .path > :global(svg:dir(rtl)) {
    scale: -1 1;
  }
  .pill {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    min-width: 0;
    min-height: 32px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    font-weight: 500;
  }
  .pill.here {
    color: var(--fl-text);
    font-weight: 600;
  }
  .go {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 0 13px;
    border-radius: var(--fl-radius-pill);
    color: inherit;
    text-decoration: none;
    transition: color var(--fl-motion-fast) var(--fl-ease);
  }
  .pill.has-menu .go {
    padding-inline-end: 5px;
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }
  .go:hover {
    color: var(--fl-text);
  }
  .go:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: 1px;
  }
  /* A folder named after something long (an id, a sentence) never pushes the row off the page. */
  .name {
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (pointer: coarse) {
    .pill {
      min-height: 44px;
    }
  }
</style>
