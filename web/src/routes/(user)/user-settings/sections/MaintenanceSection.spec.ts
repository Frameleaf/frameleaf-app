import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import MaintenanceSection from './MaintenanceSection.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings?area=maintenance') } }));

const queue = (isActive: boolean, waiting = 0) =>
  ({
    integrityCheck: {
      jobCounts: { active: isActive ? 1 : 0, waiting, delayed: 0, paused: 0, completed: 0, failed: 0 },
      queueStatus: { isActive, isPaused: false },
    },
  }) as never;

const summary = { untracked_file: 0, missing_file: 0, checksum_mismatch: 0 };

describe('MaintenanceSection integrity polling (FL-81)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sdkMock.getIntegrityReportSummary.mockResolvedValue(summary);
    sdkMock.getIntegrityCheckRuns.mockResolvedValue({
      untracked_file: null,
      missing_file: null,
      checksum_mismatch: null,
    });
    sdkMock.getServerVersion.mockResolvedValue({ major: 1, minor: 0, patch: 0 } as never);
    sdkMock.listDatabaseBackups.mockResolvedValue({ backups: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-reads the summary only once queued checks have run, not while they wait', async () => {
    sdkMock.getQueuesLegacy
      .mockResolvedValueOnce(queue(true))
      .mockResolvedValueOnce(queue(false, 2))
      .mockResolvedValue(queue(false));

    render(MaintenanceSection, { section: 'integrity' });
    expect(await screen.findByRole('article', { name: 'Untracked Files' })).toBeInTheDocument();
    expect(sdkMock.getIntegrityReportSummary).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000); // active
    await vi.advanceTimersByTimeAsync(2000); // queued, not active yet
    expect(sdkMock.getIntegrityReportSummary).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000); // done
    expect(sdkMock.getIntegrityReportSummary).toHaveBeenCalledTimes(2);
  });

  it('shows the integrity checks even when the backups cannot be listed', async () => {
    sdkMock.getQueuesLegacy.mockResolvedValue(queue(false));
    sdkMock.listDatabaseBackups.mockRejectedValue(new Error('500'));

    render(MaintenanceSection, { section: 'integrity' });

    expect(await screen.findByRole('article', { name: 'Untracked Files' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says the backups could not be loaded in the backups section', async () => {
    sdkMock.getQueuesLegacy.mockResolvedValue(queue(false));
    sdkMock.listDatabaseBackups.mockRejectedValue(new Error('500'));

    render(MaintenanceSection, { section: 'backups' });

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_cc_load_failed);
  });

  it('re-reads the summary after a check started before the first poll finishes', async () => {
    sdkMock.getQueuesLegacy.mockResolvedValue(queue(false));
    sdkMock.createJob.mockResolvedValue(undefined as never);

    render(MaintenanceSection, { section: 'integrity' });
    const card = await screen.findByRole('article', { name: 'Untracked Files' });
    await fireEvent.click(within(card).getByRole('button', { name: en.admin.frameleaf_maintenance_run_check }));
    await vi.waitFor(() => expect(sdkMock.createJob).toHaveBeenCalled());
    expect(sdkMock.getIntegrityReportSummary).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(sdkMock.getIntegrityReportSummary).toHaveBeenCalledTimes(2);
  });
});
