<script lang="ts">
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import { albumAncestorNames, albumPickerTree, searchAlbums, type AlbumPickerNode } from '$lib/frameleaf/album-tree';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiFolderHomeOutline, mdiMagnify } from '@mdi/js';
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  /**
   * Where something goes (prototype `DestinationPicker`): a search field over a nested tree of
   * albums and collections, each in its own icon and colour. While searching, matches are listed
   * flat with the path above them. A destination that may not be chosen stays visible, disabled,
   * with the reason written under it (moving a collection into itself or anything inside it).
   *
   * Every choice is a native radio in one group, so arrow keys move through the visible rows and
   * the expand buttons sit beside them in the tab order.
   */
  interface Props {
    albums: AlbumResponseDto[];
    value: string | null;
    onChange: (id: string | null) => void;
    /** Offer "Top level" (null) as the first choice, as moving and creating do. */
    allowTop?: boolean;
    topLabel?: string;
    /** Why an album may not be chosen, or null when it may. */
    refusal?: (album: AlbumResponseDto) => string | null;
    name?: string;
    label?: string;
  }

  let {
    albums,
    value,
    onChange,
    allowTop = false,
    topLabel,
    refusal = () => null,
    name = 'album-destination',
    label,
  }: Props = $props();

  let query = $state('');
  const tree = $derived(albumPickerTree(albums));
  const searching = $derived(query.trim().length > 0);
  const matches = $derived(searching ? searchAlbums(albums, query) : []);

  /** Open by default: the top level, and every collection above the current choice. */
  const open = new SvelteSet<string>();
  $effect(() => {
    const roots = tree;
    const current = value;
    untrack(() => {
      for (const root of roots) {
        open.add(root.album.id);
      }
      const byId = new Map(albums.map((album) => [album.id, album]));
      let parentId = current ? byId.get(current)?.parentId : undefined;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        open.add(parentId);
        parentId = byId.get(parentId)?.parentId;
      }
    });
  });
  const toggle = (id: string) => (open.has(id) ? open.delete(id) : open.add(id));
  const unnamed = $derived($t('unnamed_album'));
</script>

{#snippet choice(album: AlbumResponseDto, hasChildren: boolean, path: string[] | null)}
  {@const reason = refusal(album)}
  <label class="row" class:chosen={value === album.id} class:blocked={!!reason}>
    <input
      type="radio"
      {name}
      checked={value === album.id}
      disabled={!!reason}
      aria-describedby={reason ? `${name}-why-${album.id}` : undefined}
      onchange={() => onChange(album.id)}
    />
    <AlbumMark icon={album.icon} color={album.color} kind={album.kind} {hasChildren} size="18" />
    <span class="text">
      {#if path && path.length > 0}<small class="path">{path.join(' › ')}</small>{/if}
      <span class="name">{album.albumName || unnamed}</span>
      {#if reason}<small class="why" id="{name}-why-{album.id}">{reason}</small>{/if}
    </span>
    <small class="count">{album.assetCount}</small>
  </label>
{/snippet}

{#snippet branch(nodes: AlbumPickerNode[], level: number)}
  <ul class="tree" role={level === 0 ? undefined : 'group'}>
    {#each nodes as node (node.album.id)}
      {@const hasChildren = node.children.length > 0}
      {@const expanded = open.has(node.album.id)}
      <li style="--level: {level}">
        <div class="line">
          {#if hasChildren}
            <button
              type="button"
              class="twisty"
              class:expanded
              aria-expanded={expanded}
              aria-label={$t(expanded ? 'frameleaf_rail_collapse_collection' : 'frameleaf_rail_expand_collection', {
                values: { name: node.album.albumName || unnamed },
              })}
              onclick={() => toggle(node.album.id)}
            >
              <Icon icon={mdiChevronRight} size="16" aria-hidden={true} />
            </button>
          {:else}
            <span class="twisty" aria-hidden="true"></span>
          {/if}
          {@render choice(node.album, hasChildren, null)}
        </div>
        {#if hasChildren && expanded}
          {@render branch(node.children, level + 1)}
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<div class="picker">
  <label class="search">
    <Icon icon={mdiMagnify} size="16" aria-hidden={true} />
    <input
      type="search"
      bind:value={query}
      placeholder={$t('frameleaf_boards_find_collection')}
      aria-label={$t('frameleaf_boards_find_collection')}
      autocomplete="off"
    />
  </label>
  <fieldset class="list">
    <legend class="sr-only">{label ?? $t('frameleaf_albums_move_to')}</legend>
    {#if allowTop && !searching}
      <div class="line">
        <span class="twisty" aria-hidden="true"></span>
        <label class="row" class:chosen={value === null}>
          <input type="radio" {name} checked={value === null} onchange={() => onChange(null)} />
          <span class="top-icon" aria-hidden="true"><Icon icon={mdiFolderHomeOutline} size="18" /></span>
          <span class="text"><span class="name">{topLabel ?? $t('frameleaf_albums_no_collection')}</span></span>
        </label>
      </div>
    {/if}
    {#if searching}
      <ul class="tree">
        {#each matches as album (album.id)}
          <li>
            {@render choice(
              album,
              albums.some(({ parentId }) => parentId === album.id),
              albumAncestorNames(albums, album.id, unnamed),
            )}
          </li>
        {:else}
          <li class="empty" role="status">{$t('frameleaf_boards_no_collection_called', { values: { query } })}</li>
        {/each}
      </ul>
    {:else if tree.length > 0}
      {@render branch(tree, 0)}
    {:else}
      <p class="empty">{$t('frameleaf_albums_move_no_collections')}</p>
    {/if}
  </fieldset>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: 36px;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
    outline: none;
  }
  .list {
    margin: 0;
    padding: 4px;
    min-width: 0;
    max-height: min(45dvh, 22rem);
    overflow-y: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .tree {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tree .tree {
    margin-inline-start: 14px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .twisty {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius);
    background: none;
    color: var(--fl-muted);
    cursor: pointer;
  }
  .twisty :global(svg) {
    transition: transform var(--fl-motion-fast, 120ms) var(--fl-ease, ease);
  }
  .twisty.expanded :global(svg) {
    transform: rotate(90deg);
  }
  .twisty:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  .row {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    min-height: 40px;
    padding: 4px 8px;
    border-radius: var(--fl-radius);
    color: var(--fl-text);
    font-size: 0.875rem;
    cursor: pointer;
  }
  .row:hover:not(.blocked) {
    background: var(--fl-raised);
  }
  .row.chosen {
    background: var(--fl-accent-soft, var(--fl-raised));
    box-shadow: inset 2px 0 0 var(--fl-accent);
  }
  .row.blocked {
    cursor: not-allowed;
    color: var(--fl-muted);
  }
  .row input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .row:has(input:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .top-icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path,
  .why,
  .count {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    flex-shrink: 0;
  }
  .empty {
    margin: 0;
    padding: 0.5rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
