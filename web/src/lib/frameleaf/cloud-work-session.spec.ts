import { CloudBackupRunState, CloudBackupTask, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { CLOUD_WORK_IDLE_POLL_MS, CloudWorkSession } from '$lib/frameleaf/cloud-work-session.svelte';

const running = {
  activeRun: {
    operationId: 'op-1',
    task: CloudBackupTask.Backup,
    state: CloudBackupRunState.Running,
    progress: 40,
    uploaded: 3,
    bytesUploaded: 10,
  },
  activeRestore: null,
} as unknown as CloudBackupStatusResponseDto;

describe('CloudWorkSession', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it('shows the run in progress as a cloud row, and nothing when the status cannot be read', async () => {
    const session = new CloudWorkSession();
    sdkMock.getCloudBackupStatus.mockResolvedValue(running);
    await session.refresh();
    expect(session.rows.map((row) => row.operationId)).toEqual(['op-1']);

    sdkMock.getCloudBackupStatus.mockRejectedValue(new Error('unavailable'));
    await session.refresh();
    expect(session.status).toBeNull();
    expect(session.rows).toEqual([]);
  });

  it('shares one timer between watchers and stops when the last one leaves', async () => {
    vi.useFakeTimers();
    sdkMock.getCloudBackupStatus.mockResolvedValue(null as never);
    const session = new CloudWorkSession();
    const stopA = session.watch();
    const stopB = session.watch();
    await vi.advanceTimersByTimeAsync(0);
    const asked = sdkMock.getCloudBackupStatus.mock.calls.length;

    await vi.advanceTimersByTimeAsync(CLOUD_WORK_IDLE_POLL_MS);
    expect(sdkMock.getCloudBackupStatus.mock.calls.length).toBe(asked + 1);

    stopA();
    stopB();
    await vi.advanceTimersByTimeAsync(CLOUD_WORK_IDLE_POLL_MS * 2);
    expect(sdkMock.getCloudBackupStatus.mock.calls.length).toBe(asked + 1);
  });
});
