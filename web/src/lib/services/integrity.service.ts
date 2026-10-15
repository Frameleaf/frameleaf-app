import {
  clearIntegrityReports,
  createJob,
  deleteIntegrityReport,
  dismissIntegrityReport,
  IntegrityReport,
  ManualJobName,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * Acting on a finding is destructive: an untracked file is deleted from disk, and an item whose file
 * is missing or no longer matches its checksum is moved to the trash (`IntegrityService`), so every
 * such button, title and confirmation names what is removed.
 *
 * FL-366 adds the harmless way to empty a list: `handleClearIntegrityReports` (a whole check) and
 * `handleDismissIntegrityReport` (one finding) only forget findings. No file or photo is touched,
 * and anything still wrong is listed again at the next check, so they ask nothing first.
 */
const untracked = (reportType: IntegrityReport) => reportType === IntegrityReport.UntrackedFile;

/** The label of the action on every finding of a check. */
export const integrityActionKey = (reportType: IntegrityReport) =>
  untracked(reportType)
    ? ('admin.frameleaf_maintenance_report_act_untracked' as const)
    : ('admin.frameleaf_maintenance_report_act_trash' as const);

/** The same action's accessible name beside a check's title. */
export const integrityActionLabelKey = (reportType: IntegrityReport) =>
  untracked(reportType)
    ? ('admin.frameleaf_maintenance_report_act_untracked_label' as const)
    : ('admin.frameleaf_maintenance_report_act_trash_label' as const);

/** The label of the action on one finding. */
export const integrityFindingActionKey = (reportType: IntegrityReport) =>
  untracked(reportType)
    ? ('admin.frameleaf_maintenance_finding_act_untracked' as const)
    : ('admin.frameleaf_maintenance_finding_act_trash' as const);

const consequenceKey = (reportType: IntegrityReport) => {
  if (untracked(reportType)) {
    return 'admin.frameleaf_maintenance_report_delete_untracked' as const;
  }
  return reportType === IntegrityReport.MissingFile
    ? ('admin.frameleaf_maintenance_report_act_missing' as const)
    : ('admin.frameleaf_maintenance_report_act_checksum' as const);
};

/** `count` is how many findings the check has; leave it out when only part of the list is loaded. */
export const handleRemoveAllIntegrityReportItems = async (reportType: IntegrityReport, count = 0) => {
  const $t = await getFormatter();
  const confirm = await confirmFrameleaf({
    title: $t(
      untracked(reportType)
        ? 'admin.frameleaf_maintenance_report_act_untracked_title'
        : 'admin.frameleaf_maintenance_report_act_trash_title',
      { values: { count } },
    ),
    prompt: $t(consequenceKey(reportType)),
    confirmText: $t(integrityActionKey(reportType)),
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
    title: $t(
      untracked(reportType)
        ? 'admin.frameleaf_maintenance_finding_act_untracked_title'
        : 'admin.frameleaf_maintenance_finding_act_trash_title',
    ),
    prompt: $t(
      untracked(reportType)
        ? 'admin.frameleaf_maintenance_finding_delete_untracked'
        : 'admin.frameleaf_maintenance_finding_delete_trash',
    ),
    confirmText: $t(integrityFindingActionKey(reportType)),
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

/**
 * "Clear this list" (FL-366): forgets every finding of one check. Nothing is deleted or moved, so it
 * asks nothing first; the toast says so. Resolves to how many findings were forgotten.
 */
export const handleClearIntegrityReports = async (reportType: IntegrityReport) => {
  const $t = await getFormatter();
  try {
    const { cleared } = await clearIntegrityReports({ $type: reportType });
    eventManager.emit('IntegrityReportDeleted', { type: reportType });
    toastManager.success($t('frameleaf_care_list_cleared', { values: { count: cleared } }));
    return cleared;
  } catch (error) {
    handleError(error, $t('frameleaf_care_list_clear_failed'));
  }
};

/** "Remove from list" (FL-366): forgets one finding. The file and the photo stay as they are. */
export const handleDismissIntegrityReport = async (reportId: string) => {
  const $t = await getFormatter();
  try {
    await dismissIntegrityReport({ id: reportId });
    eventManager.emit('IntegrityReportDeleted', { id: reportId });
    toastManager.success($t('frameleaf_care_list_removed'));
    return true;
  } catch (error) {
    handleError(error, $t('frameleaf_care_list_remove_failed'));
  }
};
