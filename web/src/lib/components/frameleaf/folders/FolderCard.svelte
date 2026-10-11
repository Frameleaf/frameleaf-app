<script lang="ts">
  /**
   * One folder as a card: a pile of its photos, its name and a line about what it holds (mock
   * `FolderCard`, built on the album tile's rhythm). The cover is the link; the name repeats it for
   * the pointer and stays out of the tab order, so each card is one stop.
   */
  import FolderStack from '$lib/components/frameleaf/folders/FolderStack.svelte';
  import { t } from 'svelte-i18n';

  let {
    name,
    href,
    count,
    coverAssetIds,
    note,
    title,
    onOpen,
  }: {
    /** The name shown: the folder's name on disk, or the friendly name of an account's uploads. */
    name: string;
    href: string;
    /** Items in the folder and under it, for the link's accessible name. */
    count: number;
    coverAssetIds: readonly string[];
    /** The line under the name, e.g. "108 items · 4 folders · 2.6 GB". */
    note: string;
    /** A tooltip for the cover, e.g. the real name on disk behind a friendly one. */
    title?: string;
    /** Runs as the link is followed (not instead of it). */
    onOpen?: () => void;
  } = $props();
</script>

<article class="card" aria-label={name}>
  <a
    class="cover"
    {href}
    {title}
    aria-label={$t('frameleaf_folders_open_folder', { values: { name, count } })}
    onclick={onOpen}
  >
    <FolderStack ids={coverAssetIds} />
  </a>
  <div class="text">
    <a class="name" {href} tabindex="-1" onclick={onOpen}>{name}</a>
    <small>{note}</small>
  </div>
</article>

<style>
  /* AlbumTile's card (collections.css `.al-card`) with the pile in place of the square cover. */
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    color: var(--fl-text);
  }
  .cover {
    display: block;
    border-radius: var(--fl-radius-card);
    transition: transform var(--fl-motion) var(--fl-ease);
  }
  .card:hover .cover {
    transform: translateY(-2px);
  }
  .cover:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: 3px;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    min-width: 0;
    padding: 0 2px;
  }
  .name {
    align-self: flex-start;
    max-width: 100%;
    overflow: hidden;
    color: inherit;
    font-size: var(--fl-font-size);
    font-weight: 600;
    line-height: 1.3;
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  small {
    overflow: hidden;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .card:hover .cover {
      transform: none;
    }
  }
</style>
