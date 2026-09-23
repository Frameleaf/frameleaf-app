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
   * It replaces the legacy shared gallery grid. Like it, it lays out with
   * `getJustifiedLayoutFromAssets` and asks the page for the next page when the end comes into
   * view; unlike it, it owns no viewer, no keyboard map and no actions — the page mounts the
   * viewer and the session carries the selection.
   */
  import AssetTile from '$lib/components/frameleaf/AssetTile.svelte';
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
    ratingFor?: (asset: TimelineAsset) => number | null;
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
    tileOverlay,
    header,
    empty,
  }: Props = $props();

  let width = $state(0);
  let sentinel = $state<HTMLElement>();

  const maxMd = $derived(mediaQueryManager.maxMd);
  const selection = $derived(session.selection);
  const selected = $derived(new Set(selection));
  const selecting = $derived(selection.length > 0 || (selectionMode && !singleSelect));

  const geometry = $derived(
    getJustifiedLayoutFromAssets(assets, {
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

<div class="fl-grid" data-testid="frameleaf-asset-grid" bind:clientWidth={width}>
  {@render header?.()}

  {#if assets.length === 0}
    {@render empty?.()}
  {:else if width > 0}
    <!-- The justified layout needs a measured container; the first frame only measures. -->
    <div class="fl-grid-rows" style:height="{geometry.containerHeight}px">
      {#each assets as asset, index (asset.id)}
        {@const position = geometry.getPosition(index)}
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
            rating={ratingFor?.(asset) ?? null}
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
