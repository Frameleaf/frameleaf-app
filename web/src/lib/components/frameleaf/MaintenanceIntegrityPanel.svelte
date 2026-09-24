<script lang="ts">
  /**
   * Maintenance → Integrity checks (FL-81 CC-21/22): the prototype's integrity card
   * (`design/frameleaf/template/src/Maintenance.jsx:425-534`) — "Run all checks", a card per check
   * with its status, findings and "Run check" / "View report", and the Reports list with Open and
   * Delete. Presentation only: the caller (`MaintenanceSection`) owns the polling, job creation and
   * `integrityReport` summary.
   *
   * Production keeps one standing report per check (its findings, re-read by the refresh jobs), not a
   * report per run, and records no run time, so a check shows its findings count instead of "Last
   * run …". Deleting a report acts on its findings (files are deleted or items trashed, see
   * `handleRemoveAllIntegrityReportItems`), which the confirmation says in full.
   */
  import { Route } from '$lib/route';
  import { handleRemoveAllIntegrityReportItems } from '$lib/services/integrity.service';
  import { IntegrityReport, ManualJobName, type IntegrityReportSummaryResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiFileAlertOutline,
    mdiFileQuestionOutline,
    mdiFileSearchOutline,
    mdiShieldCheckOutline,
    mdiTableLarge,
  } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';

  type Props = {
    reportTypes: IntegrityReport[];
    integrityReport: IntegrityReportSummaryResponseDto;
    jobNames: Record<IntegrityReport, ManualJobName>;
    activeJobs: Set<ManualJobName>;
    getReportTypeTranslation: (report: IntegrityReport) => Translations;
    getReportTypeDescriptionKey: (report: IntegrityReport) => Translations;
    onCheck: (type: IntegrityReport) => void;
    onCheckAll: () => void;
  };

  const {
    reportTypes,
    integrityReport,
    jobNames,
    activeJobs,
    getReportTypeTranslation,
    getReportTypeDescriptionKey,
    onCheck,
    onCheckAll,
  }: Props = $props();

  const icons: Record<IntegrityReport, string> = {
    [IntegrityReport.UntrackedFile]: mdiFileQuestionOutline,
    [IntegrityReport.MissingFile]: mdiFileSearchOutline,
    [IntegrityReport.ChecksumMismatch]: mdiFileAlertOutline,
  };

  const allRunning = $derived(reportTypes.every((type) => activeJobs.has(jobNames[type])));
  const reports = $derived(reportTypes.filter((type) => integrityReport[type] > 0));

  const findings = (count: number) => $t('admin.frameleaf_maintenance_findings', { values: { count } });
</script>

<section class="mt-card" aria-labelledby="fl-maintenance-integrity-title">
  <div class="mt-card-title">
    <div>
      <h2 id="fl-maintenance-integrity-title">{$t('admin.frameleaf_maintenance_integrity_title')}</h2>
      <p>{$t('admin.frameleaf_maintenance_integrity_description')}</p>
    </div>
    <button type="button" class="button primary" disabled={allRunning} onclick={onCheckAll}>
      <Icon icon={mdiShieldCheckOutline} size="16" aria-hidden={true} />
      {$t('admin.frameleaf_maintenance_run_all_checks')}
    </button>
  </div>
  <div class="mt-grid">
    {#each reportTypes as reportType (reportType)}
      {@const title = $t(getReportTypeTranslation(reportType))}
      {@const running = activeJobs.has(jobNames[reportType])}
      {@const count = integrityReport[reportType]}
      <article class="mt-check" aria-label={title}>
        <header>
          <Icon icon={icons[reportType]} size="20" aria-hidden={true} />
          <strong>{title}</strong>
          <span
            class="mt-status"
            class:is-running={running}
            class:is-issue={!running && count > 0}
            class:is-ok={!running && count === 0}
          >
            {running
              ? $t('admin.frameleaf_maintenance_check_running_status')
              : count > 0
                ? $t('admin.frameleaf_maintenance_check_issues')
                : $t('admin.frameleaf_maintenance_check_passed')}
          </span>
        </header>
        <p>{$t(getReportTypeDescriptionKey(reportType))}</p>
        {#if running}
          <progress aria-label={$t('admin.frameleaf_maintenance_check_progress', { values: { title } })}></progress>
        {/if}
        <small>{findings(count)}</small>
        <div class="mt-actions">
          <button type="button" class="button" disabled={running} onclick={() => onCheck(reportType)}>
            {running ? $t('admin.frameleaf_maintenance_check_running') : $t('admin.frameleaf_maintenance_run_check')}
          </button>
          {#if count > 0}
            <a class="button" href={Route.systemMaintenanceIntegrityReport({ reportType })}>
              <Icon icon={mdiTableLarge} size="16" aria-hidden={true} />
              {$t('admin.frameleaf_maintenance_view_report')}
            </a>
          {/if}
        </div>
      </article>
    {/each}
  </div>
  {#if reports.length > 0}
    <h3>{$t('admin.frameleaf_maintenance_reports')}</h3>
    <div class="mt-list" role="list" aria-label={$t('admin.frameleaf_maintenance_reports_label')}>
      {#each reports as reportType (reportType)}
        {@const title = $t(getReportTypeTranslation(reportType))}
        <div class="mt-row" role="listitem">
          <Icon icon={icons[reportType]} size="20" aria-hidden={true} />
          <div class="mt-row-main"><strong>{title}</strong></div>
          <div class="mt-row-meta"><span class="mt-sev">{findings(integrityReport[reportType])}</span></div>
          <div class="mt-actions">
            <a class="button" href={Route.systemMaintenanceIntegrityReport({ reportType })}>{$t('open')}</a>
            <button
              type="button"
              class="button danger"
              aria-label={$t('admin.frameleaf_maintenance_report_delete_label', { values: { title } })}
              onclick={() => void handleRemoveAllIntegrityReportItems(reportType)}
            >
              {$t('delete')}
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  /* design/frameleaf/template/src/maintenance.css `.mt-card`, `.mt-grid`, `.mt-check`, `.mt-row`. */
  .mt-card {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 20px;
    min-width: 0;
  }
  .mt-card-title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .mt-card-title h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  .mt-card-title p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
    max-width: 40rem;
  }
  h3 {
    margin: 20px 0 6px;
    font-size: 14px;
    font-weight: 600;
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    text-decoration: none;
  }
  .mt-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .mt-check {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-canvas);
  }
  .mt-check header {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--fl-muted);
  }
  .mt-check header strong {
    flex: 1;
    font-weight: 500;
    color: var(--fl-text);
  }
  .mt-check p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .mt-check small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .mt-check progress {
    width: 100%;
    height: 6px;
    accent-color: var(--fl-blue);
  }
  .mt-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .mt-check .mt-actions {
    margin-top: auto;
  }
  .mt-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .mt-status::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fl-muted);
  }
  .mt-status.is-ok::before {
    background: var(--fl-teal);
  }
  .mt-status.is-issue::before {
    background: var(--fl-warning);
  }
  .mt-status.is-running::before {
    background: var(--fl-blue);
  }
  .mt-list {
    display: flex;
    flex-direction: column;
  }
  .mt-row {
    display: grid;
    grid-template-columns: 22px minmax(0, 1.6fr) minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 12px 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .mt-row:first-child {
    border-top: 0;
  }
  .mt-row-main strong {
    font-weight: 500;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
  }
  .mt-row .mt-actions {
    justify-content: flex-end;
  }
  .mt-row .button.danger {
    color: var(--fl-danger);
  }
  .mt-sev {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 2px 10px;
    border-radius: var(--fl-radius-pill);
    border: 1px solid var(--fl-border);
    font-size: var(--fl-font-micro);
    white-space: nowrap;
  }
  .mt-sev::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--fl-warning);
  }
  @media (max-width: 700px) {
    .mt-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .mt-row {
      grid-template-columns: 22px minmax(0, 1fr);
    }
    .mt-row-meta,
    .mt-row .mt-actions {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
</style>
