import {
  deleteDatabaseBackup,
  getBaseUrl,
  MaintenanceAction,
  setMaintenanceMode,
  type DatabaseBackupUploadDto,
} from '@immich/sdk';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { uploadRequest } from '$lib/utils';
import { openFilePicker } from '$lib/utils/file-uploader';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * Restores a database backup without prompting first. The caller owns the confirmation
 * step: `MaintenanceRestoreConfirmDialog.svelte` requires the administrator to type
 * RESTORE before this runs. It calls `setMaintenanceMode` with
 * `MaintenanceAction.RestoreDatabase`.
 */
export const restoreDatabaseBackup = async (
  filename: string,
  { keepSafetyBackup }: { keepSafetyBackup?: boolean } = {},
) => {
  const $t = await getFormatter();
  try {
    await setMaintenanceMode({
      setMaintenanceModeDto: {
        action: MaintenanceAction.RestoreDatabase,
        restoreBackupFilename: filename,
        keepSafetyBackup,
      },
    });
  } catch (error) {
    handleError(error, $t('admin.maintenance_start_error'));
  }
};

/**
 * Deletes backups after the prototype's "Delete this backup?" confirmation
 * (`design/frameleaf/template/src/Maintenance.jsx:610-640`); `date` names the backup in the prompt.
 */
export const handleDeleteDatabaseBackup = async ({ date }: { date: string }, ...filenames: string[]) => {
  const $t = await getFormatter();
  const confirm = await confirmFrameleaf({
    title: $t('admin.frameleaf_maintenance_backup_delete_title'),
    prompt: $t('admin.frameleaf_maintenance_backup_delete_body', { values: { date } }),
    confirmText: $t('admin.frameleaf_maintenance_backup_delete_action'),
    danger: true,
  });

  if (!confirm) {
    return;
  }

  try {
    for (const filename of filenames) {
      eventManager.emit('BackupDeleteStatus', { filename, isDeleting: true });
    }

    await deleteDatabaseBackup({
      databaseBackupDeleteDto: {
        backups: filenames,
      },
    });

    for (const filename of filenames) {
      eventManager.emit('BackupDeleted', { filename });
    }
  } catch (error) {
    handleError(error, $t('admin.maintenance_delete_error'));

    for (const filename of filenames) {
      eventManager.emit('BackupDeleteStatus', { filename, isDeleting: false });
    }
  }
};

export const handleDownloadDatabaseBackup = (filename: string) => {
  location.assign(getBaseUrl() + '/admin/database-backups/' + filename);
};

export const handleUploadDatabaseBackup = async () => {
  const $t = await getFormatter();

  try {
    const [file] = await openFilePicker({ multiple: false });
    const formData = new FormData();
    formData.append('file', file);

    await uploadRequest<DatabaseBackupUploadDto>({
      url: getBaseUrl() + '/admin/database-backups/upload',
      data: formData,
      onUploadProgress(event) {
        eventManager.emit('BackupUpload', { progress: event.loaded / event.total, isComplete: false });
      },
    });

    eventManager.emit('BackupUpload', { progress: 1, isComplete: true });
  } catch (error) {
    handleError(error, $t('admin.maintenance_upload_backup_error'));
  } finally {
    eventManager.emit('BackupUpload', { progress: -1, isComplete: false });
  }
};
