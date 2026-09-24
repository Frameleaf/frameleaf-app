import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import MaintenanceBackupsPanel from './MaintenanceBackupsPanel.svelte';

const handleCreateJob = vi.fn();
vi.mock('$lib/services/job.service', () => ({ handleCreateJob: (...args: unknown[]) => handleCreateJob(...args) }));

const queue = (failed: number, isActive: boolean, active = 0) =>
  ({
    backupDatabase: {
      jobCounts: { failed, active, waiting: 0, delayed: 0, paused: 0, completed: 0 },
      queueStatus: { isActive, isPaused: false },
    },
  }) as never;

describe('MaintenanceBackupsPanel (CC-17)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    handleCreateJob.mockResolvedValue(true);
    sdkMock.listDatabaseBackups.mockResolvedValue({ backups: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops the running row and offers Retry when the backup job fails', async () => {
    sdkMock.getQueuesLegacy.mockResolvedValueOnce(queue(0, false)).mockResolvedValue(queue(1, false));
    render(MaintenanceBackupsPanel, { backups: [], expectedVersion: '1.0.0', pollMs: 5 });

    await fireEvent.click(screen.getByRole('button', { name: 'Create backup now' }));

    expect(await screen.findByText(en.admin.frameleaf_maintenance_backups_failed)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create backup now' })).toBeEnabled();

    sdkMock.getQueuesLegacy.mockResolvedValueOnce(queue(1, false)).mockResolvedValue(queue(1, true, 1));
    sdkMock.listDatabaseBackups.mockResolvedValue({
      backups: [{ filename: 'immich-db-backup-20260924T070000-v1.0.0-pg14.sql.gz', filesize: 10, timezone: 'UTC' }],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(handleCreateJob).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(en.admin.frameleaf_maintenance_backups_failed)).not.toBeInTheDocument(),
    );
  });
});
