<script lang="ts">
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import {
    albumTargetRows,
    buildAlbumTargets,
    countAlbumTargets,
    emptyAlbumTargets,
    searchAlbumTargets,
    type AlbumTargetDirectory,
  } from '$lib/frameleaf/album-targets';
  import { albumAncestorNames } from '$lib/frameleaf/album-tree';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { getAllAlbums, type AlbumResponseDto, type LibraryViewScope } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Add to album. The dialog loads its own destinations (every album and shared space the signed-in
   * user owns or edits, through the album API), so it works the same from every view — Photos,
   * search, the Locked folder, people, pets, spaces, an album — with nothing passed in. Albums are
   * what photos go into; a collection only heads the albums inside it (one level deep) and is never
   * a destination itself; shared spaces stay at the top level. A long list opens a page at a time.
   *
   * Each album and collection shows its own icon in its own colour (README point 22), and a search
   * result says where it lives ("Brand › Spring"), as every Boards picker does.
   */
  const PAGE = 60;

  let {
    count,
    open = $bindable(true),
    onSubmit,
    libraryScope,
  }: {
    count: number;
    libraryScope?: LibraryViewScope;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  let directory = $state<AlbumTargetDirectory>(emptyAlbumTargets());
  /** The album list the targets were built from, for each row's icon, colour and path. */
  let albums = $state<AlbumResponseDto[]>([]);
  const byId = $derived(new Map(albums.map((album) => [album.id, album])));
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
  let query = $state('');
  let albumId = $state('');
  let limit = $state(PAGE);

  let generation = 0;
  onDestroy(() => generation++);
  const load = async () => {
    const version = ++generation;
    const current = authManager.captureSession();
    directory = emptyAlbumTargets();
    albums = [];
    status = 'loading';
    try {
      const loaded = await getAllAlbums(libraryScope ? { libraryScope } : {});
      if (!current() || version !== generation) {
        return;
      }
      albums = loaded;
      directory = buildAlbumTargets(loaded, authManager.user.id, $t('unnamed_album'));
      status = 'ready';
    } catch {
      if (!current() || version !== generation) {
        return;
      }
      status = 'failed';
    }
  };

  onMount(() => {
    void load();
    return onLibraryAccessChange(() => {
      generation++;
      directory = emptyAlbumTargets();
      albums = [];
      albumId = '';
      if (authManager.authenticated) {
        void load();
      } else {
        status = 'failed';
      }
    }, authManager.user.id);
  });

  const onSearch = () => {
    limit = PAGE;
  };

  let searching = $derived(query.trim().length > 0);
  let matches = $derived(searchAlbumTargets(directory, query));
  const pathOf = (id: string) => albumAncestorNames(albums, id, $t('unnamed_album')).join(' › ');
  let page = $derived(albumTargetRows(matches, limit));
  let total = $derived(countAlbumTargets(directory));
  let preview = $derived(
    status === 'failed'
      ? $t('frameleaf_bulk_album_load_failed')
      : status === 'ready' && total === 0
        ? $t('frameleaf_bulk_album_none')
        : undefined,
  );
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_add_to_album')}
  submitLabel={$t('frameleaf_bulk_add_to_album_apply', { values: { count } })}
  valid={!!albumId}
  {preview}
  onSubmit={() => onSubmit({ albumId })}
>
  <label>
    {$t('search')}
    <input
      type="search"
      bind:value={query}
      oninput={onSearch}
      placeholder={$t('frameleaf_bulk_album_search')}
      disabled={status !== 'ready'}
    />
  </label>
  <ul aria-busy={status === 'loading'}>
    {#if status === 'loading'}
      <li class="empty"><Spinner /></li>
    {:else if status === 'failed'}
      <li class="empty">
        <button type="button" class="more" onclick={() => void load()}>{$t('retry')}</button>
      </li>
    {:else}
      {#each page.rows as row (row.type === 'collection' ? `collection:${row.id}` : row.target.id)}
        {#if row.type === 'collection'}
          {@const collection = byId.get(row.id)}
          <li class="group">
            <AlbumMark icon={collection?.icon} color={collection?.color} kind={collection?.kind} size="14" />
            <span>{row.name}</span>
          </li>
        {:else}
          {@const album = byId.get(row.target.id)}
          {@const path = searching ? pathOf(row.target.id) : ''}
          <li class:nested={row.nested}>
            <label>
              <input type="radio" name="album-target" value={row.target.id} bind:group={albumId} />
              <AlbumMark icon={album?.icon} color={album?.color} kind={album?.kind ?? row.target.kind} size="16" />
              <span class="target">
                {#if path}<small class="path">{path}</small>{/if}
                <span>{row.target.name}</span>
              </span>
              {#if row.target.kind === 'space'}<em>{$t('frameleaf_bulk_album_space')}</em>{/if}
              <small>{row.target.count}</small>
            </label>
          </li>
        {/if}
      {:else}
        {#if total > 0}<li class="empty">{$t('frameleaf_bulk_album_no_matches')}</li>{/if}
      {/each}
      {#if page.hasMore}
        <li class="empty">
          <button type="button" class="more" onclick={() => (limit += PAGE)}>
            {$t('frameleaf_bulk_album_show_more')}
          </button>
        </li>
      {/if}
    {/if}
  </ul>
</BulkFormDialog>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 18rem;
    overflow: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  li :global(label) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-text);
    font-size: 0.875rem;
    padding: 0.35rem 0.6rem;
  }
  li.nested :global(label) {
    padding-inline-start: 1.5rem;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.5rem 0.6rem 0.15rem;
  }
  .target {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .path {
    margin: 0;
    overflow: hidden;
    color: var(--fl-muted);
    font-size: 0.7rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li :global(label:has(input:focus-visible)) {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  em {
    color: var(--fl-muted);
    font-size: 0.7rem;
    font-style: normal;
  }
  label > small {
    margin-inline-start: auto;
    color: var(--fl-muted);
  }
  .empty {
    color: var(--fl-muted);
    font-size: 0.75rem;
    padding: 0.4rem 0.6rem;
  }
  .more {
    background: none;
    border: none;
    padding: 0;
    color: var(--fl-accent);
    font: inherit;
    cursor: pointer;
  }
</style>
