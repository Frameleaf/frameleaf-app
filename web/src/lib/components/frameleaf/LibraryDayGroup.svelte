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
  import { groupSelectionState } from '$lib/frameleaf/library-session';
  import type { TimelineDay } from '$lib/managers/timeline-manager/timeline-day.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { fromTimelinePlainDate, getDateLocaleString } from '$lib/utils/timeline-util';
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiMinus } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    timelineDay: TimelineDay;
    selection: string[];
    selecting: boolean;
    /** Browse hides the day header; Timeline and Work keep it sticky above the rows. */
    showHeader?: boolean;
    /** Work shows the capture time under each tile. */
    captionFor?: (asset: TimelineAsset) => string | null;
    /** Rating for an asset, supplied by the host; the timeline model does not carry one. */
    ratingFor?: (asset: TimelineAsset) => number | null;
    onOpen?: (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => void;
    onToggleSelect?: (asset: TimelineAsset, event: MouseEvent | KeyboardEvent) => void;
    onSelectGroup?: (ids: string[], checked: boolean) => void;
    onFocusAsset?: (asset: TimelineAsset) => void;
  };

  let {
    timelineDay,
    selection,
    selecting,
    showHeader = true,
    captionFor,
    ratingFor,
    onOpen,
    onToggleSelect,
    onSelectGroup,
    onFocusAsset,
  }: Props = $props();

  const dayIds = $derived(timelineDay.viewerAssets.map((viewerAsset) => viewerAsset.id));
  const state = $derived(groupSelectionState(dayIds, selection));
  const selected = $derived(new Set(selection));
  const headingId = $derived(`fl-day-${timelineDay.timelineMonth.yearMonth.year}-${timelineDay.timelineMonth.yearMonth.month}-${timelineDay.day}`);
  const fullDate = $derived(
    getDateLocaleString(
      fromTimelinePlainDate({
        year: timelineDay.timelineMonth.yearMonth.year,
        month: timelineDay.timelineMonth.yearMonth.month,
        day: timelineDay.day,
      }),
    ),
  );
</script>

<section
  class="fl-day"
  class:is-selecting={selecting}
  data-group
  data-testid="frameleaf-day-group"
  aria-labelledby={showHeader ? headingId : undefined}
  aria-label={showHeader ? undefined : timelineDay.groupTitle}
  style:position="absolute"
  style:inset-inline-start="{timelineDay.start}px"
  style:top="{timelineDay.top}px"
>
  {#if showHeader}
  <header class="fl-day-header" style:width="{timelineDay.width}px">
    <label class="fl-day-select" class:is-active={state !== 'none'}>
      <input
        type="checkbox"
        checked={state === 'all'}
        indeterminate={state === 'some'}
        aria-label={$t('frameleaf_library_select_all_in_group', { values: { title: timelineDay.groupTitle } })}
        onchange={(event) => onSelectGroup?.(dayIds, event.currentTarget.checked)}
      />
      <span aria-hidden="true">
        {#if state === 'all'}
          <Icon icon={mdiCheck} size="13" />
        {:else if state === 'some'}
          <Icon icon={mdiMinus} size="13" />
        {/if}
      </span>
    </label>
    <h2 id={headingId} title={fullDate}>{timelineDay.groupTitle}</h2>
    <span class="fl-day-count">{$t('items_count', { values: { count: dayIds.length } })}</span>
  </header>
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
            rating={ratingFor?.(asset) ?? null}
            caption={captionFor?.(asset) ?? null}
            {onOpen}
            {onToggleSelect}
            onFocus={onFocusAsset}
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
  .fl-day-header {
    position: sticky;
    top: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 6px;
    padding: 10px 0 8px;
    background: linear-gradient(var(--fl-canvas) 78%, transparent);
  }
  .fl-day-header h2 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fl-font-size, 14px);
    font-weight: 600;
    line-height: 1.4;
  }
  .fl-day-count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
    white-space: nowrap;
  }
  .fl-day-select {
    position: relative;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-inline-start: -6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--fl-motion-fast, 120ms) ease;
  }
  .fl-day:hover .fl-day-select,
  .fl-day-select:focus-within,
  .fl-day-select.is-active,
  .fl-day.is-selecting .fl-day-select {
    opacity: 1;
  }
  .fl-day-select input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .fl-day-select > span {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--fl-muted);
    border-radius: 50%;
    color: var(--fl-accent-text);
  }
  .fl-day-select.is-active > span {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .fl-day-rows {
    position: relative;
    overflow: clip;
  }
  .fl-day-cell {
    position: absolute;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-day-select {
      transition: none;
    }
  }
</style>
