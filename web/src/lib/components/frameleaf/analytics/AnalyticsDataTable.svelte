<script lang="ts">
  /**
   * "View data table" under every analytics chart (FL-79): the exact plotted values, built from the
   * same rows as the chart and the CSV export (`analyticsTables`). A gap reads "Not observed".
   */
  import type { AnalyticsTable } from '$lib/frameleaf/analytics';
  import { locale } from '$lib/stores/preferences.store';
  import { t } from 'svelte-i18n';

  type Props = { table: AnalyticsTable; open?: boolean; caption?: string; summary?: string };
  let { table, open = false, caption, summary }: Props = $props();

  const format = (value: number, unit: string) =>
    new Intl.NumberFormat(
      $locale,
      unit === 'USD' ? { style: 'currency', currency: 'USD', maximumFractionDigits: 4 } : { maximumFractionDigits: 2 },
    ).format(value);
</script>

<details class="data-table" {open} data-table-id={table.id}>
  <!-- The accessible name starts with the visible text (WCAG 2.5.3, label in name). -->
  <summary
    aria-label={summary
      ? $t('frameleaf_analytics_summary_for', { values: { summary, title: table.title } })
      : $t('frameleaf_analytics_view_table_for', { values: { title: table.title } })}
  >
    {summary ?? $t('frameleaf_analytics_view_table')}
  </summary>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="scroll"
    tabindex="0"
    role="region"
    aria-label={$t('frameleaf_analytics_table_region', { values: { title: table.title } })}
  >
    <table>
      <caption
        >{caption ??
          table.caption ??
          $t('frameleaf_analytics_table_caption', { values: { title: table.title } })}</caption
      >
      <thead>
        <tr>
          {#each table.columns as column (column.label)}
            <th scope="col">{column.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each table.rows as row, r (r)}
          <tr>
            {#each row as cell, c (c)}
              {#if c === 0}
                <th scope="row">{typeof cell === 'number' ? format(cell, table.columns[c].unit) : cell}</th>
              {:else if cell === null}
                <td class="gap">{$t('frameleaf_analytics_not_observed')}</td>
              {:else}
                <td>{typeof cell === 'number' ? format(cell, table.columns[c].unit) : cell}</td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</details>

<style>
  .data-table {
    padding-top: 10px;
    border-top: 1px solid var(--fl-border);
  }
  summary {
    width: fit-content;
    min-height: 28px;
    padding: 6px 0;
    color: var(--fl-muted);
    font-size: 11px;
    cursor: pointer;
  }
  summary:hover {
    color: var(--fl-text);
  }
  .scroll {
    max-width: 100%;
    max-height: 320px;
    overflow: auto;
    scrollbar-width: thin;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  caption {
    padding: 10px 0;
    color: var(--fl-muted);
    font-size: 11px;
    text-align: left;
  }
  th,
  td {
    padding: 9px 10px;
    border-bottom: 1px solid var(--fl-border);
    text-align: right;
    white-space: nowrap;
  }
  th {
    color: var(--fl-muted);
    font-weight: 450;
  }
  th:first-child {
    padding-left: 0;
    text-align: left;
  }
  thead th {
    font-weight: 550;
  }
  .gap {
    color: var(--fl-muted);
    font-style: italic;
  }
  summary:focus-visible,
  .scroll:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
</style>
