<script lang="ts">
  /**
   * The draggable year and month scrubber beside the library timeline.
   *
   * Ported for FL-33 from `TimelineScrubber` in `design/frameleaf/template/src/TimelineLibrary.jsx`.
   * The prototype positions months by how many items they hold, because it has the whole library in
   * memory. Production does not: months are positioned by their measured scroll height, taken from
   * the timeline manager's own `scrubberMonths`, so the marker tracks the real scroll position and
   * a month that has not been loaded yet still occupies its estimated share of the track.
   *
   * It speaks the same `ScrubberListener` contract as the upstream scrubber, so the host keeps one
   * scroll implementation for both.
   */
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import type { ScrubberMonth, ViewportTopMonth } from '$lib/managers/timeline-manager/types';
  import type { ScrubberListener } from '$lib/utils/timeline-util';
  import { t } from 'svelte-i18n';

  type Props = {
    timelineManager: TimelineManager;
    /** Track height in pixels. */
    height?: number;
    viewportTopMonth?: ViewportTopMonth;
    viewportTopMonthScrollPercent?: number;
    timelineScrollPercent?: number;
    onScrub?: ScrubberListener;
    /**
     * Jump to the start of a month, for the keyboard (prototype `TimelineScrubber` keyDown →
     * `jumpTo`). Without it the keys scrub to the month's place on the track.
     */
    onJump?: (month: { year: number; month: number }) => void;
    scrubberWidth?: number;
    /** Whether the track is being dragged; bound by the timeline to hold back thumbnails meanwhile. */
    dragging?: boolean;
  };

  let {
    timelineManager,
    height = 0,
    viewportTopMonth = undefined,
    viewportTopMonthScrollPercent = 0,
    timelineScrollPercent = 0,
    onScrub,
    onJump,
    scrubberWidth = $bindable(),
    dragging = $bindable(false),
  }: Props = $props();

  const MIN_YEAR_LABEL_GAP = 18;

  let track = $state<HTMLElement>();
  let hover = $state<{ fraction: number; month: Marked } | null>(null);

  type Marked = ScrubberMonth & { start: number; end: number; center: number; key: string };

  const total = $derived(Math.max(1, timelineManager.scrubberTimelineHeight));
  const leadIn = $derived(timelineManager.topSectionHeight / total);

  /** Months laid along a 0..1 track in proportion to the scroll distance they occupy. */
  const months = $derived.by(() => {
    let offset = timelineManager.topSectionHeight;
    return timelineManager.scrubberMonths.map((month) => {
      const start = offset / total;
      offset += month.height;
      const end = offset / total;
      return { ...month, start, end, center: (start + end) / 2, key: `${month.year}-${month.month}` };
    });
  });

  /** One entry per year, spanning its months, for the labelled ticks. */
  const years = $derived.by(() => {
    const result: { year: number; start: number; end: number; assetCount: number }[] = [];
    for (const month of months) {
      const last = result.at(-1);
      if (!last || last.year !== month.year) {
        result.push({ year: month.year, start: month.start, end: month.end, assetCount: month.assetCount });
        continue;
      }
      last.end = month.end;
      last.assetCount += month.assetCount;
    }
    return result;
  });

  const maxCount = $derived(Math.max(1, ...months.map((month) => month.assetCount)));

  const currentKey = $derived(
    viewportTopMonth && typeof viewportTopMonth === 'object'
      ? `${viewportTopMonth.year}-${viewportTopMonth.month}`
      : null,
  );
  const currentIndex = $derived(
    Math.max(
      0,
      months.findIndex((month) => month.key === currentKey),
    ),
  );
  const current = $derived(months[currentIndex]);
  /** Where the marker sits: inside the current month, or the overall position when there is none. */
  const markerFraction = $derived.by(() => {
    if (!current) {
      return leadIn + timelineScrollPercent * (1 - leadIn);
    }
    return current.start + (current.end - current.start) * Math.min(1, Math.max(0, viewportTopMonthScrollPercent));
  });

  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

  const monthAt = (fraction: number): Marked | null => {
    if (months.length === 0) {
      return null;
    }
    const value = clamp01(fraction);
    // Above the first month is the lead-in (the page header): that is still the newest month, not
    // the fallback to the last one.
    if (value < months[0].start) {
      return months[0];
    }
    return months.find((month) => value >= month.start && value < month.end) ?? (months.at(-1) as Marked);
  };

  const fractionAt = (clientY: number) => {
    const rect = track?.getBoundingClientRect();
    return rect && rect.height ? clamp01((clientY - rect.top) / rect.height) : 0;
  };

  /** Report a track position to the host, which owns the one scroll implementation. */
  const scrubTo = (month: Marked | null, fraction: number) => {
    if (!month) {
      void onScrub?.({ scrubberMonth: undefined, overallScrollPercent: fraction, scrubberMonthScrollPercent: 0 });
      return;
    }
    const span = month.end - month.start;
    void onScrub?.({
      scrubberMonth: { year: month.year, month: month.month },
      overallScrollPercent: fraction,
      scrubberMonthScrollPercent: span > 0 ? clamp01((fraction - month.start) / span) : 0,
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    track?.setPointerCapture?.(event.pointerId);
    dragging = true;
    const fraction = fractionAt(event.clientY);
    const month = monthAt(fraction);
    hover = month ? { fraction, month } : null;
    scrubTo(month, fraction);
  };

  const onPointerMove = (event: PointerEvent) => {
    const fraction = fractionAt(event.clientY);
    const month = monthAt(fraction);
    hover = month ? { fraction, month } : null;
    if (dragging) {
      scrubTo(month, fraction);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    track?.releasePointerCapture?.(event.pointerId);
    if (event.pointerType === 'touch') {
      hover = null;
    }
  };

  const onPointerLeave = () => {
    if (!dragging) {
      hover = null;
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -3, PageDown: 3 }[event.key];
    let next: number | null = null;
    if (step !== undefined) {
      next = Math.min(months.length - 1, Math.max(0, currentIndex + step));
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = months.length - 1;
    }
    const month = next === null ? undefined : months[next];
    if (!month) {
      return;
    }
    event.preventDefault();
    if (onJump) {
      onJump({ year: month.year, month: month.month });
      return;
    }
    scrubTo(month, month.start);
  };

  const bubble = $derived(hover?.month ?? (dragging ? current : null));
  const bubbleFraction = $derived(hover ? hover.fraction : (current?.center ?? 0));
</script>

<div
  class="fl-scrubber"
  bind:clientWidth={scrubberWidth}
  style:height={height ? `${height}px` : undefined}
  data-testid="frameleaf-year-scrubber"
>
  <div
    bind:this={track}
    class="fl-scrub-track"
    class:is-dragging={dragging}
    role="slider"
    tabindex="0"
    aria-label={$t('frameleaf_library_jump_to_month')}
    aria-orientation="vertical"
    aria-valuemin={0}
    aria-valuemax={Math.max(0, months.length - 1)}
    aria-valuenow={currentIndex}
    aria-valuetext={current ? `${current.title}, ${$t('items_count', { values: { count: current.assetCount } })}` : ''}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerUp}
    onpointerleave={onPointerLeave}
    onkeydown={onKeyDown}
  >
    {#each years as year (year.year)}
      <i class="fl-scrub-yeartick" style:top="{year.start * 100}%" aria-hidden="true"></i>
      {#if (year.end - year.start) * height >= MIN_YEAR_LABEL_GAP}
        <span class="fl-scrub-year" style:top="{year.start * 100}%" aria-hidden="true">{year.year}</span>
      {/if}
    {/each}
    {#each months as month (month.key)}
      <i
        class="fl-scrub-tick"
        class:is-current={month.key === currentKey}
        data-year-month={month.key}
        style:top="{month.center * 100}%"
        style:width="{4 + Math.round((month.assetCount / maxCount) * 8)}px"
        aria-hidden="true"
      ></i>
    {/each}
    <span class="fl-scrub-marker" style:top="{markerFraction * 100}%" aria-hidden="true"></span>
    {#if bubble}
      <div class="fl-scrub-bubble" style:top="{bubbleFraction * 100}%" aria-hidden="true">
        {bubble.title}
        <small>{$t('items_count', { values: { count: bubble.assetCount } })}</small>
      </div>
    {/if}
  </div>
</div>

<style>
  .fl-scrubber {
    position: relative;
    width: 34px;
    flex: 0 0 auto;
    /* The track starts below the frosted results toolbar (apple-style.css `.tl-scrubber` top). */
    padding: calc(var(--fl-sticky-offset, 0px) + 8px) 0 8px;
    touch-action: none;
  }
  .fl-scrub-track {
    position: relative;
    height: 100%;
    width: 100%;
    cursor: ns-resize;
  }
  .fl-scrub-yeartick {
    position: absolute;
    inset-inline-end: 4px;
    width: 14px;
    height: 1px;
    background: var(--fl-border);
  }
  .fl-scrub-year {
    position: absolute;
    inset-inline-end: 20px;
    transform: translateY(-50%);
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
    font-variant-numeric: tabular-nums;
  }
  .fl-scrub-tick {
    position: absolute;
    inset-inline-end: 6px;
    height: 2px;
    border-radius: 1px;
    background: var(--fl-border);
    transform: translateY(-50%);
  }
  .fl-scrub-tick.is-current {
    background: var(--fl-accent);
  }
  .fl-scrub-marker {
    position: absolute;
    inset-inline-end: 2px;
    width: 18px;
    height: 3px;
    border-radius: 2px;
    background: var(--fl-accent);
    transform: translateY(-50%);
  }
  .fl-scrub-bubble {
    position: absolute;
    inset-inline-end: 28px;
    transform: translateY(-50%);
    display: grid;
    padding: 4px 8px;
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    white-space: nowrap;
    font-size: var(--fl-font-small, 12px);
  }
  .fl-scrub-bubble small {
    color: var(--fl-muted);
  }
</style>
