<script lang="ts">
  import AlbumAvatarStack from '$lib/components/frameleaf/AlbumAvatarStack.svelte';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import { defaultIconFor, othersOf, type AlbumShelf } from '$lib/frameleaf/album-directory';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAlbumDragData, isAlbumDrag } from '$lib/utils/album-drag';
  import { AssetMediaSize } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronDown, mdiChevronRight, mdiPlus } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * One collection laid out as a shelf: a 2x2 mosaic of its album covers, its
   * name, album and item counts, description, member avatars, a New album
   * action and a menu, with its albums beneath (rendered by the caller). The
   * shelf is a drop target for an album being dragged.
   */
  interface Props {
    shelf: AlbumShelf;
    currentUserId: string;
    collapsed: boolean;
    canEdit: boolean;
    /** Whether the album currently being dragged may land here. */
    acceptsDrop: boolean;
    onToggle: () => void;
    onNewAlbum: () => void;
    onDrop: (albumId: string) => void;
    actions: Snippet;
    children: Snippet;
  }

  let {
    shelf,
    currentUserId,
    collapsed,
    canEdit,
    acceptsDrop,
    onToggle,
    onNewAlbum,
    onDrop,
    actions,
    children,
  }: Props = $props();

  let over = $state(false);
  const titleId = $props.id();

  const collection = $derived(shelf.collection);
  const name = $derived(collection.albumName || $t('unnamed_album'));
  const covers = $derived(
    shelf.all
      .map((album) => album.albumThumbnailAssetId)
      .filter((id): id is string => !!id)
      .slice(0, 4)
      .map((id) => getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail })),
  );
  const others = $derived(othersOf(collection, currentUserId));

  const onDragOver = (event: DragEvent) => {
    if (!(acceptsDrop && isAlbumDrag(event))) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    over = true;
  };

  const onDragLeave = (event: DragEvent) => {
    if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
      over = false;
    }
  };

  const handleDrop = (event: DragEvent) => {
    over = false;
    const albumId = getAlbumDragData(event);
    if (albumId && acceptsDrop) {
      event.preventDefault();
      onDrop(albumId);
    }
  };
</script>

<section
  class="shelf"
  class:drop-target={over}
  class:accepts={acceptsDrop}
  aria-labelledby={titleId}
  ondragover={onDragOver}
  ondragenter={onDragOver}
  ondragleave={onDragLeave}
  ondrop={handleDrop}
>
  <div class="head">
    <button
      type="button"
      class="toggle"
      aria-expanded={!collapsed}
      aria-label={$t(collapsed ? 'frameleaf_albums_expand' : 'frameleaf_albums_collapse', { values: { name } })}
      onclick={onToggle}
    >
      <Icon icon={collapsed ? mdiChevronRight : mdiChevronDown} size="20" />
    </button>
    <a
      class="open"
      href={Route.viewAlbum({ id: collection.id })}
      aria-label={$t('frameleaf_albums_open', { values: { name } })}
    >
      <span class="mosaic" class:single={covers.length === 1} aria-hidden="true">
        {#if covers.length === 0}
          <span class="mosaic-icon"
            ><AlbumIcon name={collection.icon ?? defaultIconFor(collection.kind)} size="22" /></span
          >
        {:else if covers.length === 1}
          <img src={covers[0]} alt="" draggable="false" />
        {:else}
          {#each [0, 1, 2, 3] as index (index)}
            {#if covers[index]}
              <img src={covers[index]} alt="" draggable="false" />
            {:else}
              <span class="tile"></span>
            {/if}
          {/each}
        {/if}
      </span>
      <span class="text">
        <h2 id={titleId}>{name}</h2>
        <small>
          {$t('frameleaf_albums_count', { values: { count: shelf.albumCount } })}
          · {$t('frameleaf_albums_items', { values: { count: shelf.assetCount } })}
          {#if collection.description}
            · {collection.description}
          {/if}
        </small>
      </span>
    </a>
    <div class="side">
      <AlbumAvatarStack users={others} size="md" />
      {#if canEdit}
        <button
          type="button"
          class="new"
          aria-label={$t('frameleaf_albums_new_album_in', { values: { name } })}
          onclick={onNewAlbum}
        >
          <Icon icon={mdiPlus} size="18" />
          <span>{$t('album')}</span>
        </button>
      {/if}
      {@render actions()}
    </div>
  </div>
  {#if !collapsed}
    {@render children()}
  {/if}
</section>

<style>
  /*
   * A collection shelf (collections.css .al-shelf) at the Albums page's tighter rhythm
   * (apple-style.css:951-968): no card around it, 28px between shelves, a 44px mosaic and a
   * 17px title. Dragging an album onto it tints it like the prototype's drop target.
   */
  .shelf {
    margin-bottom: 28px;
    padding: 0;
    border-radius: 16px;
    transition:
      box-shadow var(--fl-motion) var(--fl-ease),
      background var(--fl-motion) var(--fl-ease);
  }
  .shelf.accepts {
    outline: 1px dashed var(--fl-border);
    outline-offset: 4px;
  }
  .shelf.drop-target {
    background: color-mix(in srgb, var(--fl-accent), transparent 90%);
    box-shadow: 0 0 0 2px var(--fl-accent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .toggle {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    border-radius: var(--fl-radius);
  }
  .open {
    display: flex;
    flex: 0 1 auto;
    min-width: 0;
    align-items: center;
    gap: 14px;
    padding: 2px 8px 2px 2px;
    color: inherit;
    text-decoration: none;
    border-radius: 14px;
    transition: background var(--fl-motion-fast) var(--fl-ease);
  }
  .open:hover {
    background: var(--fl-raised);
  }
  .open:hover h2 {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .mosaic {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: 10px;
    background: var(--fl-raised);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fl-text), transparent 90%);
  }
  .mosaic.single {
    grid-template-columns: 1fr;
  }
  .mosaic img,
  .mosaic .tile {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    background: var(--fl-border);
  }
  .mosaic-icon {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fl-muted);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small {
    margin-top: 3px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .new {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .new:hover {
    border-color: var(--fl-accent);
  }
  @media (max-width: 700px) {
    .head {
      flex-wrap: wrap;
    }
    .open {
      flex: 1 1 0%;
    }
    .side {
      flex-basis: 100%;
      margin-left: 0;
      padding-left: 38px;
    }
    .toggle {
      min-height: 44px;
    }
    small {
      white-space: normal;
    }
  }
</style>
