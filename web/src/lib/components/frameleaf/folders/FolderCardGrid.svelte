<script lang="ts">
  /**
   * A grid of folder cards (mock `.dv2-folder-grid`). A level can hold hundreds of folders (a default
   * install keeps every original in its own hash folder), so the cards are added a screenful at a
   * time as the end of the grid comes into view, and every thumbnail loads lazily.
   */
  import FolderCard from '$lib/components/frameleaf/folders/FolderCard.svelte';
  import type { FolderLabel, FolderNode } from '$lib/frameleaf/folder-tree';

  let {
    folders,
    label,
    note,
    href,
    title,
    onOpen,
  }: {
    folders: readonly FolderNode[];
    label: FolderLabel;
    /** The line under a card's name. */
    note: (folder: FolderNode) => string;
    href: (folder: FolderNode) => string;
    title?: (folder: FolderNode) => string | undefined;
    onOpen?: (folder: FolderNode) => void;
  } = $props();

  /** Cards added per step: several screens' worth, so the end is rarely in view. */
  const STEP = 240;
  let limit = $state(STEP);
  let sentinel = $state<HTMLElement>();

  // Another list (another folder, a search, a new order) starts from its first cards again.
  $effect.pre(() => {
    void folders;
    limit = STEP;
  });

  $effect(() => {
    const target = sentinel;
    if (!target) {
      return;
    }
    if (typeof IntersectionObserver !== 'function') {
      limit = Infinity;
      return;
    }
    // The page scrolls inside the layout, not the window; the margin only counts against that scroller.
    let root: HTMLElement | null = null;
    for (let node = target.parentElement; node && !root; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        root = node;
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          limit += STEP;
        }
      },
      { root, rootMargin: '800px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  });
</script>

<div class="grid">
  {#each folders.slice(0, limit) as folder (folder.path)}
    <FolderCard
      name={label(folder)}
      href={href(folder)}
      count={folder.count}
      coverAssetIds={folder.coverAssetIds}
      note={note(folder)}
      title={title?.(folder)}
      onOpen={onOpen ? () => onOpen(folder) : undefined}
    />
  {/each}
</div>
{#if folders.length > limit}
  <div class="more" bind:this={sentinel} aria-hidden="true"></div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 22px 18px;
    align-items: start;
  }
  .more {
    height: 1px;
  }
  @media (max-width: 700px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px 14px;
    }
  }
</style>
