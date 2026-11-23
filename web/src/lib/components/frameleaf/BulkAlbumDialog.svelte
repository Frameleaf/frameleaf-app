<script lang="ts">
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import {
    albumTargetRows,
    buildAlbumTargets,
    countAlbumTargets,
    emptyAlbumTargets,
    flattenAlbumTargets,
    searchAlbumTargets,
    withoutAlbumTargets,
    type AlbumTarget,
    type AlbumTargetDirectory,
  } from '$lib/frameleaf/album-targets';
  import { albumAncestorNames } from '$lib/frameleaf/album-tree';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { onMount, onDestroy } from 'svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import {
    createAlbum,
    getAllAlbums,
    getRecentlyAddedAlbums,
    LibraryScope,
    LibraryViewScope,
    type AlbumResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiMagnify, mdiPlus } from '@mdi/js';
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
   *
   * Several albums can be ticked, and a typed name that doesn't exist becomes a new album. New albums
   * are only made on Add, so Cancel never leaves an empty one behind. The five albums that most
   * recently received items lead the list.
   */
  const PAGE = 60;
  const RECENT_ALBUMS = 5;

  const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  let {
    count,
    open = $bindable(true),
    onSubmit,
    onClosed,
    libraryScope,
  }: {
    count: number;
    libraryScope?: LibraryViewScope;
    open?: boolean;
    /** Giving false keeps the dialog open with its choices, for a retry. */
    onSubmit: (payload: BulkPayload) => void | Promise<boolean>;
    onClosed?: () => void;
  } = $props();

  let directory = $state<AlbumTargetDirectory>(emptyAlbumTargets());
  /** The album list the targets were built from, for each row's icon, colour and path. */
  let albums = $state<AlbumResponseDto[]>([]);
  const byId = $derived(new Map(albums.map((album) => [album.id, album])));
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
  let query = $state('');
  let chosen = $state<string[]>([]);
  /** Names of albums to create when Add is pressed. */
  let drafts = $state<string[]>([]);
  /** Read once per load, so rows don't move while someone is ticking them. */
  let recentIds = $state<string[]>([]);
  let limit = $state(PAGE);

  /** Best effort: the picker works the same, without a Recent group, if this can't be read. */
  const loadRecentIds = async () => {
    try {
      const { albumIds } = await getRecentlyAddedAlbums(libraryScope ? { libraryScope } : {});
      return albumIds;
    } catch {
      return [];
    }
  };
  let generation = 0;
  onDestroy(() => generation++);
  const load = async () => {
    const version = ++generation;
    const current = authManager.captureSession();
    directory = emptyAlbumTargets();
    albums = [];
    status = 'loading';
    try {
      const [loaded, recent] = await Promise.all([getAllAlbums(libraryScope ? { libraryScope } : {}), loadRecentIds()]);
      if (!current() || version !== generation) {
        return;
      }
      albums = loaded;
      recentIds = recent;
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
      recentIds = [];
      chosen = [];
      drafts = [];
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
  const targets = $derived(flattenAlbumTargets(directory));
  const recent = $derived.by(() => {
    const byTargetId = new Map(targets.map((target) => [target.id, target]));
    return recentIds.flatMap((id) => byTargetId.get(id) ?? []).slice(0, RECENT_ALBUMS);
  });
  const pathOf = (id: string) => albumAncestorNames(albums, id, $t('unnamed_album')).join(' › ');
  let page = $derived(
    albumTargetRows(searching ? matches : withoutAlbumTargets(directory, new Set(recent.map(({ id }) => id))), limit),
  );
  let albumTotal = $derived(countAlbumTargets(directory));
  let preview = $derived(
    status === 'failed'
      ? $t('frameleaf_bulk_album_load_failed')
      : status === 'ready' && albumTotal === 0
        ? $t('frameleaf_bulk_album_none')
        : undefined,
  );

  const typed = $derived(query.trim());
  const exact = $derived(typed ? targets.find((target) => sameName(target.name, typed)) : undefined);
  const canCreate = $derived(status === 'ready' && !!typed && !exact && drafts.every((name) => !sameName(name, typed)));
  const shownDrafts = $derived(drafts.filter((name) => name.toLowerCase().includes(typed.toLowerCase())));
  const total = $derived(chosen.length + drafts.length);
  const chosenNames = $derived([...targets.filter(({ id }) => chosen.includes(id)).map(({ name }) => name), ...drafts]);

  const toggle = (id: string) => {
    chosen = chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id];
  };
  const addDraft = () => {
    drafts = [...drafts, typed];
    query = '';
    limit = PAGE;
  };
  const onSearchKeydown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    if (!typed) {
      event.currentTarget.form?.requestSubmit();
    } else if (canCreate) {
      addDraft();
    } else if (exact) {
      toggle(exact.id);
      query = '';
    }
  };

  /** Albums made by this dialog, whose rows may not have loaded yet. */
  const createdNames: Record<string, string> = {};
  const send = () =>
    onSubmit(
      chosen.length === 1
        ? { albumId: chosen[0] }
        : {
            albumId: chosen[0],
            albumIds: chosen,
            albumNames: { ...Object.fromEntries(targets.map(({ id, name }) => [id, name])), ...createdNames },
          },
    );

  /** Makes the new albums, then adds. A failure keeps the dialog open, and a retry won't remake any album. */
  const createThenSend = async () => {
    const current = authManager.captureSession();
    const scope = libraryScope === LibraryViewScope.Design ? { libraryScope: LibraryScope.Design } : {};
    const creating = drafts.length > 0;
    try {
      for (const albumName of drafts) {
        // Cancel stops here: nothing further is created or added.
        if (!open) {
          return false;
        }
        const album = await createAlbum({ createAlbumDto: { albumName, ...scope } });
        if (!current()) {
          return false;
        }
        eventManager.emit('AlbumCreate', album);
        drafts = drafts.filter((name) => name !== albumName);
        createdNames[album.id] = albumName;
        chosen = [...chosen, album.id];
      }
    } catch (error) {
      handleError(error, $t('errors.failed_to_create_album'));
      void load();
      return false;
    }
    if (!open) {
      return false;
    }
    if ((await send()) === false) {
      // The albums just made need rows, so they stay ticked and visible for the retry.
      if (creating) {
        void load();
      }
      return false;
    }
    return true;
  };
</script>

{#snippet targetRow(target: AlbumTarget, nested: boolean, path: string)}
  {@const album = byId.get(target.id)}
  <li class:nested>
    <label class="row">
      <input type="checkbox" checked={chosen.includes(target.id)} onchange={() => toggle(target.id)} />
      {#if album?.albumThumbnailAssetId}
        <img class="thumb" src={getAssetMediaUrl({ id: album.albumThumbnailAssetId })} alt="" loading="lazy" />
      {:else}
        <span class="thumb">
          <AlbumMark icon={album?.icon} color={album?.color} kind={album?.kind ?? target.kind} size="18" />
        </span>
      {/if}
      <span class="target">
        {#if path}<small class="path">{path}</small>{/if}
        <span class="name">{target.name}</span>
      </span>
      {#if target.kind === 'space'}<em>{$t('frameleaf_bulk_album_space')}</em>{/if}
      <small>{target.count}</small>
    </label>
  </li>
{/snippet}

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_add_to_album')}
  submitLabel={total > 1
    ? $t('frameleaf_bulk_add_to_albums_apply', { values: { count, albums: total } })
    : $t('frameleaf_bulk_add_to_album_apply', { values: { count } })}
  valid={total > 0}
  {preview}
  waitForSubmit
  onSubmit={createThenSend}
  {onClosed}
>
  <label class="search">
    <Icon icon={mdiMagnify} size="18" aria-hidden={true} />
    <!-- Stays enabled while albums load: a disabled field can't take the cursor when the dialog opens. -->
    <input
      type="search"
      bind:value={query}
      oninput={onSearch}
      onkeydown={onSearchKeydown}
      placeholder={$t('frameleaf_bulk_album_search_or_new')}
      aria-label={$t('frameleaf_bulk_album_search_or_new')}
      autocomplete="off"
      disabled={status === 'failed'}
      data-initial-focus
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
      {#if canCreate}
        <li>
          <button type="button" class="row create" onclick={addDraft}>
            <span class="thumb"><Icon icon={mdiPlus} size="18" aria-hidden={true} /></span>
            <span class="name">{$t('frameleaf_bulk_album_new', { values: { name: typed } })}</span>
          </button>
        </li>
      {/if}
      {#each shownDrafts as name (name)}
        <li>
          <label class="row">
            <input type="checkbox" checked onchange={() => (drafts = drafts.filter((item) => item !== name))} />
            <span class="thumb"><Icon icon={mdiPlus} size="18" aria-hidden={true} /></span>
            <span class="target"><span class="name">{name}</span></span>
            <small>{$t('frameleaf_bulk_album_new_label')}</small>
          </label>
        </li>
      {/each}
      {#if !searching && recent.length > 0}
        <li class="group"><span>{$t('recent')}</span></li>
        {#each recent as target (target.id)}
          {@render targetRow(target, false, '')}
        {/each}
        {#if page.rows.length > 0}
          <li class="group"><span>{$t('all_albums')}</span></li>
        {/if}
      {/if}
      {#each page.rows as row (row.type === 'collection' ? `collection:${row.id}` : row.target.id)}
        {#if row.type === 'collection'}
          {@const collection = byId.get(row.id)}
          <li class="group">
            <AlbumMark icon={collection?.icon} color={collection?.color} kind={collection?.kind} size="14" />
            <span>{row.name}</span>
          </li>
        {:else}
          {@render targetRow(row.target, row.nested, searching ? pathOf(row.target.id) : '')}
        {/if}
      {:else}
        {#if albumTotal > 0 && searching && !canCreate && shownDrafts.length === 0}
          <li class="empty">{$t('frameleaf_bulk_album_no_matches')}</li>
        {/if}
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
  <p class="summary" aria-live="polite">
    {total > 0
      ? $t('frameleaf_bulk_album_adding_to', { values: { names: chosenNames.join(', ') } })
      : $t('frameleaf_bulk_album_choose')}
  </p>
</BulkFormDialog>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.75rem;
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
    min-height: 40px;
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  ul {
    display: grid;
    align-content: start;
    gap: 2px;
    list-style: none;
    margin: 0;
    padding: 4px;
    height: min(40dvh, 18rem);
    overflow: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  li :global(.row) {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    min-width: 0;
    min-height: 48px;
    padding: 4px 0.75rem;
    border: 0;
    border-radius: var(--fl-radius);
    background: none;
    color: var(--fl-text);
    font: inherit;
    font-size: 0.875rem;
    text-align: start;
    cursor: pointer;
  }
  li :global(.row:hover),
  li :global(.row:has(input:checked)) {
    background: var(--fl-raised);
  }
  li.nested :global(.row) {
    padding-inline-start: 1.5rem;
  }
  li :global(.row input) {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    margin: 0;
    padding: 0;
    accent-color: var(--fl-accent);
  }
  .create {
    color: var(--fl-accent);
  }
  .thumb {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    object-fit: cover;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.75rem 0.75rem 0.25rem;
  }
  .target {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }
  .name,
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .create .name {
    flex: 1;
    min-width: 0;
  }
  .path {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.7rem;
  }
  li :global(.row:focus-visible),
  li :global(.row:has(input:focus-visible)) {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  em {
    color: var(--fl-muted);
    font-size: 0.7rem;
    font-style: normal;
  }
  label > small {
    flex-shrink: 0;
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-size: 0.75rem;
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
  .summary {
    margin: 0;
    overflow: hidden;
    color: var(--fl-muted);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
