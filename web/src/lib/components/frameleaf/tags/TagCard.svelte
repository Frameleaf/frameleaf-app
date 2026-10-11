<script lang="ts">
  import AssetCollage from '$lib/components/frameleaf/AssetCollage.svelte';
  import TagDot from '$lib/components/frameleaf/tags/TagDot.svelte';
  import type { FrameleafTagNode } from '$lib/frameleaf/tag-tree';
  import { Route } from '$lib/route';
  import { Icon } from '@frameleaf/ui';
  import { mdiTagOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * A tag as a card, built like an album tile (`AlbumTile`): a square cover of its newest photos,
   * its colour and name, how many items carry it, and one more line the page supplies (the tags
   * inside it, or where a search result sits). The cover and the name are links to the tag's page;
   * the name stays out of the tab order so a card is one stop plus its menu.
   *
   * `compact` is the smaller card of a tag page's "Tags inside" row.
   */
  let {
    node,
    note = '',
    compact = false,
    actions,
  }: {
    node: FrameleafTagNode;
    note?: string;
    compact?: boolean;
    /** The card's "…" menu; the card itself knows nothing about what a tag can do. */
    actions?: Snippet;
  } = $props();

  const href = $derived(Route.tags({ path: node.value }));
</script>

<article class="card" class:compact aria-label={node.name}>
  <a class="cover" {href} aria-label={$t('frameleaf_tags_open', { values: { name: node.name, count: node.total } })}>
    {#if node.covers.length > 0}
      <AssetCollage ids={node.covers} large={!compact} />
    {:else}
      <span class="cover-empty" aria-hidden="true"><Icon icon={mdiTagOutline} size={compact ? '24' : '30'} /></span>
    {/if}
  </a>
  <div class="text">
    <a class="name" {href} tabindex="-1">
      <TagDot color={node.color} />
      <span>{node.name}</span>
    </a>
    <small class="meta">
      {node.total > 0
        ? $t('frameleaf_tags_item_count', { values: { count: node.total } })
        : $t('frameleaf_tags_no_items_yet')}
    </small>
    {#if note}
      <small class="note">{note}</small>
    {/if}
  </div>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</article>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    min-width: 0;
    color: var(--fl-text);
  }
  .cover {
    position: relative;
    display: block;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fl-text), transparent 91%);
    transition:
      transform var(--fl-motion) var(--fl-ease),
      box-shadow var(--fl-motion) var(--fl-ease);
    /* The collage fills the square; the cover's own colour shows between the photos. */
    --fl-collage-aspect: 1;
    --fl-collage-gap: var(--fl-raised);
  }
  .cover :global(.fl-collage) {
    width: 100%;
    height: 100%;
  }
  .card:hover .cover {
    transform: translateY(-2px);
    box-shadow: var(--fl-shadow-2);
  }
  .cover:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: 3px;
  }
  .cover-empty {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    color: var(--fl-muted);
  }
  /* Name, count and the third line are different things: one 4px step between each. */
  .text {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    min-width: 0;
    padding: 0 2px;
  }
  .name {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    align-self: flex-start;
    max-width: 100%;
    font-size: var(--fl-font-size);
    font-weight: 600;
    line-height: 1.3;
    color: inherit;
    text-decoration: none;
  }
  .name > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:hover > span {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .meta,
  .note {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fl-font-small);
    line-height: 1.45;
    color: var(--fl-muted);
  }
  /* The "…" button sits on the photo: a dark chip in both themes, shown on hover, focus and touch. */
  .actions {
    position: absolute;
    top: var(--fl-space-2);
    inset-inline-end: var(--fl-space-2);
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .card:hover .actions,
  .card:focus-within .actions,
  .actions:has(:global([aria-expanded='true'])) {
    opacity: 1;
  }
  .actions :global(.menu-root > button) {
    min-width: 30px;
    min-height: 30px;
    padding: 4px;
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-canvas), transparent 30%);
    border-color: transparent;
  }
  /* Narrow enough to stay inside its card, so the first column's menu is never cut off. */
  .actions :global([role='menu']) {
    min-width: 168px;
  }
  .actions :global(.menu-root > button:hover) {
    background: color-mix(in srgb, var(--fl-viewer-canvas), transparent 12%);
  }
  @media (pointer: coarse) {
    .actions {
      opacity: 1;
    }
    .actions :global(.menu-root > button) {
      min-width: 40px;
      min-height: 40px;
    }
  }
</style>
