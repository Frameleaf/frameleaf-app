<script lang="ts">
  /**
   * The Frameleaf grid over a flat, paged list of results (FL-33 cleanup).
   *
   * `LibraryTimeline` draws the library, where the timeline manager owns buckets, months and days.
   * Search results, the Best Photos ranking and a collection's photos are not that: they are an
   * ordered page of assets the page itself fetched, with no date buckets and no scrubber. This is
   * the same justified layout and the same `AssetTile` for that shape, bound to the same library
   * session, so a selection made here reaches the Frameleaf selection bar exactly as one made in
   * the timeline does.
   *
   * It replaces the legacy shared gallery grid. In the Timeline layout it lays out with
   * `getJustifiedLayoutFromAssets`; in Browse and Work it draws the same cell grids as the library
   * (FL-33: Browse's dense square grid, Work's 3:2 grid with captions), scaled by the per-device
   * Thumbnail size, and mounts only the rows in or near the viewport. It asks the page for the next
   * page when the end comes into view; it owns no viewer, no keyboard map and no actions — the page
   * mounts the viewer and the session carries the selection.
   */
  import AssetTile from '$lib/components/frameleaf/AssetTile.svelte';
  import { cellGrid, cellGridOptions, type TileLayout } from '$lib/frameleaf/library-grid';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getJustifiedLayoutFromAssets } from '$lib/utils/layout-utils';
  import type { Snippet } from 'svelte';

  type Props = {
    /** The results, in the order the page loaded them. */
    assets: TimelineAsset[];
    session: LibrarySessionStore;
    /** Ask for the next page. Fired once per end-of-list intersection. */
    onEndReached?: () => void;
    /** Open an item. Nothing opens when it is absent, so a picking grid simply selects. */
    onOpen?: (asset: TimelineAsset) => void;
    /** Picking mode: a plain click selects instead of opening. */
    selectionMode?: boolean;
    /** With `selectionMode`, a pick replaces the selection instead of adding to it. */
    singleSelect?: boolean;
    onSelect?: (asset: TimelineAsset) => void;
    /** Rating override; by default each tile shows the asset's own rating. */
    ratingFor?: (asset: TimelineAsset) => number | null;
    /** The tile layout; by default the session's (Timeline, Browse or Work). */
    layout?: TileLayout;
    /** Extra chrome drawn over every tile. */
    tileOverlay?: Snippet<[TimelineAsset]>;
    /** Rendered above the grid, inside the same scroll container. */
    header?: Snippet;
    empty?: Snippet;
  };

  let {
    assets,
    session,
    onEndReached,
    onOpen,
    selectionMode = false,
    singleSelect = false,
    onSelect,
    ratingFor,
    layout,
    tileOverlay,
    header,
    empty,
  }: Props = $props();

  /** Rows mounted above and below the viewport, so a fast scroll does not show empty cells. */
  const OVERSCAN_ROWS = 3;

  let width = $state(0);
  let sentinel = $state<HTMLElement>();
  let rowsElement = $state<HTMLElement>();

  const maxMd = $derived(mediaQueryManager.maxMd);
  const selection = $derived(session.selection);
  const selected = $derived(new Set(selection));
  const selecting = $derived(selection.length > 0 || (selectionMode && !singleSelect));

  const tileLayout = $derived<TileLayout>(layout ?? session.layout);
  const cells = $derived(
    tileLayout === 'timeline'
      ? null
      : cellGridOptions(tileLayout, libraryGridPreferences.thumbnailSize, libraryGridPreferences.phone),
  );
  const grid = $derived(cells ? cellGrid(assets.length, width, cells) : null);

  /**
   * Where the rows sit in their scroller and how tall its frame is, measured when either resizes;
   * the scroll offset alone is read while scrolling, so scrolling never forces a layout.
   */
  let scrollTop = $state(0);
  let rowsOffset = $state(0);
  let frameHeight = $state(Infinity);
  /** The viewport, in the grid's own coordinates; the whole grid until it has been measured. */
  const viewTop = $derived(frameHeight === Infinity ? 0 : scrollTop - rowsOffset);
  const viewBottom = $derived(frameHeight === Infinity ? Infinity : viewTop + frameHeight);

  const scrollParentOf = (element: HTMLElement): HTMLElement | null => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        return node;
      }
    }
    return null;
  };

  $effect(() => {
    const element = rowsElement;
    if (!element || !grid) {
      return;
    }
    const scroller = scrollParentOf(element);
    const frame = scroller ?? document.documentElement;
    const readScroll = () => {
      scrollTop = scroller ? scroller.scrollTop : scrollY;
    };
    const measure = () => {
      readScroll();
      const frameTop = scroller ? scroller.getBoundingClientRect().top : 0;
      rowsOffset = element.getBoundingClientRect().top - frameTop + scrollTop;
      // Nothing measurable (a hidden page, or a test DOM): mount everything rather than nothing.
      frameHeight = frame.clientHeight > 0 ? frame.clientHeight : Infinity;
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(frame);
    observer?.observe(element);
    const target: HTMLElement | typeof globalThis = scroller ?? globalThis;
    target.addEventListener('scroll', readScroll, { passive: true });
    return () => {
      observer?.disconnect();
      target.removeEventListener('scroll', readScroll);
    };
  });

  /** The cells to mount: the rows in or near the viewport, never the whole result list. */
  const mounted = $derived.by(() => {
    if (!grid) {
      return assets.map((asset, index) => ({ asset, index }));
    }
    const { start, end } = grid.range(viewTop, viewBottom, OVERSCAN_ROWS);
    return assets.slice(start, end).map((asset, offset) => ({ asset, index: start + offset }));
  });

  const geometry = $derived(
    getJustifiedLayoutFromAssets(grid ? [] : assets, {
      spacing: maxMd ? 8 : 12,
      heightTolerance: 0.5,
      rowHeight: maxMd ? 100 : 235,
      rowWidth: Math.floor(width),
      fillRowWidth: true,
    }),
  );

  /**
   * The end of the list asks for the next page. An observer rather than a scroll handler, so a
   * short result set that already ends inside the viewport still pages without a scroll event.
   */
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

  /** Every id in visible order: what a shift-click range is taken against. */
  const orderedIds = $derived(assets.map((asset) => asset.id));

  const pick = (asset: TimelineAsset) => {
    if (singleSelect) {
      session.dispatch({ type: 'selection', ids: [asset.id] });
    } else {
      session.select(asset.id);
    }
    session.setScrollAnchor(asset.id);
    onSelect?.(asset);
  };

  const toggleSelect = (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => {
    if (!singleSelect && 'shiftKey' in event && event.shiftKey) {
      // The whole result set is loaded here, so the range is taken from the list itself.
      session.select(asset.id, { range: true, orderedIds });
      return;
    }
    if (singleSelect) {
      pick(asset);
      return;
    }
    session.select(asset.id);
  };

  const handleOpen = (asset: TimelineAsset) => {
    if (selectionMode || !onOpen) {
      pick(asset);
      return;
    }
    session.setScrollAnchor(asset.id);
    onOpen(asset);
  };
</script>

<div class="fl-grid" data-testid="frameleaf-asset-grid" data-layout={tileLayout} bind:clientWidth={width}>
  {@render header?.()}

  {#if assets.length === 0}
    {@render empty?.()}
  {:else if width > 0}
    <!-- The justified layout needs a measured container; the first frame only measures. -->
    <div class="fl-grid-rows" bind:this={rowsElement} style:height="{grid ? grid.height : geometry.containerHeight}px">
      {#each mounted as { asset, index } (asset.id)}
        {@const position = grid ? grid.position(index) : geometry.getPosition(index)}
        <div
          class="fl-grid-cell"
          style:top="{position.top}px"
          style:inset-inline-start="{position.left}px"
          style:width="{position.width}px"
          style:height="{position.height}px"
        >
          <AssetTile
            {asset}
            width={position.width}
            height={position.height}
            selected={selected.has(asset.id)}
            {selecting}
            layout={tileLayout}
            rating={ratingFor?.(asset)}
            captionHeight={cells?.captionHeight ?? 0}
            showFileName={libraryGridPreferences.showFileNames}
            onOpen={handleOpen}
            onToggleSelect={toggleSelect}
            onFocus={(focused) => session.setScrollAnchor(focused.id)}
            overlay={tileOverlay}
          />
        </div>
      {/each}
    </div>
    <div class="fl-grid-end" bind:this={sentinel} aria-hidden="true"></div>
  {/if}
</div>

<style>
  .fl-grid {
    position: relative;
    width: 100%;
  }
  .fl-grid-rows {
    position: relative;
    overflow: clip;
  }
  .fl-grid-cell {
    position: absolute;
  }
  .fl-grid-end {
    height: 1px;
  }
</style>
