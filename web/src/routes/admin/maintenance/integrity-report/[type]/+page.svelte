<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import IntegrityReportTableItem from '$lib/components/maintenance/integrity/IntegrityReportTableItem.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { filterMaintenanceReportItems, summarizeMaintenanceReportFilter } from '$lib/frameleaf/maintenance-report';
  import { Route } from '$lib/route';
  import { getIntegrityReportActions } from '$lib/services/integrity.service';
  import { asyncTimeout } from '$lib/utils';
  import { getIntegrityReport, getQueuesLegacy, IntegrityReport } from '@immich/sdk';
  import { Button, Table, TableBody, TableHeader, TableHeading } from '@immich/ui';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  let integrityReport = $state(data.integrityReport);

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
      $type: data.type,
      cursor: integrityReport.nextCursor,
    });

    integrityReport.items.push(...items);
    integrityReport.nextCursor = nextCursor;
  };

  let running = true;
  let expectingUpdate = false;

  onMount(async () => {
    while (running) {
      const jobs = await getQueuesLegacy();
      if (jobs.integrityCheck.queueStatus.isActive) {
        expectingUpdate = true;
      } else if (expectingUpdate) {
        integrityReport = await getIntegrityReport({
          $type: data.type,
        });
        expectingUpdate = false;
      }

      await asyncTimeout(2000);
    }
  });

  onDestroy(() => {
    running = false;
  });

  const { Download, Delete } = $derived(getIntegrityReportActions($t, data.type));

  const onIntegrityReportDeleted = ({ id, type }: { id?: string; type?: IntegrityReport }) => {
    if (type === data.type) {
      integrityReport.items = [];
      integrityReport.nextCursor = undefined;
    } else {
      integrityReport.items = integrityReport.items.filter((report) => report.id !== id);
    }
  };
</script>

<OnEvents {onIntegrityReportDeleted} />

<AdminPageLayout
  breadcrumbs={[
    { title: $t('admin.maintenance_settings'), href: Route.systemMaintenance() },
    { title: $t('admin.maintenance_integrity_report') },
    { title: data.meta.title },
  ]}
  actions={[Download, Delete]}
>
  <section id="setting-content" class="flex place-content-center sm:mx-4">
    <section class="w-full pb-28 sm:w-5/6 md:w-212.5">
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
            <IntegrityReportTableItem {id} {path} reportType={data.type} />
          {/each}
        </TableBody>

        {#if filterSummary.isFiltered && filteredItems.length === 0}
          <tfoot>
            <tr><td colspan="2" class="frameleaf-report-empty">{$t('admin.frameleaf_maintenance_report_search_empty')}</td></tr>
          </tfoot>
        {:else if integrityReport.nextCursor}
          <tfoot class="mt-4 flex justify-center">
            <Button size="medium" color="secondary" onclick={() => loadMore()}>{$t('load_more')}</Button>
          </tfoot>
        {/if}
      </Table>
    </section>
  </section>
</AdminPageLayout>

<style>
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
    font-size: var(--fl-font-body);
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
