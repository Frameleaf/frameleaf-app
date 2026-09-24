<script lang="ts">
  /**
   * One day group inside a month bucket: a sticky header with a select-all checkbox, and the
   * justified rows beneath it.
   *
   * Ported for FL-33 from the group markup in `design/frameleaf/template/src/TimelineLibrary.jsx`.
   * Only the assets the timeline manager has marked active for this day are rendered — the day is
   * virtualized inside a bucket that is itself only mounted while it is in or near the viewport.
   */
  import AssetTile from '$lib/components/frameleaf/AssetTile.svelte';
  import LibraryGroupHeader from '$lib/components/frameleaf/LibraryGroupHeader.svelte';
  import type { TileLayout } from '$lib/frameleaf/library-grid';
  import { groupSelectionState } from '$lib/frameleaf/library-session';
  import type { TimelineDay } from '$lib/managers/timeline-manager/timeline-day.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { fromTimelinePlainDate } from '$lib/utils/timeline-util';
  import type { Snippet } from 'svelte';
  import { locale } from 'svelte-i18n';

  type Props = {
    timelineDay: TimelineDay;
    selection: string[];
    selecting: boolean;
    /** Browse hides the day header; Timeline and Work keep it sticky above the rows. */
    showHeader?: boolean;
    /** The space the timeline manager reserves above the rows; the header fills exactly this. */
    headerHeight?: number;
    /**
     * Month, year or "all" grouping: the day's tiles are part of its month's single flow, drawn
     * under the month's group header, so the day draws no header and names no region of its own.
     */
    grouped?: boolean;
    /** The layout the tiles are drawn in (FL-33 tile variants). */
    layout?: TileLayout;
    /** Work: the caption row under each tile, included in the tile height. */
    captionHeight?: number;
    /** Work: show file names in the captions. */
    showFileNames?: boolean;
    /** Rating override for an asset; by default each tile shows the asset's own rating. */
    ratingFor?: (asset: TimelineAsset) => number | null;
    onOpen?: (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => void;
    onToggleSelect?: (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => void;
    onSelectGroup?: (ids: string[], checked: boolean) => void;
    onFocusAsset?: (asset: TimelineAsset) => void;
    /** Extra chrome drawn over every tile by the page that mounts the timeline. */
    tileOverlay?: Snippet<[TimelineAsset]>;
  };

  let {
    timelineDay,
    selection,
    selecting,
    showHeader = true,
    headerHeight = 48,
    grouped = false,
    layout = 'timeline',
    captionHeight = 0,
    showFileNames = false,
    ratingFor,
    onOpen,
    onToggleSelect,
    onSelectGroup,
    onFocusAsset,
    tileOverlay,
  }: Props = $props();

  const dayIds = $derived(timelineDay.viewerAssets.map((viewerAsset) => viewerAsset.id));
  const state = $derived(groupSelectionState(dayIds, selection));
  const selected = $derived(new Set(selection));
  const headingId = $derived(
    `fl-day-${timelineDay.timelineMonth.yearMonth.year}-${timelineDay.timelineMonth.yearMonth.month}-${timelineDay.day}`,
  );
  /**
   * The day's title as the prototype writes it (`explore-timeline.mjs` `timelineGroups`): the full
   * date, e.g. "Wednesday, December 11, 2024". Only this header uses it; the manager's shorter
   * `groupTitle` stays as it is for everything else.
   */
  const dayTitle = $derived(
    fromTimelinePlainDate({
      year: timelineDay.timelineMonth.yearMonth.year,
      month: timelineDay.timelineMonth.yearMonth.month,
      day: timelineDay.day,
    }).toLocaleString(
      { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' },
      { locale: $locale ?? undefined },
    ),
  );
</script>

<section
  class="fl-day"
  class:is-selecting={selecting}
  class:is-grouped={grouped}
  data-group
  data-testid="frameleaf-day-group"
  aria-labelledby={showHeader && !grouped ? headingId : undefined}
  aria-label={showHeader || grouped ? undefined : dayTitle}
  style:position="absolute"
  style:inset-inline-start="{timelineDay.start}px"
  style:top="{timelineDay.top}px"
>
  {#if showHeader && !grouped}
    <LibraryGroupHeader
      id={headingId}
      title={dayTitle}
      count={dayIds.length}
      {state}
      {selecting}
      width={timelineDay.width}
      height={headerHeight}
      onSelect={(checked) => onSelectGroup?.(dayIds, checked)}
    />
  {:else}
    <div style:height="{headerHeight}px" aria-hidden="true"></div>
  {/if}

  <div class="fl-day-rows" style:width="{timelineDay.width}px" style:height="{timelineDay.height}px">
    {#each timelineDay.activeViewerAssets as viewerAsset (viewerAsset.id)}
      {@const position = viewerAsset.position}
      {@const asset = viewerAsset.asset}
      {#if position && asset}
        <div
          class="fl-day-cell"
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
            {layout}
            rating={ratingFor?.(asset)}
            {captionHeight}
            showFileName={showFileNames}
            {onOpen}
            {onToggleSelect}
            onFocus={onFocusAsset}
            overlay={tileOverlay}
          />
        </div>
      {/if}
    {/each}
  </div>
</section>

<style>
  .fl-day {
    contain: layout paint style;
  }
  .fl-day-rows {
    position: relative;
    overflow: clip;
  }
  .fl-day-cell {
    position: absolute;
  }
  /* The days of a grouped month overlap: only their tiles take the pointer. */
  .fl-day.is-grouped {
    pointer-events: none;
  }
  .fl-day.is-grouped .fl-day-cell {
    pointer-events: auto;
  }
</style>
