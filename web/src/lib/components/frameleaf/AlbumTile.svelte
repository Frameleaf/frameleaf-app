<script lang="ts">
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
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
  import {
    mdiAccountArrowLeftOutline,
    mdiAccountMultipleOutline,
    mdiAutoFix,
    mdiBackupRestore,
    mdiFolderOutline,
    mdiImageMultipleOutline,
    mdiSubdirectoryArrowRight,
  } from '@mdi/js';
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
    /** A plain album takes another album dropped on it, which then goes inside it (approved design, 2026-11-04). */
    acceptsNest?: boolean;
    onNestDrop?: (albumId: string) => void;
    actions?: Snippet;
    /** Where the tile opens. Defaults to the album view; a shared space opens its own page. */
    href?: string;
    /** Just moved by Move earlier / Move later: the tile shows a ring that fades, so the eye finds it. */
    moved?: boolean;
    /**
     * FL-1836: albums shown inside this one. A collection, or an album holding albums, is one tile drawn as a
     * stack with "3 albums" on its cover; its albums never appear outside it.
     */
    inside?: number;
    /** FL-1836: a search result's parent, shown as "in Family" under the name. */
    where?: string;
    /** FL-1836: for a collection, its items with everything inside it; the album's own count otherwise. */
    total?: number;
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
    acceptsNest = false,
    onNestDrop,
    actions,
    href: hrefOverride,
    moved = false,
    inside = 0,
    where,
    total,
  }: Props = $props();

  let over = $state(false);
  let failedCover = $state<string | null>(null);

  const name = $derived(album.albumName || $t('unnamed_album'));
  // Every kind opens in the album (library) view, a shared space too (owner, 2026-11-05).
  const href = $derived(hrefOverride ?? Route.viewAlbum({ id: album.id }));
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
  // FL-416: a Recovered Media album (files Immich had lost track of, brought back after an Immich import)
  // carries a small mark of its own and says so under its name, as the approved prototype does.
  const recoveredLabel = $derived(album.recovered ? $t('frameleaf_albums_recovered_mark') : undefined);
  const metaLine = $derived(
    [
      // FL-1297: while its numbers are still being worked out, a tile shows its name and cover and no count.
      album.statsPending ? undefined : $t('frameleaf_albums_items', { values: { count: album.assetCount } }),
      monthSpan(album.startDate, album.endDate, $locale ?? undefined),
      album.recovered ? $t('frameleaf_albums_recovered') : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const holds = $derived(inside > 0 || album.kind === AlbumKind.Collection);
  const meta = $derived(
    holds
      ? [
          $t('frameleaf_albums_count', { values: { count: inside } }),
          album.statsPending || !(total ?? album.assetCount)
            ? undefined
            : $t('frameleaf_albums_items', { values: { count: total ?? album.assetCount } }),
        ]
          .filter(Boolean)
          .join(' · ')
      : metaLine,
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
    if (!((acceptsReorder || acceptsNest) && isAlbumDrag(event))) {
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
    if (!((acceptsReorder || acceptsNest) && albumId)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (acceptsReorder) {
      onReorderDrop?.(albumId);
    } else {
      onNestDrop?.(albumId);
    }
  };
</script>

<article
  class="tile {layout}"
  class:dragging
  class:drop-before={over && acceptsReorder}
  class:drop-into={over && acceptsNest && !acceptsReorder}
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
  <div class="stack" class:stacked={holds}>
    {#if holds && layout === 'grid'}
      <span class="sheet two" aria-hidden="true"></span>
      <span class="sheet one" aria-hidden="true"></span>
    {/if}
    <a class="cover" {href} aria-label={$t('frameleaf_albums_open', { values: { name } })}>
      <!-- A cover whose thumbnail is not made yet (or failed) shows the album icon, never a broken image. -->
      {#if cover && failedCover !== cover}
        <img
          src={cover}
          alt=""
          loading="lazy"
          draggable="false"
          data-fl-shared="album:{album.id}"
          onerror={() => (failedCover = cover)}
        />
      {:else}
        <span class="cover-empty" aria-hidden="true">
          <AlbumIcon name={album.icon ?? defaultIconFor(album.kind)} size={layout === 'grid' ? '30' : '20'} />
        </span>
      {/if}
      <!-- Top leading corner (collections.css .al-smart); the top trailing corner belongs to the "…" button. -->
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
        {#if recoveredLabel}
          <span
            class="mark recovered"
            role="img"
            title={recoveredLabel}
            aria-label={recoveredLabel}
            data-testid="album-recovered-mark"
          >
            <Icon icon={mdiBackupRestore} size={ICON_SIZE.xs} aria-hidden />
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
      {#if holds && layout === 'grid'}
        <span class="inside-badge">
          <Icon icon={mdiImageMultipleOutline} size={ICON_SIZE.xs} aria-hidden />
          {$t('frameleaf_albums_count', { values: { count: inside } })}
        </span>
      {/if}
    </a>
  </div>
  <div class="text">
    <a class="name" {href}
      >{#if album.color}<AlbumMark icon={album.icon} color={album.color} kind={album.kind} size="16" />
      {/if}{name}</a
    >
    <div class="meta">
      {#if album.folderAlbum}
        <!-- FL-838: made from a folder in the viewer's library (FL-1836: an icon by the count, not a badge) -->
        <span class="folder" title={$t('frameleaf_album_folder_mark')} data-testid="album-folder-mark">
          <Icon icon={mdiFolderOutline} size={ICON_SIZE.xs} aria-label={$t('frameleaf_album_folder_mark')} />
        </span>
      {/if}
      <small>{meta}</small>
      <AlbumAvatarStack users={others} />
    </div>
    {#if where}
      <span class="where">
        <Icon icon={mdiSubdirectoryArrowRight} size={ICON_SIZE.xs} aria-hidden />
        <span>{$t('frameleaf_albums_lives_in', { values: { name: where } })}</span>
      </span>
    {/if}
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
  .tile.drop-before,
  .tile.drop-into {
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
    top: var(--fl-space-2);
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
    gap: var(--fl-space-1);
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
    /* FL-1411 (M10): two lines, so careless names are cut after they differ, not before. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
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
  /* collections.css .al-card-menu: 8px in from the cover's corner, clear of its rounding. */
  .actions {
    position: absolute;
    top: var(--fl-space-2);
    margin-top: var(--fl-space-2); /* the stack's room above every grid cover */
    inset-inline-end: var(--fl-space-2);
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
    margin-top: 0;
    opacity: 1;
  }
  /*
   * FL-1836: a collection is a stack, two sheets peeking above its cover. Every grid tile keeps the 8px the
   * sheets need, so covers line up across a row.
   */
  .stack {
    position: relative;
  }
  .tile.grid .stack {
    padding-top: var(--fl-space-2);
  }
  .sheet {
    position: absolute;
    inset-inline: 10%;
    height: 12px;
    border-radius: var(--fl-radius-card) var(--fl-radius-card) 0 0;
    background: color-mix(in srgb, var(--fl-text), transparent 62%);
  }
  .sheet.two {
    top: 0;
    inset-inline: 18%;
    background: color-mix(in srgb, var(--fl-text), transparent 80%);
  }
  .sheet.one {
    top: var(--fl-space-1);
  }
  .inside-badge {
    position: absolute;
    inset-inline-start: var(--fl-space-2);
    bottom: var(--fl-space-2);
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-height: 24px;
    padding: 0 var(--fl-space-2);
    border-radius: 999px;
    background: color-mix(in srgb, var(--fl-viewer-canvas), transparent 30%);
    color: var(--fl-viewer-text);
    font-size: var(--fl-font-small);
    font-weight: 600;
    pointer-events: none;
  }
  .meta .folder {
    display: inline-flex;
    flex: none;
    margin-inline-end: calc(-1 * var(--fl-space-1));
  }
  .meta small {
    flex: 1;
    min-width: 0;
  }
  .where {
    display: flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .where > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tile.list .stack {
    flex: 0 0 3rem;
  }
  .tile.list .marks {
    top: auto;
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
