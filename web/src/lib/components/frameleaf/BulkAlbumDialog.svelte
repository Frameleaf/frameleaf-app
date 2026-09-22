<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { t } from 'svelte-i18n';

  /**
   * Add to album. Albums are what photos are organised into, so the chooser lists albums only;
   * collections group albums and are not a destination for assets. The caller passes the albums
   * the signed-in user can add to, so an album someone else owns is never offered.
   */
  type AlbumOption = { id: string; name: string; count?: number };

  let {
    count,
    albums = [],
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    albums?: AlbumOption[];
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  let query = $state('');
  let albumId = $state('');

  let needle = $derived(query.trim().toLowerCase());
  let matches = $derived(needle ? albums.filter((album) => album.name.toLowerCase().includes(needle)) : albums);
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_add_to_album')}
  submitLabel={$t('frameleaf_bulk_add_to_album_apply', { values: { count } })}
  valid={!!albumId}
  preview={albums.length === 0 ? $t('frameleaf_bulk_album_none') : undefined}
  onSubmit={() => onSubmit({ albumId })}
>
  <label>
    {$t('search')}
    <input type="search" bind:value={query} placeholder={$t('frameleaf_bulk_album_search')} />
  </label>
  <ul>
    {#each matches as album (album.id)}
      <li>
        <label>
          <input type="radio" value={album.id} bind:group={albumId} />
          <span>{album.name}</span>
          {#if album.count !== undefined}<small>{album.count}</small>{/if}
        </label>
      </li>
    {:else}
      <li class="empty">{$t('frameleaf_bulk_album_no_matches')}</li>
    {/each}
  </ul>
</BulkFormDialog>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 14rem;
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
  small {
    margin-inline-start: auto;
    color: var(--fl-muted);
  }
  .empty {
    color: var(--fl-muted);
    font-size: 0.75rem;
    padding: 0.4rem 0.6rem;
  }
</style>
