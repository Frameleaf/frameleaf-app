<script lang="ts">
  /**
   * One integrity report (FL-81 CC-23) inside Maintenance → Integrity checks (FL-71): the prototype's
   * `ReportViewer` (`design/frameleaf/template/src/Maintenance.jsx:756-893`) — a summary line,
   * "Download CSV", "Download report file" (a text file of every finding), "Delete report" behind a Frameleaf confirmation, a findings filter and table — in
   * place of the upstream `Table` and context menus. The old
   * `/admin/maintenance/integrity-report/<type>` page only redirects here.
   *
   * Production findings are `{ id, path }` pages per check, with no severity or message, so the table
   * has a path and its actions, and the filter matches the loaded paths
   * (`filterMaintenanceReportItems`). "Recheck findings" runs the check's refresh job, which drops
   * findings that no longer apply.
   */
  import OnEvents from '$lib/components/OnEvents.svelte';
  import {
    filterMaintenanceReportItems,
    maintenanceReportFileName,
    maintenanceReportText,
    summarizeMaintenanceReportFilter,
  } from '$lib/frameleaf/maintenance-report';
  import { Route } from '$lib/route';
  import {
    handleRemoveAllIntegrityReportItems,
    handleRemoveIntegrityReportItem,
  } from '$lib/services/integrity.service';
  import { handleCreateJob } from '$lib/services/job.service';
  import { asyncTimeout, downloadBlob } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getIntegrityCheckRuns,
    getIntegrityReport,
    getQueuesLegacy,
    IntegrityReport,
    ManualJobName,
    type IntegrityReportResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiArrowLeft, mdiDeleteOutline, mdiDownload, mdiFileDocumentOutline, mdiRefresh } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    type: IntegrityReport;
  };

  let { type }: Props = $props();

  const refreshJobs: Record<IntegrityReport, ManualJobName> = {
    [IntegrityReport.UntrackedFile]: ManualJobName.IntegrityUntrackedFilesRefresh,
    [IntegrityReport.MissingFile]: ManualJobName.IntegrityMissingFilesRefresh,
    [IntegrityReport.ChecksumMismatch]: ManualJobName.IntegrityChecksumMismatchRefresh,
  };

  // Only these checks point at a file on disk that can be downloaded.
  const downloadable = $derived(type === IntegrityReport.UntrackedFile || type === IntegrityReport.ChecksumMismatch);

  let integrityReport = $state<IntegrityReportResponseDto>({ items: [] });
  let deleting = $state(new Set<string>());
  let deletingAll = $state(false);

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

  // The template's "Download report file": every finding of the check, every page, as text.
  let exporting = $state(false);
  const downloadReportFile = async () => {
    exporting = true;
    try {
      const paths: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await getIntegrityReport({ $type: type, cursor });
        paths.push(...result.items.map((item) => item.path));
        cursor = result.nextCursor;
      } while (cursor);
      const runs = await getIntegrityCheckRuns().catch(() => undefined);
      const text = maintenanceReportText({
        title: $t(`admin.maintenance_integrity_${type}`),
        lastRunAt: runs?.[type],
        paths,
      });
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), maintenanceReportFileName(type, new Date()));
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      exporting = false;
    }
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

  const onIntegrityReportDeleted = ({ id, type: deletedType }: { id?: string; type?: IntegrityReport }) => {
    if (deletedType === type) {
      integrityReport.items = [];
      integrityReport.nextCursor = undefined;
    } else {
      integrityReport.items = integrityReport.items.filter((report) => report.id !== id);
    }
  };

  const onIntegrityReportDeleteStatus = ({
    id,
    type: statusType,
    isDeleting,
  }: {
    id?: string;
    type?: IntegrityReport;
    isDeleting: boolean;
  }) => {
    if (statusType === type) {
      deletingAll = isDeleting;
    } else if (id) {
      const next = new Set(deleting);
      if (isDeleting) {
        next.add(id);
      } else {
        next.delete(id);
      }
      deleting = next;
    }
  };
</script>

<OnEvents {onIntegrityReportDeleted} {onIntegrityReportDeleteStatus} />

<section class="report" aria-labelledby="fl-integrity-report-title">
  <a class="back" href={Route.systemMaintenance({ section: 'integrity' })}>
    <Icon icon={mdiArrowLeft} size="16" aria-hidden={true} />
    {$t('admin.frameleaf_maintenance_integrity_title')}
  </a>
  <div class="report-head">
    <div>
      <h2 id="fl-integrity-report-title">
        {$t('admin.frameleaf_maintenance_report_title', {
          values: { title: $t(`admin.maintenance_integrity_${type}`) },
        })}
      </h2>
      <p class="summary">
        {$t('admin.frameleaf_maintenance_report_summary', {
          values: { count: integrityReport.items.length, more: integrityReport.nextCursor ? 1 : 0 },
        })}
      </p>
    </div>
    <div class="actions">
      <button type="button" class="button" onclick={() => void handleCreateJob({ name: refreshJobs[type] })}>
        <Icon icon={mdiRefresh} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_maintenance_report_recheck')}
      </button>
      <a class="button" href={Route.integrityReportCsv(type)}>
        <Icon icon={mdiDownload} size="16" aria-hidden={true} />
        {$t('admin.download_csv')}
      </a>
      <button type="button" class="button" disabled={exporting} onclick={() => void downloadReportFile()}>
        <Icon icon={mdiFileDocumentOutline} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_maintenance_report_download_file')}
      </button>
      <button
        type="button"
        class="button danger"
        disabled={deletingAll || integrityReport.items.length === 0}
        onclick={() => void handleRemoveAllIntegrityReportItems(type)}
      >
        <Icon icon={mdiDeleteOutline} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_maintenance_report_delete_action')}
      </button>
    </div>
  </div>

  <div class="toolbar">
    <input
      type="search"
      aria-label={$t('admin.frameleaf_maintenance_report_search_label')}
      placeholder={$t('admin.frameleaf_maintenance_report_search_placeholder')}
      bind:value={reportQuery}
    />
    <span aria-live="polite" class="count">
      {#if filterSummary.isFiltered}
        {$t('admin.frameleaf_maintenance_report_search_count', {
          values: { filtered: filterSummary.filtered, total: filterSummary.total },
        })}
      {/if}
    </span>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th scope="col">{$t('admin.frameleaf_maintenance_report_path')}</th>
          <th scope="col"><span class="sr-only">{$t('actions')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each filteredItems as { id, path } (id)}
          <tr>
            <td><code>{path}</code></td>
            <td class="row-actions">
              {#if downloadable}
                <a class="button" href={Route.integrityReportFile(id)} aria-label={$t('download') + ' ' + path}>
                  {$t('download')}
                </a>
              {/if}
              <button
                type="button"
                class="button danger"
                disabled={deletingAll || deleting.has(id)}
                aria-label={$t('delete') + ' ' + path}
                onclick={() => void handleRemoveIntegrityReportItem(id, type)}
              >
                {$t('delete')}
              </button>
            </td>
          </tr>
        {/each}
        {#if filteredItems.length === 0}
          <tr>
            <td colspan="2" class="empty">
              {filterSummary.isFiltered
                ? $t('admin.frameleaf_maintenance_report_search_empty')
                : $t('admin.frameleaf_maintenance_report_empty')}
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
  {#if integrityReport.nextCursor && !filterSummary.isFiltered}
    <div class="pager">
      <button type="button" class="button" onclick={() => void loadMore()}>{$t('load_more')}</button>
    </div>
  {/if}
</section>

<style>
  .report {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 20px;
    min-width: 0;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 12px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  .back:hover {
    color: var(--fl-text);
  }
  .report-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  .summary {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions,
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .row-actions {
    justify-content: flex-end;
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    text-decoration: none;
  }
  .row-actions .button {
    padding: 5px 9px;
    font-size: var(--fl-font-small);
  }
  .button.danger {
    color: var(--fl-danger);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .toolbar input {
    flex: 1;
    min-width: 160px;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 6px 9px;
    font: inherit;
  }
  .count {
    flex-shrink: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-small);
  }
  th {
    text-align: left;
    color: var(--fl-muted);
    font-weight: 500;
    padding: 8px 6px;
    border-bottom: 1px solid var(--fl-border);
  }
  td {
    padding: 8px 6px;
    border-bottom: 1px solid var(--fl-border);
    vertical-align: middle;
  }
  td code {
    word-break: break-all;
  }
  .empty {
    padding: 16px;
    text-align: center;
    color: var(--fl-muted);
  }
  .pager {
    display: flex;
    justify-content: center;
    margin-top: 12px;
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
</style>
