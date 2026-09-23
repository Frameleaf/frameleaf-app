import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  QueueName,
  type MediaOperationDto,
  type RunningJobsResponseDto,
} from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { IDLE_POLL_MS, RUNNING_POLL_MS, RunningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';

const operation = (overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    kind: MediaOperationKind.Bulk,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.Local,
    destinationDetail: null,
    label: 'Favorite 400 items',
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

const summary = (overrides: Partial<RunningJobsResponseDto> = {}): RunningJobsResponseDto => ({
  operations: [],
  memoryExports: [],
  queues: [],
  canManageQueues: false,
  ...overrides,
});

/**
 * The session is a view of the server's summary. These check the pace — fast only while there is
 * something to watch — and that every action takes the server's answer rather than deciding.
 */
describe('RunningJobsSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks one route for everything, sharing concurrent refreshes', async () => {
    sdkMock.getRunningJobs.mockResolvedValue(summary({ operations: [operation()] }));
    const session = new RunningJobsSession();

    await Promise.all([session.refresh(), session.refresh()]);

    expect(sdkMock.getRunningJobs).toHaveBeenCalledOnce();
    expect(sdkMock.searchMediaOperations).not.toHaveBeenCalled();
    expect(session.rows).toHaveLength(1);
    expect(session.activeCount).toBe(1);
  });

  it('polls quickly while something runs and backs off once everything settles', async () => {
    sdkMock.getRunningJobs.mockResolvedValueOnce(summary({ operations: [operation()] }));
    const session = new RunningJobsSession();
    const stop = session.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.nextDelay()).toBe(RUNNING_POLL_MS);

    sdkMock.getRunningJobs.mockResolvedValue(summary());
    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS);
    expect(sdkMock.getRunningJobs).toHaveBeenCalledTimes(2);
    expect(session.nextDelay()).toBe(IDLE_POLL_MS);

    // Idle: nothing more until the slow interval has passed.
    await vi.advanceTimersByTimeAsync(RUNNING_POLL_MS * 2);
    expect(sdkMock.getRunningJobs).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS);
    expect(sdkMock.getRunningJobs).toHaveBeenCalledTimes(3);

    stop();
  });

  it('treats everything paused as idle', async () => {
    const paused = operation({ status: MediaOperationStatus.Paused });
    sdkMock.getRunningJobs.mockResolvedValue(summary({ operations: [paused] }));
    const session = new RunningJobsSession();

    await session.refresh();

    expect(session.activeCount).toBe(0);
    expect(session.nextDelay()).toBe(IDLE_POLL_MS);
  });

  it('polls quickly while the panel is open, and asks at once when it opens', async () => {
    sdkMock.getRunningJobs.mockResolvedValue(summary());
    const session = new RunningJobsSession();
    const stop = session.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkMock.getRunningJobs).toHaveBeenCalledTimes(1);

    session.setPanelOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkMock.getRunningJobs).toHaveBeenCalledTimes(2);
    expect(session.nextDelay()).toBe(RUNNING_POLL_MS);

    session.setPanelOpen(false);
    expect(session.nextDelay()).toBe(IDLE_POLL_MS);
    stop();
  });

  it('stops polling once the last watcher leaves', async () => {
    sdkMock.getRunningJobs.mockResolvedValue(summary({ operations: [operation()] }));
    const session = new RunningJobsSession();
    const stop = session.watch();
    await vi.advanceTimersByTimeAsync(0);
    stop();

    const calls = sdkMock.getRunningJobs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 2);

    expect(sdkMock.getRunningJobs.mock.calls.length).toBe(calls);
  });

  it('keeps the last answer when the server cannot be reached', async () => {
    sdkMock.getRunningJobs.mockResolvedValueOnce(summary({ operations: [operation()] }));
    const session = new RunningJobsSession();
    await session.refresh();

    sdkMock.getRunningJobs.mockRejectedValueOnce(new Error('offline'));
    await session.refresh();

    expect(session.unreachable).toBe(true);
    expect(session.rows).toHaveLength(1);
  });

  it('pauses a job through the server and shows its answer', async () => {
    sdkMock.getRunningJobs.mockResolvedValueOnce(summary({ operations: [operation()] }));
    const session = new RunningJobsSession();
    await session.refresh();

    const paused = operation({ status: MediaOperationStatus.Paused, pauseRequestedAt: '2026-09-23T10:00:00.000Z' });
    sdkMock.pauseMediaOperation.mockResolvedValue(paused);
    sdkMock.getRunningJobs.mockResolvedValue(summary({ operations: [paused] }));

    await session.pauseOperation(paused.id);

    expect(sdkMock.pauseMediaOperation).toHaveBeenCalledWith({ id: paused.id });
    expect(session.rows[0]).toMatchObject({ paused: true, control: { kind: 'resume' } });
  });

  it('resumes a job through the server', async () => {
    sdkMock.getRunningJobs.mockResolvedValue(summary());
    sdkMock.resumeMediaOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Queued }));
    const session = new RunningJobsSession();

    await session.resumeOperation(operation().id);

    expect(sdkMock.resumeMediaOperation).toHaveBeenCalledWith({ id: operation().id });
  });

  it('pauses and resumes a server queue through the queue API', async () => {
    const thumbnails = {
      name: QueueName.ThumbnailGeneration,
      isPaused: false,
      canPause: true,
      active: 2,
      waiting: 10,
      processed: 8,
      total: 20,
      startedAt: '2026-09-23T09:40:00.000Z',
    };
    sdkMock.getRunningJobs.mockResolvedValueOnce(summary({ queues: [thumbnails], canManageQueues: true }));
    const session = new RunningJobsSession();
    await session.refresh();

    sdkMock.updateQueue.mockResolvedValue({ name: QueueName.ThumbnailGeneration, isPaused: true } as never);
    sdkMock.getRunningJobs.mockResolvedValue(
      summary({ queues: [{ ...thumbnails, isPaused: true }], canManageQueues: true }),
    );

    await session.setQueuePaused(QueueName.ThumbnailGeneration, true);

    expect(sdkMock.updateQueue).toHaveBeenCalledWith({
      name: QueueName.ThumbnailGeneration,
      queueUpdateDto: { isPaused: true },
    });
    expect(session.rows[0]).toMatchObject({ paused: true, control: { kind: 'resume' } });
  });
});
