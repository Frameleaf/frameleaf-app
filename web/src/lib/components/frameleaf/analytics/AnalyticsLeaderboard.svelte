<script lang="ts">
  /**
   * A ranked list with bars (FL-79), the template's `Leaderboard` (AnalyticsDashboard.jsx:141-175).
   * Catch-all rows ("Everywhere else", "Not recorded") sit last and unranked, and never set the bar
   * scale, so they never outshine the real leaders.
   */
  import { rankRows, type BreakdownRow } from '$lib/frameleaf/analytics';
  import type { Snippet } from 'svelte';

  type Props = {
    rows: BreakdownRow[];
    label: string;
    format: (value: number) => string;
    lead?: Snippet<[BreakdownRow]>;
  };
  let { rows, label, format, lead }: Props = $props();

  const board = $derived(rankRows(rows));
</script>

<ol class="an-board" aria-label={label}>
  {#each board.rows as row, index (row.id)}
    <li class:rest={row.catchAll}>
      {#if lead && !row.catchAll}
        {@render lead(row)}
      {:else if row.catchAll}
        <span class="rank muted" aria-hidden="true">·</span>
      {:else}
        <span class="rank" class:first={index === 0}>{index + 1}</span>
      {/if}
      <span class="name">{row.label}</span>
      <span class="bar" aria-hidden="true">
        <span style:width="{Math.min(100, (row.count / board.scale) * 100)}%"></span>
      </span>
      <strong>{format(row.count)}</strong>
    </li>
  {/each}
</ol>

<style>
  .an-board {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 32px minmax(90px, 0.9fr) minmax(60px, 1.4fr) 72px;
    align-items: center;
    gap: 12px;
    font-size: 13px;
  }
  .rank {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: 9px;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .rank.first {
    color: var(--fl-text);
    background: color-mix(in srgb, var(--an-1) 22%, transparent);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar {
    height: 8px;
    overflow: hidden;
    background: var(--an-cell);
    border-radius: 999px;
  }
  .bar > span {
    display: block;
    height: 100%;
    background: var(--an-1);
    border-radius: inherit;
  }
  .rest {
    color: var(--fl-muted);
  }
  .rest .bar > span {
    background: var(--an-4);
  }
  strong {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    text-align: right;
  }
  @container (max-width: 520px) {
    li {
      grid-template-columns: 32px minmax(0, 1fr) 64px;
    }
    .bar {
      display: none;
    }
  }
</style>
