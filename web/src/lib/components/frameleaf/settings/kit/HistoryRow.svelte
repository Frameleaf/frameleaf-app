<script lang="ts">
  /**
   * One line of a HistoryList: when, what, a detail, and how it ended (a Pill, or a button or two)
   * as `children`. Leave `what` out for a list of dates.
   */
  import type { Snippet } from 'svelte';

  let {
    when,
    datetime,
    what,
    detail,
    middle,
    children,
  }: {
    /** The time as the page says it: "Today, 2:29 AM". */
    when: string;
    /** The same moment for machines (ISO), when it is known. */
    datetime?: string;
    what?: string;
    detail?: string;
    /** Something richer than a line of detail, such as a row of chips. */
    middle?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<li class="kit-history-row" class:is-point={what === undefined}>
  <time {datetime}>{when}</time>
  {#if what !== undefined}<strong>{what}</strong>{/if}
  <span class="detail">
    {#if middle}{@render middle()}{:else}{detail ?? ''}{/if}
  </span>
  <span class="end">{@render children?.()}</span>
</li>

<style>
  .kit-history-row {
    display: grid;
    grid-template-columns: 170px 150px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 52px;
    padding: var(--fl-space-2) 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-callout);
  }
  .kit-history-row.is-point {
    grid-template-columns: 170px minmax(0, 1fr) auto;
  }
  time,
  .detail {
    min-width: 0;
    color: var(--fl-muted);
  }
  strong {
    font-weight: 600;
  }
  .end {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  @container kit (max-width: 620px) {
    .kit-history-row,
    .kit-history-row.is-point {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--fl-space-1) var(--fl-space-3);
      padding: var(--fl-space-3) 0;
    }
    time {
      grid-column: 1 / -1;
      font-size: var(--fl-font-small);
    }
    .detail {
      grid-column: 1 / -1;
    }
    .detail:empty {
      display: none;
    }
    .kit-history-row.is-point .end {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
</style>
