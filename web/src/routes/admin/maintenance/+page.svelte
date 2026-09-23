<script lang="ts">
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import MaintenanceBackupsPanel from '$lib/components/frameleaf/MaintenanceBackupsPanel.svelte';
  import MaintenanceIntegrityPanel from '$lib/components/frameleaf/MaintenanceIntegrityPanel.svelte';
  import MaintenanceMigrationPanel from '$lib/components/frameleaf/MaintenanceMigrationPanel.svelte';
  import MaintenanceModeCard from '$lib/components/frameleaf/MaintenanceModeCard.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { handleCreateJob } from '$lib/services/job.service';
  import {
    getIntegrityReportSummary,
    getQueuesLegacy,
    IntegrityReport,
    ManualJobName,
    type IntegrityReportSummaryResponseDto,
    type JobCreateDto,
    type QueuesResponseLegacyDto,
  } from '@immich/sdk';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { type Translations } from 'svelte-i18n';
  import type { PageData } from './$types';
  import { SvelteSet } from 'svelte/reactivity';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  let integrityReport: IntegrityReportSummaryResponseDto = $state(data.integrityReport);

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
    }
  };

  onMount(() => {
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

<!--
  Maintenance (FL-81): the integrityReport/jobs/activeJobs state and the
  handleCreateJob/getQueuesLegacy polling above drive these panels. The page header has no
  Start-maintenance action because MaintenanceModeCard owns that flow, with its own
  confirmation dialog. Server migration (FL-75) sits beside the integrity reports: it shows
  the command-line steps and opens the migration audit report read-only in the browser.
-->
<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <div class="flex flex-col gap-6">
        <MaintenanceModeCard />
        <MaintenanceIntegrityPanel
          {reportTypes}
          {integrityReport}
          {jobNames}
          {refreshJobNames}
          {activeJobs}
          {getReportTypeTranslation}
          {getReportTypeDescriptionKey}
          onCheck={(type) => void handleCreateJob({ name: jobNames[type] })}
          onRefresh={(type) => void handleCreateJob({ name: refreshJobNames[type] })}
          onCheckAll={() => {
            for (const name of Object.values(jobNames)) {
              void handleCreateJob({ name });
            }
          }}
          onRefreshAll={() => {
            for (const name of Object.values(refreshJobNames)) {
              void handleCreateJob({ name });
            }
          }}
        />
        <MaintenanceMigrationPanel />
        <MaintenanceBackupsPanel backups={data.backups} expectedVersion={data.expectedVersion} />
      </div>
    </Theme>
  </Container>
</AdminPageLayout>
