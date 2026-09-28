import { createJob, deleteIntegrityReport, IntegrityReport, ManualJobName } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * Acting on a finding is destructive: an untracked file is deleted from disk, and an item whose file
 * is missing or no longer matches its checksum is moved to the trash (`IntegrityService`). The
 * Frameleaf confirmation (FL-81 CC-22/23, the prototype's "Delete this report?") says so in full.
 */
const consequenceKey = (reportType: IntegrityReport) =>
  reportType === IntegrityReport.UntrackedFile
    ? 'admin.frameleaf_maintenance_report_delete_untracked'
    : 'admin.frameleaf_maintenance_report_delete_trash';

export const handleRemoveAllIntegrityReportItems = async (reportType: IntegrityReport) => {
  const $t = await getFormatter();
  const confirm = await confirmFrameleaf({
    title: $t('admin.frameleaf_maintenance_report_delete_title'),
    prompt: $t(consequenceKey(reportType)),
    confirmText: $t('admin.frameleaf_maintenance_report_delete_action'),
    danger: true,
  });

  if (!confirm) {
    return;
  }

  let name: ManualJobName;
  switch (reportType) {
    case IntegrityReport.UntrackedFile: {
      name = ManualJobName.IntegrityUntrackedFilesDeleteAll;
      break;
    }
    case IntegrityReport.MissingFile: {
      name = ManualJobName.IntegrityMissingFilesDeleteAll;
      break;
    }
    case IntegrityReport.ChecksumMismatch: {
      name = ManualJobName.IntegrityChecksumMismatchDeleteAll;
      break;
    }
  }

  try {
    eventManager.emit('IntegrityReportDeleteStatus', {
      type: reportType,
      isDeleting: true,
    });

    await createJob({ jobCreateDto: { name } });
    toastManager.success($t('admin.job_created'));

    eventManager.emit('IntegrityReportDeleted', {
      type: reportType,
    });
  } catch (error) {
    handleError(error, $t('failed_to_delete_file'));

    eventManager.emit('IntegrityReportDeleteStatus', {
      type: reportType,
      isDeleting: false,
    });
  }
};

export const handleRemoveIntegrityReportItem = async (reportId: string, reportType: IntegrityReport) => {
  const $t = await getFormatter();
  const confirm = await confirmFrameleaf({
    title: $t('admin.frameleaf_maintenance_finding_delete_title'),
    prompt: $t(
      reportType === IntegrityReport.UntrackedFile
        ? 'admin.frameleaf_maintenance_finding_delete_untracked'
        : 'admin.frameleaf_maintenance_finding_delete_trash',
    ),
    confirmText: $t('delete'),
    danger: true,
  });

  if (!confirm) {
    return;
  }

  try {
    eventManager.emit('IntegrityReportDeleteStatus', {
      id: reportId,
      isDeleting: true,
    });

    await deleteIntegrityReport({
      id: reportId,
    });

    eventManager.emit('IntegrityReportDeleted', {
      id: reportId,
    });
  } catch (error) {
    handleError(error, $t('failed_to_delete_file'));

    eventManager.emit('IntegrityReportDeleteStatus', {
      id: reportId,
      isDeleting: false,
    });
  }
};
