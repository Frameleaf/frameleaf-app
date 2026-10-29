import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BackupLocalPage from '$lib/components/frameleaf/backup/BackupLocalPage.svelte';
import en from '../../../../../../i18n/en.json';

const handleCreateJob = vi.fn();
vi.mock('$lib/services/job.service', () => ({ handleCreateJob: (...args: unknown[]) => handleCreateJob(...args) }));

const queue = (failed: number, isActive: boolean, active = isActive ? 1 : 0) =>
  ({
    name: 'backupDatabase',
    isPaused: false,
    hasUnfinishedWork: active > 0,
    statistics: { failed, active, waiting: 0, delayed: 0, paused: 0, completed: 0 },
  }) as never;

describe('Backup › On this server (FL-362)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    handleCreateJob.mockResolvedValue(true);
    sdkMock.getServerVersion.mockResolvedValue({ major: 1, minor: 0, patch: 0 } as never);
    sdkMock.listDatabaseBackups.mockResolvedValue({ backups: [] });
  });

  it('says plainly that a snapshot is not a backup of the photos', async () => {
    render(BackupLocalPage);
    expect(await screen.findByText(en.frameleaf_backup_local_not_photos)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'On this server' })).toBeInTheDocument();
    expect(await screen.findByText('First backup not finished')).toBeInTheDocument();
  });

  it('stops waiting and offers to try again when the snapshot fails, then takes one', async () => {
    sdkMock.getQueue.mockResolvedValueOnce(queue(0, false)).mockResolvedValue(queue(1, false));
    render(BackupLocalPage, { pollMs: 5 });
    const take = () => screen.getByRole('button', { name: en.frameleaf_backup_local_take });

    await fireEvent.click(take());
    expect(await screen.findByText(en.frameleaf_backup_local_failed)).toBeInTheDocument();
    expect(take()).toBeEnabled();

    sdkMock.getQueue.mockResolvedValueOnce(queue(1, false)).mockResolvedValue(queue(1, true, 1));
    sdkMock.listDatabaseBackups.mockResolvedValue({
      backups: [{ filename: 'frameleaf-db-backup-20260924T070000-v1.0.0-pg19.sql.gz', filesize: 10, timezone: 'UTC' }],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(handleCreateJob).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(en.frameleaf_backup_local_failed)).not.toBeInTheDocument());
    // Only the backup queue is read while waiting, never every queue.
    expect(sdkMock.getQueue).toHaveBeenCalledWith({ name: 'backupDatabase' });
    expect(sdkMock.getQueuesLegacy).not.toHaveBeenCalled();
  });

  it('offers to try again when the saved snapshots cannot be listed', async () => {
    sdkMock.listDatabaseBackups.mockRejectedValue(new Error('500'));
    render(BackupLocalPage);
    expect(await screen.findByText(en.frameleaf_cc_section_load_failed)).toBeInTheDocument();
  });
});
