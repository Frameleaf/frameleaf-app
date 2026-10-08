<script lang="ts">
  /**
   * One bar split into labelled shares (FL-79), the template's `StackBar`
   * (AnalyticsDashboard.jsx:177-195). A label is drawn only where its share is wide enough; every
   * share is in the tooltip and in the data table below the panel.
   */
  import type { BreakdownRow } from '$lib/frameleaf/analytics';

  type Props = { rows: BreakdownRow[]; label: string; format: (value: number) => string; colors: string[] };
  let { rows, label, format, colors }: Props = $props();

  const whole = $derived(rows.reduce((sum, row) => sum + row.count, 0));
  const share = (count: number) => (whole ? (count / whole) * 100 : 0);
  /** FL-139: a series colour's own label ink (`var(--an-N)` → `var(--an-N-ink)`), for AA contrast. */
  const ink = (color: string) => (/^var\(--an-\d\)$/.test(color) ? color.replace(')', '-ink)') : '#0b1210');
</script>

<div class="an-stack" role="img" aria-label={label}>
  {#each rows as row, index (row.id)}
    {#if row.count > 0}
      <span
        style:flex={row.count}
        style:background={row.catchAll ? 'var(--an-4)' : colors[index % colors.length]}
        style:color={ink(row.catchAll ? 'var(--an-4)' : colors[index % colors.length])}
        title="{row.label}: {format(row.count)} ({share(row.count).toFixed(1)}%)"
      >
        {share(row.count) > 8 ? row.label : ''}
      </span>
    {/if}
  {/each}
</div>

<style>
  .an-stack {
    display: flex;
    gap: 2px;
    height: 30px;
    overflow: hidden;
    background: var(--an-cell);
    border-radius: var(--fl-radius-control-compact);
  }
  span {
    display: grid;
    place-items: center;
    min-width: 0;
    overflow: hidden;
    font-size: 11px;
    font-weight: 650;
    white-space: nowrap;
  }
</style>
