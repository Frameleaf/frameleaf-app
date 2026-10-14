import { beforeEach, expect, it, vi } from 'vitest';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleUploadDatabaseBackup } from '$lib/services/database-backups.service';
import * as utils from '$lib/utils';
import * as picker from '$lib/utils/file-uploader';
import * as i18n from '$lib/utils/i18n';

beforeEach(() => {
  vi.spyOn(i18n, 'getFormatter').mockResolvedValue(
    ((key: string) => key) as Awaited<ReturnType<typeof i18n.getFormatter>>,
  );
  vi.spyOn(eventManager, 'emit');
  vi.spyOn(utils, 'uploadRequest').mockResolvedValue({ status: 201, data: {} });
});

it('ends cancelled backup selection without submitting a file or reporting completion', async () => {
  vi.spyOn(picker, 'openFilePicker').mockResolvedValue([]);
  await handleUploadDatabaseBackup();
  expect(utils.uploadRequest).not.toHaveBeenCalled();
  expect(eventManager.emit).toHaveBeenCalledExactlyOnceWith('BackupUpload', { progress: -1, isComplete: false });
});

it('keeps the backup upload file field and progress/completion events', async () => {
  const file = new File(['backup'], 'backup.sql.gz');
  vi.spyOn(picker, 'openFilePicker').mockResolvedValue([file]);
  await handleUploadDatabaseBackup();
  const request = vi.mocked(utils.uploadRequest).mock.calls[0][0];
  expect([...(request.data as FormData).keys()]).toEqual(['file']);
  expect((request.data as FormData).get('file')).toBe(file);
  request.onUploadProgress!({ loaded: 5, total: 10 } as ProgressEvent<XMLHttpRequestEventTarget>);
  expect(eventManager.emit).toHaveBeenCalledWith('BackupUpload', { progress: 0.5, isComplete: false });
  expect(eventManager.emit).toHaveBeenCalledWith('BackupUpload', { progress: 1, isComplete: true });
});
