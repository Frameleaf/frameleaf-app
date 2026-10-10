<script lang="ts">
  import AlbumAvatarStack from '$lib/components/frameleaf/AlbumAvatarStack.svelte';
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import { defaultIconFor, monthSpan, othersOf } from '$lib/frameleaf/album-directory';
  import { originOwnerName } from '$lib/frameleaf/partner-sharing';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAlbumDragData, isAlbumDrag, setAlbumDragData } from '$lib/utils/album-drag';
  import { AlbumKind, AssetMediaSize, type AlbumResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccountArrowLeftOutline, mdiAccountMultipleOutline, mdiAutoFix } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  /**
   * Square album tile (grid) or row (list): cover, name, count and who else
   * can see it; a small mark for smart albums and shared spaces. The menu is
   * passed in as `actions` so the tile stays free of page behaviour.
   */
  interface Props {
    album: AlbumResponseDto;
    currentUserId: string;
    layout?: 'grid' | 'list';
    /** The owner may drag an album onto a collection shelf; touch uses Move to… */
    draggable?: boolean;
    dragging?: boolean;
    onDragStart?: (album: AlbumResponseDto) => void;
    onDragEnd?: () => void;
    /** In custom order (FL-52), another item of the same group may be dropped here to go just before this one. */
    acceptsReorder?: boolean;
    onReorderDrop?: (albumId: string) => void;
    actions?: Snippet;
    /** Where the tile opens. Defaults to the album view; a shared space opens its own page. */
    href?: string;
    /** Just moved by Move earlier / Move later: the tile shows a ring that fades, so the eye finds it. */
    moved?: boolean;
  }

  let {
    album,
    currentUserId,
    layout = 'grid',
    draggable = false,
    dragging = false,
    onDragStart,
    onDragEnd,
    acceptsReorder = false,
    onReorderDrop,
    actions,
    href: hrefOverride,
    moved = false,
  }: Props = $props();

  let over = $state(false);

  const name = $derived(album.albumName || $t('unnamed_album'));
  // A shared space opens on its own page, whose panels include the photos; everything else on the album view.
  const href = $derived(
    hrefOverride ??
      (album.kind === AlbumKind.Space ? Route.viewSharedSpace({ id: album.id }) : Route.viewAlbum({ id: album.id })),
  );
  const cover = $derived(
    album.albumThumbnailAssetId
      ? getAssetMediaUrl({ id: album.albumThumbnailAssetId, size: AssetMediaSize.Thumbnail })
      : null,
  );
  const others = $derived(othersOf(album, currentUserId));
  // FL-326: an album partner sharing copied into this library names the library it came from
  const originName = $derived(originOwnerName(album.origin));
  const originLabel = $derived(
    originName ? $t('frameleaf_partner_origin', { values: { name: originName } }) : undefined,
  );
  const meta = $derived(
    [
      $t('frameleaf_albums_items', { values: { count: album.assetCount } }),
      monthSpan(album.startDate, album.endDate, $locale ?? undefined),
    ]
      .filter(Boolean)
      .join(' · '),
  );

  const handleDragStart = (event: DragEvent) => {
    if (!draggable) {
      event.preventDefault();
      return;
    }
    setAlbumDragData(event, album.id);
    onDragStart?.(album);
  };

  const handleDragOver = (event: DragEvent) => {
    if (!(acceptsReorder && isAlbumDrag(event))) {
      return;
    }
    // Handled here, so the collection shelf around the tile does not take it as a move into the collection.
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    over = true;
  };
  const handleDrop = (event: DragEvent) => {
    over = false;
    const albumId = getAlbumDragData(event);
    if (!(acceptsReorder && albumId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onReorderDrop?.(albumId);
  };
</script>

<article
  class="tile {layout}"
  class:dragging
  class:drop-before={over && acceptsReorder}
  class:moved
  aria-label={name}
  {draggable}
  ondragstart={handleDragStart}
  ondragend={() => {
    over = false;
    onDragEnd?.();
  }}
  ondragover={handleDragOver}
  ondragenter={handleDragOver}
  ondragleave={() => (over = false)}
  ondrop={handleDrop}
>
  <a class="cover" {href} aria-label={$t('frameleaf_albums_open', { values: { name } })}>
    {#if cover}
      <img src={cover} alt="" loading="lazy" draggable="false" data-fl-shared="album:{album.id}" />
    {:else}
      <span class="cover-empty" aria-hidden="true">
        <AlbumIcon name={album.icon ?? defaultIconFor(album.kind)} size={layout === 'grid' ? '30' : '20'} />
      </span>
    {/if}
    <!-- Bottom leading corner: the top trailing corner belongs to the "…" button. -->
    <span class="marks">
      {#if album.isSmart}
        <span class="mark" title={$t('frameleaf_albums_smart_mark')} aria-hidden="true">
          <Icon icon={mdiAutoFix} size={ICON_SIZE.xs} />
        </span>
      {/if}
      {#if album.kind === AlbumKind.Space}
        <span class="mark space" title={$t('frameleaf_albums_space_mark')} aria-hidden="true">
          <Icon icon={mdiAccountMultipleOutline} size={ICON_SIZE.xs} />
        </span>
      {/if}
      {#if originLabel}
        <span
          class="mark origin"
          role="img"
          title={originLabel}
          aria-label={originLabel}
          data-testid="album-origin-mark"
        >
          <Icon icon={mdiAccountArrowLeftOutline} size={ICON_SIZE.xs} aria-hidden />
        </span>
      {/if}
    </span>
  </a>
  <div class="text">
    <a class="name" {href}>{name}</a>
    <div class="meta">
      <small>{meta}</small>
      <AlbumAvatarStack users={others} />
    </div>
  </div>
  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</article>

<style>
  /* collections.css .al-card at the Albums page's denser rhythm (apple-style.css:941-984). */
  .tile {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    color: var(--fl-text);
    border-radius: var(--fl-radius-card);
    transition:
      opacity var(--fl-motion) var(--fl-ease),
      transform var(--fl-motion) var(--fl-ease);
  }
  .tile.dragging {
    opacity: 0.45;
    transform: scale(0.97);
  }
  .tile[draggable='true'] {
    cursor: grab;
  }
  /* The item a custom-order drag lands before (FL-52), marked like the prototype's drop target (collections.css:657-660). */
  .tile.drop-before {
    box-shadow: 0 0 0 2px var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent), transparent 90%);
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
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform var(--fl-motion-slow) var(--fl-ease);
  }
  .tile.grid:hover .cover {
    transform: translateY(-2px);
    box-shadow: var(--fl-shadow-2);
  }
  .tile.grid:hover .cover img {
    transform: scale(1.03);
  }
  .cover-empty {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    color: var(--fl-muted);
  }
  .marks {
    position: absolute;
    bottom: var(--fl-space-2);
    inset-inline-start: var(--fl-space-2);
    display: inline-flex;
    gap: var(--fl-space-1);
    pointer-events: none;
  }
  .mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border-radius: 50%;
    /* A dark chip in both themes: it sits on a photo, like the viewer chrome. */
    background: color-mix(in srgb, var(--fl-viewer-canvas), transparent 40%);
    color: var(--fl-viewer-text);
    pointer-events: auto;
  }
  /* Move earlier / Move later: a ring around the tile that fades, so the eye lands on what moved. */
  .tile.moved::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: calc(var(--fl-radius-card) + 4px);
    box-shadow: 0 0 0 2px var(--fl-accent);
    pointer-events: none;
    animation: fl-fade-out calc(var(--fl-motion-slow) * 2.5) var(--fl-ease) both;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 0 2px;
  }
  .name {
    align-self: flex-start;
    max-width: 100%;
    font-size: var(--fl-font-size);
    font-weight: 600;
    line-height: 1.3;
    color: inherit;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px; /* the shared-with avatars: every tile keeps one baseline */
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .meta small {
    font-size: inherit;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    position: absolute;
    top: 0.25rem;
    inset-inline-end: 0.25rem;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .tile:hover .actions,
  .tile:focus-within .actions {
    opacity: 1;
  }
  .tile.list {
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--fl-border);
    border-radius: 0;
  }
  .tile.list .cover {
    flex: 0 0 3rem;
    width: 3rem;
    border-radius: var(--fl-radius);
  }
  .tile.list .text {
    flex: 1;
  }
  .tile.list .meta {
    justify-content: flex-start;
  }
  .tile.list .actions {
    position: static;
    opacity: 1;
  }
  .tile.list .marks {
    bottom: 2px;
    inset-inline-start: 2px;
  }
  .tile.list .mark {
    width: 1rem;
    height: 1rem;
  }
  .tile.list.moved::after {
    inset: 0;
    border-radius: var(--fl-radius-control);
  }
  @media (pointer: coarse) {
    .actions {
      opacity: 1;
    }
  }
</style>
