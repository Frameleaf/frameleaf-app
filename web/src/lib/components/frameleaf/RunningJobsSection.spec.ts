import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  QueueName,
  type MediaOperationDto,
  type QueueRunDto,
} from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RunningJobsSection from '$lib/components/frameleaf/RunningJobsSection.svelte';
import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';

const operation = (overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.Local,
    destinationDetail: null,
    label: 'Summer in the Rockies',
    assetId: null,
    resultAssetId: null,
    retryOfId: null,
    projectId: null,
    revisionId: null,
    settings: {},
    estimate: null,
    bulk: null,
    progress: 30,
    processedUnits: '120',
    totalUnits: '400',
    attempt: 1,
    maxAttempts: 3,
    autoRetries: 0,
    retryAt: null,
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    pausable: true,
    pauseRequestedAt: null,
    startedAt: '2026-09-23T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-23T09:49:00.000Z',
    updatedAt: '2026-09-23T09:59:00.000Z',
    ...overrides,
  }) as MediaOperationDto;

const thumbnails: QueueRunDto = {
  name: QueueName.ThumbnailGeneration,
  isPaused: false,
  canPause: true,
  active: 4,
  waiting: 96,
  processed: 300,
  total: 400,
  startedAt: '2026-09-23T09:40:00.000Z',
};

/**
 * The section's contract: every row carries a labelled progress bar with real values and a labelled
 * pause/play control; a job that cannot pause still shows the control, disabled, with the reason.
 */
describe('Frameleaf running jobs in the notifications panel', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    runningJobsSession.summary = { operations: [], memoryExports: [], queues: [], canManageQueues: false };
    runningJobsSession.unreachable = false;
  });

  it('shows nothing when nothing is running', () => {
    render(RunningJobsSection);

    expect(screen.queryByRole('heading', { name: 'Running now' })).not.toBeInTheDocument();
  });

  it('gives each job a progress bar with done, total and a readable value', () => {
    runningJobsSession.summary = { ...runningJobsSession.summary, operations: [operation()] };
    render(RunningJobsSection);

    const bar = screen.getByRole('progressbar', { name: 'Progress of “Summer in the Rockies”' });
    expect(bar).toHaveAttribute('aria-valuenow', '120');
    expect(bar).toHaveAttribute('aria-valuemax', '400');
    expect(bar).toHaveAttribute('aria-valuetext', '120 of 400 done, 30%');
  });

  it('pauses a job through the server from its labelled control', async () => {
    runningJobsSession.summary = { ...runningJobsSession.summary, operations: [operation()] };
    sdkMock.pauseMediaOperation.mockResolvedValue(operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' }));
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' })],
      memoryExports: [],
      queues: [],
      canManageQueues: false,
    });
    render(RunningJobsSection);

    await fireEvent.click(screen.getByRole('button', { name: 'Pause “Summer in the Rockies”' }));

    expect(sdkMock.pauseMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000001' });
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resume “Summer in the Rockies”' })).toBeInTheDocument(),
    );
  });

  it('shows the control disabled, with the reason, for a job that cannot pause', async () => {
    runningJobsSession.summary = {
      ...runningJobsSession.summary,
      operations: [operation({ kind: MediaOperationKind.StudioPreview, pausable: false })],
    };
    render(RunningJobsSection);

    const control = screen.getByRole('button', { name: 'Pause “Summer in the Rockies”' });
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).toHaveAccessibleDescription("This kind of job runs in one go and can't be paused");

    await fireEvent.click(control);
    expect(sdkMock.pauseMediaOperation).not.toHaveBeenCalled();
  });

  it('shows an administrator the server queues and pauses one through the queue API', async () => {
    runningJobsSession.summary = { ...runningJobsSession.summary, queues: [thumbnails], canManageQueues: true };
    sdkMock.updateQueue.mockResolvedValue({ name: QueueName.ThumbnailGeneration, isPaused: true } as never);
    sdkMock.getRunningJobs.mockResolvedValue({
      operations: [],
      memoryExports: [],
      queues: [{ ...thumbnails, isPaused: true }],
      canManageQueues: true,
    });
    render(RunningJobsSection);

    expect(screen.getByRole('progressbar', { name: 'Progress of “Thumbnails”' })).toHaveAttribute(
      'aria-valuenow',
      '300',
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Pause “Thumbnails”' }));

    expect(sdkMock.updateQueue).toHaveBeenCalledWith({
      name: QueueName.ThumbnailGeneration,
      queueUpdateDto: { isPaused: true },
    });
  });

  it('never shows queues to somebody who may not manage them', () => {
    runningJobsSession.summary = { ...runningJobsSession.summary, queues: [thumbnails], canManageQueues: false };
    render(RunningJobsSection);

    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
