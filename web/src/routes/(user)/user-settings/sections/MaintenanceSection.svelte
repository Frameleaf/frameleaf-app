<script lang="ts">
  /**
   * Maintenance (FL-71, FL-81): the template's `Maintenance.jsx` sections — maintenance mode,
   * database backups and integrity checks — in the Command Center; the old `/admin/maintenance`
   * page only redirects here. An integrity report (`?report=<type>`) opens inside its section.
   */
  import { page } from '$app/state';
  import IntegrityReportSection from './IntegrityReportSection.svelte';
  import MaintenanceBackupsPanel from '$lib/components/frameleaf/MaintenanceBackupsPanel.svelte';
  import MaintenanceIntegrityPanel from '$lib/components/frameleaf/MaintenanceIntegrityPanel.svelte';
  import MaintenanceModeCard from '$lib/components/frameleaf/MaintenanceModeCard.svelte';
  import MaintenanceRestoreTest from '$lib/components/frameleaf/MaintenanceRestoreTest.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { Route } from '$lib/route';
  import { handleCreateJob } from '$lib/services/job.service';
  import {
    getIntegrityCheckRuns,
    getIntegrityReportSummary,
    getQueuesLegacy,
    getServerVersion,
    listDatabaseBackups,
    type DatabaseBackupDto,
    IntegrityReport,
    ManualJobName,
    type IntegrityCheckRunsResponseDto,
    type IntegrityReportSummaryResponseDto,
    type JobCreateDto,
    type QueuesResponseLegacyDto,
  } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';

  type Props = {
    section: 'mode' | 'backups' | 'integrity';
  };

  const { section }: Props = $props();

  const report = $derived(Object.values(IntegrityReport).find((type) => type === page.url.searchParams.get('report')));

  let integrityReport: IntegrityReportSummaryResponseDto | undefined = $state();
  /** FL-81 (CC-21): when each check last ran; the panel works without it. */
  let runs: IntegrityCheckRunsResponseDto | undefined = $state();
  const loadRuns = () =>
    getIntegrityCheckRuns()
      .then((result) => (runs = result))
      .catch(() => {
        // "Last run" stays out; the findings still show.
      });
  let backups: DatabaseBackupDto[] | undefined = $state();
  let expectedVersion = $state('');
  let failed = $state(false);

  // What the old page loaded with it: the integrity summary, the server version and the backups.
  onMount(() => {
    void Promise.all([getIntegrityReportSummary(), getServerVersion(), listDatabaseBackups()])
      .then(([summary, { major, minor, patch }, result]) => {
        integrityReport = summary;
        expectedVersion = `${major}.${minor}.${patch}`;
        backups = result.backups;
      })
      .catch(() => (failed = true));
    void loadRuns();
  });

  const reportTypes: IntegrityReport[] = [
    IntegrityReport.UntrackedFile,
    IntegrityReport.MissingFile,
    IntegrityReport.ChecksumMismatch,
  ];

  const jobNames: Record<IntegrityReport, ManualJobName> = {
    [IntegrityReport.UntrackedFile]: ManualJobName.IntegrityUntrackedFiles,
    [IntegrityReport.MissingFile]: ManualJobName.IntegrityMissingFiles,
    [IntegrityReport.ChecksumMismatch]: ManualJobName.IntegrityChecksumMismatch,
  };

  const refreshJobNames: Record<IntegrityReport, ManualJobName> = {
    [IntegrityReport.UntrackedFile]: ManualJobName.IntegrityUntrackedFilesRefresh,
    [IntegrityReport.MissingFile]: ManualJobName.IntegrityMissingFilesRefresh,
    [IntegrityReport.ChecksumMismatch]: ManualJobName.IntegrityChecksumMismatchRefresh,
  };

  let jobs: QueuesResponseLegacyDto | undefined = $state();
  const activeJobs = new SvelteSet<ManualJobName>();

  const getReportTypeTranslation = (report: IntegrityReport): Translations => {
    switch (report) {
      case IntegrityReport.UntrackedFile: {
        return 'admin.maintenance_integrity_untracked_file';
      }
      case IntegrityReport.MissingFile: {
        return 'admin.maintenance_integrity_missing_file';
      }
      case IntegrityReport.ChecksumMismatch: {
        return 'admin.maintenance_integrity_checksum_mismatch';
      }
    }
  };

  const getReportTypeDescriptionKey = (report: IntegrityReport): Translations => {
    switch (report) {
      case IntegrityReport.UntrackedFile: {
        return 'admin.maintenance_integrity_untracked_file_description';
      }
      case IntegrityReport.MissingFile: {
        return 'admin.maintenance_integrity_missing_file_description';
      }
      case IntegrityReport.ChecksumMismatch: {
        return 'admin.maintenance_integrity_checksum_mismatch_description';
      }
    }
  };

  const updateReports = async () => {
    jobs = await getQueuesLegacy();
    if (jobs.integrityCheck.queueStatus.isActive) {
      activeJobs.add(ManualJobName.IntegrityUntrackedFilesRefresh);
    } else if (activeJobs.size > 0) {
      activeJobs.clear();
      integrityReport = await getIntegrityReportSummary();
      void loadRuns();
    }
  };

  // Only the integrity checks follow the running checks; the section can change without a remount.
  $effect(() => {
    if (section !== 'integrity') {
      return;
    }
    const interval = setInterval(() => void updateReports(), 2000);

    return () => clearInterval(interval);
  });

  const onJobCreate = ({ dto }: { dto: JobCreateDto }) => {
    if (!((Object.values(jobNames).includes(dto.name) || Object.values(refreshJobNames).includes(dto.name)) && jobs)) {
      return;
    }

    activeJobs.add(dto.name);
    jobs.integrityCheck.queueStatus.isActive = true;
  };
</script>

<OnEvents {onJobCreate} />

{#if section === 'mode'}
  <MaintenanceModeCard
    backupsHref={Route.systemMaintenance({ section: 'backups' })}
    integrityHref={Route.systemMaintenance({ section: 'integrity' })}
  />
{:else if failed}
  <p role="alert">{$t('frameleaf_cc_load_failed')}</p>
{:else if section === 'integrity' && report}
  <IntegrityReportSection type={report} />
{:else if section === 'integrity' && integrityReport}
  <MaintenanceIntegrityPanel
    {reportTypes}
    {integrityReport}
    {runs}
    {jobNames}
    {activeJobs}
    {getReportTypeTranslation}
    {getReportTypeDescriptionKey}
    onCheck={(type) => void handleCreateJob({ name: jobNames[type] })}
    onCheckAll={() => {
      for (const name of Object.values(jobNames)) {
        void handleCreateJob({ name });
      }
    }}
  />
{:else if section === 'backups' && backups}
  <MaintenanceBackupsPanel {backups} {expectedVersion} />
  <MaintenanceRestoreTest />
{:else}
  <p role="status">{$t('loading')}</p>
{/if}
