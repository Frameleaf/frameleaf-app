<script lang="ts">
  /**
   * The collections an item is in, for the Boards details panel (approved prototype `Inspector`
   * collections section, README points 6 and 22): each as its full path
   * ("Brand refresh 2027 › Moodboards") behind the collection's own icon in its own colour, linking
   * to it, then "Add to…", which opens the app's existing add-to-album flow.
   *
   * Collections are albums: the item's albums come from the album list filtered by item, and the
   * path from the album directory's parent chain. A collection without a colour keeps the plain
   * icon colour; a failed read is shown in place with a Retry.
   */
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { albumAncestors, defaultIconFor } from '$lib/frameleaf/album-directory';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { tagColorHex, TAG_COLORS, type TagColorId } from '$lib/frameleaf/tag-tree';
  import AssetAddToAlbumModal from '$lib/modals/AssetAddToAlbumModal.svelte';
  import { Route } from '$lib/route';
  import {
    getAlbumTree,
    getAllAlbums,
    type AlbumResponseDto,
    type AlbumTreeResponseDto,
    type LibraryViewScope,
  } from '@frameleaf/sdk';
  import { modalManager } from '@frameleaf/ui';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    assetId,
    scope,
    canAdd = false,
  }: {
    assetId: string;
    /** The album directory the paths are read from (Boards reads its design collections). */
    scope?: LibraryViewScope;
    /** Shows "Add to…"; the owner organises their own items. */
    canAdd?: boolean;
  } = $props();

  type Entry = { album: AlbumResponseDto; path: string };

  const headingId = $props.id();
  let entries = $state<Entry[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let generation = $state(0);
  let tree: AlbumTreeResponseDto | null = null;

  /** The collection's colour as one of the eight tag colours; anything else draws uncoloured. */
  const colourOf = (color: string | null) =>
    color && TAG_COLORS.some((option) => option.id === color) ? tagColorHex(color as TagColorId) : undefined;

  const read = async (id: string, signal: AbortSignal): Promise<Entry[]> => {
    const albums = await getAllAlbums({ assetId: id }, { signal });
    if (albums.some((album) => album.parentId) && !tree) {
      tree = await getAlbumTree({ libraryScope: scope }, { signal });
    }
    return albums
      .map((album) => ({
        album,
        path: [...(tree ? albumAncestors(tree, album) : []), album]
          .map((item) => item.albumName || $t('unnamed_album'))
          .join(' › '),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  };

  $effect(() => {
    const id = assetId;
    const version = generation;
    const controller = new AbortController();
    entries = [];
    failed = false;
    loading = true;
    void read(id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && assetId === id && generation === version) {
          entries = value;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && assetId === id && generation === version) {
          failed = true;
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && assetId === id && generation === version) {
          loading = false;
        }
      });
    return () => controller.abort();
  });

  onDestroy(
    onLibraryAccessChange(() => {
      entries = [];
      tree = null;
      generation++;
    }),
  );

  const addTo = async () => {
    await modalManager.show(AssetAddToAlbumModal, { assetIds: [assetId] });
    // A new collection may have been made in the picker, so the directory is read again too.
    tree = null;
    generation++;
  };
</script>

<section class="fl-boards-collections" aria-labelledby={headingId} aria-busy={loading}>
  <div class="head">
    <h3 id={headingId}>{$t('frameleaf_boards_collections')}</h3>
    {#if canAdd}<Button variant="quiet" onclick={() => void addTo()}>{$t('add_to')}</Button>{/if}
  </div>
  {#if failed}
    <InlineError compact message={$t('frameleaf_boards_collections_unavailable')} onRetry={() => generation++} />
  {:else if loading}
    <p role="status">{$t('loading')}</p>
  {:else if entries.length === 0}
    <p>{$t('frameleaf_boards_collections_empty')}</p>
  {:else}
    <ul>
      {#each entries as { album, path } (album.id)}
        <li>
          <a href={Route.viewAlbum({ id: album.id })}>
            <span class="mark" style:color={colourOf(album.color)}>
              <AlbumIcon name={album.icon ?? defaultIconFor(album.kind)} size="16" />
            </span>
            <span>{path}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .fl-boards-collections {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
  }
  h3 {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12px;
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  ul {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  a {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 32px;
    padding: 4px var(--fl-space-2);
    border-radius: var(--fl-radius-sm);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  a:hover {
    background: var(--fl-raised);
  }
  a:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .mark {
    display: inline-grid;
    flex-shrink: 0;
    color: var(--fl-muted);
  }
</style>
