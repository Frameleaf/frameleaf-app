import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { ActivitySession } from '$lib/frameleaf/activity-session.svelte';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, type MediaOperationDto } from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    progress: 10,
    processedUnits: '100',
    totalUnits: '1000',
    attempt: 1,
    maxAttempts: 3,
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    startedAt: '2026-09-22T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-22T09:49:00.000Z',
    updatedAt: '2026-09-22T09:59:00.000Z',
    ...overrides,
  }) as MediaOperationDto;

/**
 * The session is a view of server state, never a driver of it. These check the two things that
 * matter: nothing advances a job locally, and a lost connection leaves the last answer on screen.
 */
describe('ActivitySession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  it('shares one request between concurrent refreshes', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [operation()], total: 1 });
    const session = new ActivitySession();

    await Promise.all([session.refresh(), session.refresh(), session.refresh()]);

    expect(sdkMock.searchMediaOperations).toHaveBeenCalledOnce();
    expect(session.runningCount).toBe(1);
  });

  it('keeps the last answer when the server cannot be reached', async () => {
    sdkMock.searchMediaOperations.mockResolvedValueOnce({ items: [operation()], total: 1 });
    const session = new ActivitySession();
    await session.refresh();

    sdkMock.searchMediaOperations.mockRejectedValueOnce(new Error('offline'));
    await session.refresh();

    expect(session.unreachable).toBe(true);
    expect(session.operations).toHaveLength(1);
    expect(session.runningCount).toBe(1);
  });

  it('stops polling once the last watcher leaves', async () => {
    vi.useFakeTimers();
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [operation()], total: 1 });
    const session = new ActivitySession();

    const stop = session.watch();
    // Let the initial read and its follow-up scheduling settle before the watcher leaves.
    await vi.advanceTimersByTimeAsync(0);
    stop();

    const calls = sdkMock.searchMediaOperations.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sdkMock.searchMediaOperations.mock.calls.length).toBe(calls);
  });

  it('takes the server’s answer to a cancellation rather than deciding for itself', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [operation()], total: 1 });
    sdkMock.cancelMediaOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Cancelling }));
    const session = new ActivitySession();
    await session.refresh();

    await session.cancel(operation().id);

    expect(session.operations[0].status).toBe(MediaOperationStatus.Cancelling);
    // Still counted as running: the worker has not acknowledged the cancellation.
    expect(session.runningCount).toBe(1);
  });

  it('clears only the finished jobs', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({
      items: [
        operation(),
        operation({ id: '0195e2a0-0000-7000-8000-000000000002', status: MediaOperationStatus.Completed }),
        operation({ id: '0195e2a0-0000-7000-8000-000000000003', status: MediaOperationStatus.Failed }),
      ],
      total: 3,
    });
    sdkMock.dismissMediaOperation.mockResolvedValue(undefined as never);
    const session = new ActivitySession();
    await session.refresh();

    await session.dismissFinished();

    expect(sdkMock.dismissMediaOperation).toHaveBeenCalledTimes(2);
    expect(session.operations.map((item) => item.id)).toEqual(['0195e2a0-0000-7000-8000-000000000001']);
  });
});
