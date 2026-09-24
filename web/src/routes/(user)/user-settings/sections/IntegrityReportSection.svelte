<script lang="ts">
  /**
   * One integrity report (FL-81) inside Maintenance → Integrity checks (FL-71); the old
   * `/admin/maintenance/integrity-report/<type>` page only redirects here.
   */
  import CommandCenterActions from '$lib/components/frameleaf/settings/CommandCenterActions.svelte';
  import IntegrityReportTableItem from '$lib/components/maintenance/integrity/IntegrityReportTableItem.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { filterMaintenanceReportItems, summarizeMaintenanceReportFilter } from '$lib/frameleaf/maintenance-report';
  import { getIntegrityReportActions } from '$lib/services/integrity.service';
  import { asyncTimeout } from '$lib/utils';
  import { getIntegrityReport, getQueuesLegacy, IntegrityReport, type IntegrityReportResponseDto } from '@immich/sdk';
  import { Button, Table, TableBody, TableHeader, TableHeading } from '@immich/ui';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    type: IntegrityReport;
  };

  let { type }: Props = $props();

  let integrityReport = $state<IntegrityReportResponseDto>({ items: [] });

  // Frameleaf redesign (FL-81): client-side filter over the currently loaded page of items.
  // Production integrity findings are `{ id, path }` per type/cursor page, unlike the design
  // template's simulated findings with severity/message/detail, so filterMaintenanceReportItems
  // ports the template's bounded substring-match behaviour to that real shape instead of
  // reintroducing a severity concept the server does not have.
  let reportQuery = $state('');
  const filteredItems = $derived(filterMaintenanceReportItems(integrityReport.items, reportQuery));
  const filterSummary = $derived(summarizeMaintenanceReportFilter(filteredItems.length, integrityReport.items.length));

  const loadMore = async () => {
    const { items, nextCursor } = await getIntegrityReport({
      $type: type,
      cursor: integrityReport.nextCursor,
    });

    integrityReport.items.push(...items);
    integrityReport.nextCursor = nextCursor;
  };

  let running = true;
  let expectingUpdate = false;

  onMount(async () => {
    integrityReport = await getIntegrityReport({ $type: type });
    while (running) {
      const jobs = await getQueuesLegacy();
      if (jobs.integrityCheck.queueStatus.isActive) {
        expectingUpdate = true;
      } else if (expectingUpdate) {
        integrityReport = await getIntegrityReport({
          $type: type,
        });
        expectingUpdate = false;
      }

      await asyncTimeout(2000);
    }
  });

  onDestroy(() => {
    running = false;
  });

  const { Download, Delete } = $derived(getIntegrityReportActions($t, type));

  const onIntegrityReportDeleted = ({ id, type: deletedType }: { id?: string; type?: IntegrityReport }) => {
    if (deletedType === type) {
      integrityReport.items = [];
      integrityReport.nextCursor = undefined;
    } else {
      integrityReport.items = integrityReport.items.filter((report) => report.id !== id);
    }
  };
</script>

<OnEvents {onIntegrityReportDeleted} />

<h2 class="report-title">{$t(`admin.maintenance_integrity_${type}`)}</h2>
<CommandCenterActions actions={[Download, Delete]} />
<div class="frameleaf-report-search">
  <label for="frameleaf-maintenance-report-search" class="sr-only">
    {$t('admin.frameleaf_maintenance_report_search_label')}
  </label>
  <input
    id="frameleaf-maintenance-report-search"
    type="search"
    placeholder={$t('admin.frameleaf_maintenance_report_search_placeholder')}
    bind:value={reportQuery}
  />
  <span aria-live="polite" class="frameleaf-report-search-summary">
    {#if filterSummary.isFiltered}
      {$t('admin.frameleaf_maintenance_report_search_count', {
        values: { filtered: filterSummary.filtered, total: filterSummary.total },
      })}
    {/if}
  </span>
</div>

<Table striped spacing="tiny">
  <TableHeader>
    <TableHeading class="w-7/8 text-left">{$t('filename')}</TableHeading>
    <TableHeading class="w-1/8" />
  </TableHeader>

  <TableBody>
    {#each filteredItems as { id, path } (id)}
      <IntegrityReportTableItem {id} {path} reportType={type} />
    {/each}
  </TableBody>

  {#if filterSummary.isFiltered && filteredItems.length === 0}
    <tfoot>
      <tr
        ><td colspan="2" class="frameleaf-report-empty">{$t('admin.frameleaf_maintenance_report_search_empty')}</td></tr
      >
    </tfoot>
  {:else if integrityReport.nextCursor}
    <tfoot class="mt-4 flex justify-center">
      <Button size="medium" color="secondary" onclick={() => loadMore()}>{$t('load_more')}</Button>
    </tfoot>
  {/if}
</Table>

<style>
  .report-title {
    margin: 0 0 12px;
    font-size: 16px;
    font-weight: 550;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .frameleaf-report-search {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .frameleaf-report-search input {
    flex: 1;
    min-width: 0;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-family: inherit;
    font-size: var(--fl-font-size);
  }
  .frameleaf-report-search-summary {
    flex-shrink: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .frameleaf-report-empty {
    padding: 1rem;
    text-align: center;
    color: var(--fl-muted);
  }
</style>
