<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  import type { CalendarHeatmapResponseDto } from '@frameleaf/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    data: CalendarHeatmapResponseDto;
    itemLabel: (item: { date: string; count: number }) => string;
    totalLabel: (count: number) => string;
  };

  const { data, itemLabel, totalLabel }: Props = $props();

  /**
   * A year of days as the prototype draws it (settings-v2 `Heat`, server.css `.srv-heat`): one
   * column per week, square cells, the month names underneath. The grid fits its container: the
   * cells shrink with the width (no sideways scrolling on a phone) and never grow past the
   * prototype's 11px squares on a 3px gap.
   */
  const startDate = $derived(DateTime.fromISO(data.from, { zone: 'utc' }));
  const padding = $derived(startDate.diff(startDate.startOf('week', { useLocaleWeeks: true })).as('days'));
  const weeks = $derived(Math.max(1, Math.ceil((padding + data.series.length) / 7)));

  /** Month names under the week where each month starts; a sliver of a month at the start gets none. */
  const months = $derived.by(() => {
    const starts: Array<{ column: number; label: string }> = [];
    for (const [index, day] of data.series.entries()) {
      const date = DateTime.fromISO(day.date, { zone: 'utc' });
      if (index === 0 || date.day === 1) {
        starts.push({
          column: Math.floor((padding + index) / 7),
          label: date.toLocaleString({ month: 'short' }, { locale: $locale }),
        });
      }
    }
    const shown = starts.filter(({ column }, index) => {
      const next = starts[index + 1];
      return index > 0 || !next || next.column - column >= 3;
    });
    // Each name runs to the next one; the last runs to the end and sits against it, so a month
    // that starts in the final weeks never pokes past the grid.
    return shown.map((month, index) => {
      const next = shown.at(index + 1);
      return { ...month, end: next ? next.column + 1 : -1, last: index === shown.length - 1 };
    });
  });

  const maxCount = $derived.by(() => {
    let max = 0;
    for (const item of data.series) {
      max = Math.max(max, item.count);
    }
    return max;
  });
  const thresholds = $derived([Math.ceil(maxCount * 0.25), Math.ceil(maxCount * 0.5), Math.ceil(maxCount * 0.75)]);

  const itemColors = (count: number) => {
    if (count === 0 || maxCount === 0) {
      return 'bg-gray-200 dark:bg-gray-700';
    }

    if (count <= thresholds[0]) {
      return 'bg-immich-primary/30';
    }

    if (count <= thresholds[1]) {
      return 'bg-immich-primary/50';
    }

    if (count <= thresholds[2]) {
      return 'bg-immich-primary/70';
    }

    return 'bg-immich-primary';
  };
</script>

<div class="heatmap mt-4 w-full" style:--weeks={weeks}>
  <div class="heat">
    {#each data.series as day, idx (day.date)}
      {@const date = DateTime.fromISO(day.date, { zone: 'utc' }).toLocaleString(
        { month: 'short', day: 'numeric' },
        { locale: $locale },
      )}
      {@const label = itemLabel({ date, count: day.count })}
      <div
        class="cell {itemColors(day.count)}"
        style:grid-row-start={idx === 0 ? padding + 1 : undefined}
        title={label}
        aria-label={label}
      ></div>
    {/each}
  </div>
  <div class="months" aria-hidden="true">
    {#each months as month (month.column)}
      <span class:last={month.last} style:grid-column-start={month.column + 1} style:grid-column-end={month.end}
        >{month.label}</span
      >
    {/each}
  </div>

  <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
    <span>{$t('less')}</span>
    <span class="size-3 rounded-sm bg-gray-200 dark:bg-gray-700"></span>
    <span class="size-3 rounded-sm bg-immich-primary/30"></span>
    <span class="size-3 rounded-sm bg-immich-primary/50"></span>
    <span class="size-3 rounded-sm bg-immich-primary/70"></span>
    <span class="size-3 rounded-sm bg-immich-primary"></span>
    <span>{$t('more')}</span>
    <span class="ms-4">{totalLabel(data.totalCount)}</span>
  </div>
</div>

<style>
  .heatmap {
    container-type: inline-size;
    min-width: 0;
  }
  .heat,
  .months {
    display: grid;
    grid-template-columns: repeat(var(--weeks), minmax(0, 1fr));
    /* 3px between cells, less on a narrow card so the squares keep most of the width. */
    column-gap: min(3px, 0.5cqi);
    /* Never wider than the prototype's 11px squares on a 3px gap. */
    max-inline-size: calc(var(--weeks) * 14px - 3px);
  }
  .heat {
    grid-template-rows: repeat(7, auto);
    grid-auto-flow: column;
    row-gap: min(3px, 0.5cqi);
  }
  .cell {
    aspect-ratio: 1;
    border-radius: 25%;
  }
  .months {
    margin-top: var(--fl-space-2, 8px);
    color: var(--fl-muted);
    font-size: 11px;
    line-height: 1.2;
  }
  .months span {
    grid-row: 1;
    white-space: nowrap;
  }
  .months span.last {
    justify-self: end;
  }
</style>
