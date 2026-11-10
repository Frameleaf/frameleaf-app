<script lang="ts">
  /**
   * Boards' grid (prototype ProWorkspace.jsx `Tile`, pro-workspace.css `.pro-grid`): Board lays the
   * items out in columns, each keeping its own shape; Grid crops them to even squares. A saved link
   * is a card with its picture, title and site. Each tile carries its badges (a video's length, a
   * file type other than JPEG or PNG, the rating) and a round check in the corner that selects it.
   *
   * Pressing a tile opens it in Details (`onOpen`) rather than the full viewer; once something is
   * selected, pressing a tile adds it to the selection or takes it out. Ctrl or ⌘ selects, Shift
   * selects a range, and a double-click opens a picture or video large (`onOpenLarge`).
   */
  import BrokenAsset from '$lib/components/assets/BrokenAsset.svelte';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { formatDuration } from '$lib/frameleaf/viewer-headline';
  import type { BoardsLayout } from '$lib/frameleaf/boards-view.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, LibraryAssetItemKind, type LibraryItemDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckboxBlankCircleOutline,
    mdiCheckCircle,
    mdiLinkVariant,
    mdiPlay,
    mdiStar,
    mdiThumbDown,
    mdiWeb,
  } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    items: LibraryItemDto[];
    /** The same media as timeline assets, for their shape and thumbhash. */
    assets: TimelineAsset[];
    session: LibrarySessionStore;
    layout: BoardsLayout;
    /** The narrowest a column may be, in px. */
    tileSize: number;
    showNames: boolean;
    /** The item open in Details, if any (`bookmark:<id>` for a saved link). */
    activeKey?: string | null;
    onOpen: (key: string) => void;
    onOpenLarge?: (asset: TimelineAsset) => void;
    onEndReached?: () => void;
    empty?: Snippet;
  };

  let {
    items,
    assets,
    session,
    layout,
    tileSize,
    showNames,
    activeKey = null,
    onOpen,
    onOpenLarge,
    onEndReached,
    empty,
  }: Props = $props();

  /** Tiles whose thumbnail did not load. Keyed with the thumbhash, so a preview made later is tried again. */
  let previewFailed = $state<Record<string, boolean>>({});
  const previewKey = (asset: TimelineAsset) => `${asset.id}:${asset.thumbhash ?? ''}`;

  /** File types worth a badge: not the everyday photo formats (prototype shows SVG, GIF…). */
  const PLAIN_TYPES = new Set(['JPG', 'JPEG', 'PNG', 'HEIC', 'HEIF', 'MP4', 'MOV', 'M4V']);

  type Tile =
    | {
        kind: 'asset';
        key: string;
        name: string;
        asset: TimelineAsset;
        format: string | null;
        duration: string | null;
        rating: number | null;
      }
    | {
        kind: 'link';
        key: string;
        name: string;
        host: string;
        previewAssetId: string | null;
        rating: number | null;
      };

  const byId = $derived(new Map(assets.map((asset) => [asset.id, asset])));
  const tiles = $derived(
    items.flatMap((item): Tile[] => {
      if (item.kind === LibraryAssetItemKind.Asset) {
        const asset = byId.get(item.asset.id);
        if (!asset) {
          return [];
        }
        const name = asset.originalFileName ?? '';
        const extension = name.includes('.') ? name.split('.').pop()!.toUpperCase() : '';
        const exif = 'exifInfo' in item.asset ? item.asset.exifInfo : undefined;
        return [
          {
            kind: 'asset',
            key: asset.id,
            name,
            asset,
            format: extension && !PLAIN_TYPES.has(extension) ? extension : null,
            duration: asset.isVideo ? formatDuration(asset.duration) : null,
            rating: exif?.isRejected ? -1 : (exif?.rating ?? null),
          },
        ];
      }
      const bookmark = item.bookmark;
      const url = libraryReferenceUrl(bookmark.url);
      const host = url ? new URL(url).hostname.replace(/^www\./, '') : '';
      return [
        {
          kind: 'link',
          key: `bookmark:${bookmark.id}`,
          name: bookmark.title || host || bookmark.url,
          host,
          previewAssetId: bookmark.previewAssetId,
          rating: bookmark.rating ?? null,
        },
      ];
    }),
  );
  const orderedIds = $derived(tiles.map(({ key }) => key));
  const selected = $derived(new Set(session.selection));
  const selecting = $derived(session.selection.length > 0);

  const toggle = (key: string, event: MouseEvent | KeyboardEvent) => {
    session.select(key, { range: event.shiftKey, orderedIds });
    session.setScrollAnchor(key);
  };
  const press = (tile: Tile, event: MouseEvent) => {
    if (selecting || event.shiftKey || event.ctrlKey || event.metaKey) {
      toggle(tile.key, event);
      return;
    }
    session.setScrollAnchor(tile.key);
    if (tile.kind === 'asset') {
      // Opening an item tries its thumbnail again: a load that failed for a moment is not left on the placeholder.
      delete previewFailed[previewKey(tile.asset)];
    }
    onOpen(tile.key);
  };

  let sentinel = $state<HTMLElement>();
  $effect(() => {
    const target = sentinel;
    if (!target || !onEndReached || typeof IntersectionObserver !== 'function') {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onEndReached();
        }
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  });
</script>

{#if tiles.length === 0}
  {@render empty?.()}
{:else}
  <ul
    class="bg-grid {layout}"
    class:is-selecting={selecting}
    style:--bg-tile="{tileSize}px"
    data-testid="boards-grid"
    aria-label={$t('frameleaf_boards_items')}
  >
    {#each tiles as tile (tile.key)}
      {@const isSelected = selected.has(tile.key)}
      <li
        class="bg-tile {tile.kind}"
        class:is-selected={isSelected}
        class:is-active={activeKey === tile.key}
        class:is-rejected={tile.rating === -1}
        data-asset-id={tile.key}
      >
        <button
          type="button"
          class="bg-open"
          aria-pressed={selecting ? isSelected : undefined}
          aria-label={tile.kind === 'link'
            ? $t(selecting ? 'frameleaf_boards_select_link' : 'frameleaf_boards_open_link', {
                values: { title: tile.name },
              })
            : $t(selecting ? 'frameleaf_boards_select_item' : 'frameleaf_boards_open_item', {
                values: { name: tile.name },
              })}
          onclick={(event) => press(tile, event)}
          ondblclick={() => {
            if (tile.kind === 'asset' && !selecting) {
              onOpenLarge?.(tile.asset);
            }
          }}
        >
          {#if tile.kind === 'link'}
            {#if tile.previewAssetId}
              <img
                class="bg-link-picture"
                src={getAssetMediaUrl({ id: tile.previewAssetId, size: AssetMediaSize.Thumbnail })}
                alt=""
                loading="lazy"
                draggable="false"
              />
            {:else}
              <span class="bg-link-blank" aria-hidden="true"><Icon icon={mdiWeb} size="36" /></span>
            {/if}
            <span class="bg-link-text">
              <strong>{tile.name}</strong>
              {#if tile.host}<small><Icon icon={mdiLinkVariant} size="13" aria-hidden={true} />{tile.host}</small>{/if}
            </span>
          {:else}
            {#if previewFailed[previewKey(tile.asset)]}
              <!-- No preview (a design file with no picture inside, or one still being made): the quiet placeholder. -->
              <span
                class="bg-missing"
                style:aspect-ratio={layout === 'board' ? String(tile.asset.ratio || 1) : undefined}
              >
                <BrokenAsset hideMessage width="100%" height="100%" />
              </span>
            {:else}
              <img
                src={getAssetMediaUrl({
                  id: tile.asset.id,
                  size: AssetMediaSize.Thumbnail,
                  cacheKey: tile.asset.thumbhash,
                })}
                alt=""
                loading="lazy"
                draggable="false"
                style:aspect-ratio={layout === 'board' ? String(tile.asset.ratio || 1) : undefined}
                onerror={() => (previewFailed[previewKey(tile.asset)] = true)}
              />
            {/if}
            {#if showNames}<span class="bg-name">{tile.name}</span>{/if}
          {/if}
        </button>
        <button
          type="button"
          class="bg-check"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={$t('frameleaf_boards_select_item', { values: { name: tile.name } })}
          onclick={(event) => toggle(tile.key, event)}
        >
          <Icon icon={isSelected ? mdiCheckCircle : mdiCheckboxBlankCircleOutline} size="22" aria-hidden={true} />
        </button>
        {#if tile.kind === 'asset' && tile.duration}
          <span class="bg-badge"><Icon icon={mdiPlay} size="13" aria-hidden={true} />{tile.duration}</span>
        {:else if tile.kind === 'asset' && tile.format}
          <span class="bg-badge">{tile.format}</span>
        {/if}
        {#if tile.rating !== null && tile.rating > 0}
          <span class="bg-rating" aria-label={$t('frameleaf_boards_rate_stars', { values: { count: tile.rating } })}>
            <Icon icon={mdiStar} size="12" aria-hidden={true} />{tile.rating}
          </span>
        {:else if tile.rating === -1}
          <span class="bg-rating rejected" aria-label={$t('frameleaf_search_rating_rejected')}>
            <Icon icon={mdiThumbDown} size="12" aria-hidden={true} />
          </span>
        {/if}
      </li>
    {/each}
  </ul>
  <div class="bg-end" bind:this={sentinel} aria-hidden="true"></div>
{/if}

<style>
  .bg-grid {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .bg-grid.board {
    columns: calc(var(--bg-tile) * 1.2);
    column-gap: var(--fl-space-3);
  }
  .bg-grid.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--bg-tile) * 1.2), 1fr));
    gap: var(--fl-space-3);
  }
  .bg-tile {
    position: relative;
    break-inside: avoid;
    margin-bottom: var(--fl-space-3);
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .bg-grid.grid .bg-tile {
    margin: 0;
  }
  .bg-tile.is-active {
    border-color: var(--fl-border-strong, var(--fl-muted));
  }
  .bg-tile.is-selected {
    border-color: var(--fl-accent);
    box-shadow: 0 0 0 2px var(--fl-accent);
  }
  .bg-tile.is-rejected img {
    opacity: 0.55;
  }
  .bg-open {
    display: block;
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-text);
    text-align: start;
    cursor: pointer;
  }
  .bg-open:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .bg-open img {
    display: block;
    width: 100%;
    object-fit: cover;
  }
  .bg-grid.grid .bg-tile.asset img {
    aspect-ratio: 1;
  }
  /* The placeholder keeps the picture's own shape, so a tile does not change size when its thumbnail fails. */
  .bg-missing {
    display: block;
    width: 100%;
    aspect-ratio: 4 / 3;
  }
  .bg-grid.grid .bg-tile.asset .bg-missing {
    aspect-ratio: 1;
  }
  .bg-link-picture,
  .bg-link-blank {
    aspect-ratio: 16 / 10;
  }
  .bg-grid.grid .bg-link-picture,
  .bg-grid.grid .bg-link-blank {
    aspect-ratio: 16 / 9;
  }
  .bg-link-blank {
    display: grid;
    place-items: center;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .bg-link-text {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    padding: var(--fl-space-3);
  }
  .bg-link-text strong {
    font-size: var(--fl-font-callout);
    line-height: 1.35;
  }
  .bg-link-text small,
  .bg-name {
    display: flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .bg-name {
    display: block;
    padding: var(--fl-space-2) var(--fl-space-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bg-check {
    position: absolute;
    top: var(--fl-space-2);
    left: var(--fl-space-2);
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.35);
    color: white;
    opacity: 0;
    cursor: pointer;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .bg-tile:hover .bg-check,
  .bg-check:focus-visible,
  .bg-tile.is-selected .bg-check,
  .bg-grid.is-selecting .bg-check {
    opacity: 1;
  }
  .bg-tile.is-selected .bg-check {
    color: var(--fl-accent);
    background: white;
  }
  .bg-badge,
  .bg-rating {
    position: absolute;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    border-radius: var(--fl-radius-pill);
    color: white;
    font-size: var(--fl-font-micro);
    pointer-events: none;
  }
  .bg-badge {
    top: var(--fl-space-2);
    right: var(--fl-space-2);
    padding: 2px var(--fl-space-2);
    background: rgb(0 0 0 / 0.6);
  }
  .bg-rating {
    right: var(--fl-space-2);
    bottom: var(--fl-space-2);
    padding: 2px 6px;
    background: rgb(0 0 0 / 0.55);
    color: var(--fl-warning, #f5b83d);
  }
  .bg-rating.rejected {
    color: var(--fl-danger);
  }
  .bg-tile.link .bg-rating {
    top: var(--fl-space-2);
    bottom: auto;
  }
  .bg-end {
    height: 1px;
  }
  @media (prefers-reduced-motion: reduce) {
    .bg-check {
      transition: none;
    }
  }
</style>
