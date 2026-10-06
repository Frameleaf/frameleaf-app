import { CloudBackupRunState, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudBackgroundWork from './CloudBackgroundWork.svelte';
import CloudWorkControls from './CloudWorkControls.svelte';

const ID = '0195e2a0-0000-7000-8000-00000000beef';
const answer = {} as CloudBackupStatusResponseDto;

const status = (overrides: Partial<CloudBackupStatusResponseDto> = {}) =>
  ({
    activeRun: null,
    activeRestore: null,
    target: 'byo-s3',
    ...overrides,
  }) as CloudBackupStatusResponseDto;

describe('CloudWorkControls (FL-164)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.pauseCloudBackupRun.mockResolvedValue(answer);
    sdkMock.resumeCloudBackupRun.mockResolvedValue(answer);
    sdkMock.cancelCloudBackupRun.mockResolvedValue(answer);
  });

  it('pauses a running backup and hands the new status back', async () => {
    const onStatus = vi.fn();
    render(CloudWorkControls, {
      operationId: ID,
      runState: CloudBackupRunState.Running,
      title: 'Cloud backup',
      onStatus,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(sdkMock.pauseCloudBackupRun).toHaveBeenCalledWith({ id: ID }));
    expect(onStatus).toHaveBeenCalledWith(answer);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('resumes a paused run', async () => {
    render(CloudWorkControls, {
      operationId: ID,
      runState: CloudBackupRunState.Paused,
      title: 'Cloud backup',
      onStatus: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sdkMock.resumeCloudBackupRun).toHaveBeenCalledWith({ id: ID }));
  });

  it('asks before cancelling a restore, and cancels only when confirmed', async () => {
    render(CloudWorkControls, {
      operationId: ID,
      runState: CloudBackupRunState.Running,
      title: 'Restore from cloud backup',
      restore: true,
      onStatus: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    let dialog = await screen.findByRole('dialog', { name: 'Cancel Restore from cloud backup?' });
    expect(within(dialog).getByText(/Files already restored stay where they are/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep going' }));
    expect(sdkMock.cancelCloudBackupRun).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    dialog = await screen.findByRole('dialog', { name: 'Cancel Restore from cloud backup?' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(sdkMock.cancelCloudBackupRun).toHaveBeenCalledWith({ id: ID }));
  });

  it('offers nothing while the run is cancelling, and shows why an action failed', async () => {
    const { unmount } = render(CloudWorkControls, {
      operationId: ID,
      runState: CloudBackupRunState.Cancelling,
      title: 'Cloud backup',
      onStatus: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    unmount();

    sdkMock.pauseCloudBackupRun.mockRejectedValue(new Error('offline'));
    render(CloudWorkControls, {
      operationId: ID,
      runState: CloudBackupRunState.Queued,
      title: 'Cloud backup',
      onStatus: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('CloudBackgroundWork (FL-164)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => vi.clearAllMocks());

  it('shows nothing while no backup work is in progress', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(status());
    render(CloudBackgroundWork);
    await waitFor(() => expect(sdkMock.getCloudBackupStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('cloud-background-work')).toBeNull();
  });

  it('lists a paused backup run with Resume and Cancel', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(
      status({
        activeRun: {
          operationId: ID,
          state: CloudBackupRunState.Paused,
          task: 'backup',
          phase: 'assets',
          progress: 40,
          checked: 0,
          uploaded: 12,
          skipped: 3,
          bytesUploaded: 1_000_000,
        } as never,
      }),
    );
    sdkMock.resumeCloudBackupRun.mockResolvedValue(status());
    render(CloudBackgroundWork);

    const work = await screen.findByTestId('cloud-background-work');
    const controls = within(work).getByRole('group', { name: 'Cloud backup controls' });
    await fireEvent.click(within(controls).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(sdkMock.resumeCloudBackupRun).toHaveBeenCalledWith({ id: ID }));
    // the answer has nothing in progress, so the group goes away
    await waitFor(() => expect(screen.queryByTestId('cloud-background-work')).toBeNull());
  });

  it('stays empty when cloud backup cannot be read', async () => {
    sdkMock.getCloudBackupStatus.mockRejectedValue(new Error('nope'));
    render(CloudBackgroundWork);
    await waitFor(() => expect(sdkMock.getCloudBackupStatus).toHaveBeenCalled());
    expect(screen.queryByTestId('cloud-background-work')).toBeNull();
  });
});
