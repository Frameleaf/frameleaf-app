<script lang="ts">
  /**
   * Frameleaf redesign of the "Integrity checks" section of the design template's
   * `Maintenance.jsx`. Presentation only: the caller (`/admin/maintenance`) owns the
   * polling, job creation and `integrityReport` state exactly as the legacy page does,
   * because that logic is shared with the legacy branch and must not fork in two places.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import { Route } from '$lib/route';
  import {
    IntegrityReport,
    ManualJobName,
    type IntegrityReportSummaryResponseDto,
  } from '@immich/sdk';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';

  type Props = {
    reportTypes: IntegrityReport[];
    integrityReport: IntegrityReportSummaryResponseDto;
    jobNames: Record<IntegrityReport, ManualJobName>;
    refreshJobNames: Record<IntegrityReport, ManualJobName>;
    activeJobs: Set<ManualJobName>;
    getReportTypeTranslation: (report: IntegrityReport) => Translations;
    getReportTypeDescriptionKey: (report: IntegrityReport) => Translations;
    onCheck: (type: IntegrityReport) => void;
    onRefresh: (type: IntegrityReport) => void;
    onCheckAll: () => void;
    onRefreshAll: () => void;
  };

  const {
    reportTypes,
    integrityReport,
    jobNames,
    refreshJobNames,
    activeJobs,
    getReportTypeTranslation,
    getReportTypeDescriptionKey,
    onCheck,
    onRefresh,
    onCheckAll,
    onRefreshAll,
  }: Props = $props();

  const anyActive = $derived(activeJobs.size > 0);
</script>

<Pane label={$t('admin.maintenance_integrity_report')}>
  <div class="head">
    <h2>{$t('admin.maintenance_integrity_report')}</h2>
    <div class="head-actions">
      <Button onclick={onCheckAll} disabled={anyActive}>{$t('admin.maintenance_integrity_check_all')}</Button>
      <Button onclick={onRefreshAll} disabled={anyActive}>{$t('refresh')}</Button>
    </div>
  </div>
  <div class="grid">
    {#each reportTypes as reportType (reportType)}
      {@const checking = activeJobs.has(jobNames[reportType])}
      {@const refreshing = activeJobs.has(refreshJobNames[reportType])}
      <article class="check" aria-label={$t(getReportTypeTranslation(reportType))}>
        <header>
          <strong>{$t(getReportTypeTranslation(reportType))}</strong>
          <Badge
            value={integrityReport[reportType]}
            label={$t(getReportTypeTranslation(reportType)) + ': ' + integrityReport[reportType]}
            tone={integrityReport[reportType] > 0 ? 'warning' : 'neutral'}
          />
        </header>
        <p>{$t(getReportTypeDescriptionKey(reportType))}</p>
        <div class="actions">
          <Button onclick={() => onCheck(reportType)} disabled={checking}>
            {checking ? $t('admin.frameleaf_maintenance_check_running') : $t('admin.maintenance_integrity_check')}
          </Button>
          <Button onclick={() => onRefresh(reportType)} disabled={refreshing}>{$t('refresh')}</Button>
          <a class="view-link" href={Route.systemMaintenanceIntegrityReport({ reportType })}>{$t('view')}</a>
        </div>
      </article>
    {/each}
  </div>
</Pane>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0;
  }
  .head-actions {
    display: flex;
    gap: 0.5rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 0.75rem;
  }
  .check {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .check header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .check p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: auto;
  }
  .view-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.4375rem 0.6875rem;
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius-control);
    text-decoration: none;
  }
  .view-link:hover {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-text) 12%);
  }
</style>
