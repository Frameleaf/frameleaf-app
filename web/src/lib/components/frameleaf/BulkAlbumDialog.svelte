<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import {
    albumTargetRows,
    countAlbumTargets,
    emptyAlbumTargets,
    loadAlbumTargets,
    searchAlbumTargets,
    type AlbumTargetDirectory,
  } from '$lib/frameleaf/album-targets';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Add to album. The dialog loads its own destinations (every album and shared space the signed-in
   * user owns or edits, through the album API), so it works the same from every view — Photos,
   * search, the Locked folder, people, pets, spaces, an album — with nothing passed in. Albums are
   * what photos go into; a collection only heads the albums inside it (one level deep) and is never
   * a destination itself; shared spaces stay at the top level. A long list opens a page at a time.
   */
  const PAGE = 60;

  let {
    count,
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  let directory = $state<AlbumTargetDirectory>(emptyAlbumTargets());
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
  let query = $state('');
  let albumId = $state('');
  let limit = $state(PAGE);

  const load = async () => {
    status = 'loading';
    try {
      directory = await loadAlbumTargets(authManager.user.id, $t('unnamed_album'));
      status = 'ready';
    } catch {
      status = 'failed';
    }
  };

  onMount(() => {
    void load();
  });

  const onSearch = () => {
    limit = PAGE;
  };

  let matches = $derived(searchAlbumTargets(directory, query));
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
      <li class="empty" role="status">{$t('loading')}</li>
    {:else if status === 'failed'}
      <li class="empty">
        <button type="button" class="more" onclick={() => void load()}>{$t('retry')}</button>
      </li>
    {:else}
      {#each page.rows as row (row.type === 'collection' ? `collection:${row.id}` : row.target.id)}
        {#if row.type === 'collection'}
          <li class="group">{row.name}</li>
        {:else}
          <li class:nested={row.nested}>
            <label>
              <input type="radio" name="album-target" value={row.target.id} bind:group={albumId} />
              <span>{row.target.name}</span>
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
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.5rem 0.6rem 0.15rem;
  }
  em {
    color: var(--fl-muted);
    font-size: 0.7rem;
    font-style: normal;
  }
  small {
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
