import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  type MediaOperationDto,
} from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { ActivitySession } from '$lib/frameleaf/activity-session.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

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
    autoRetries: 0,
    retryAt: null,
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    pausable: true,
    pauseRequestedAt: null,
    startedAt: '2026-09-22T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-22T09:49:00.000Z',
    updatedAt: '2026-09-22T09:59:00.000Z',
    withheld: false,
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

  it('never tries to clear a paused job, which has not finished (FL-104)', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({
      items: [
        operation({ status: MediaOperationStatus.Paused }),
        operation({ id: '0195e2a0-0000-7000-8000-000000000002', status: MediaOperationStatus.Completed }),
      ],
      total: 2,
    });
    sdkMock.dismissMediaOperation.mockResolvedValue(undefined as never);
    const session = new ActivitySession();
    await session.refresh();

    await session.dismissFinished();

    expect(sdkMock.dismissMediaOperation).toHaveBeenCalledOnce();
    expect(sdkMock.dismissMediaOperation).toHaveBeenCalledWith({ id: '0195e2a0-0000-7000-8000-000000000002' });
    expect(session.operations.map((item) => item.status)).toEqual([MediaOperationStatus.Paused]);
  });

  it('takes the server’s answer to a pause: pausing until the worker stops (FL-104)', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [operation()], total: 1 });
    sdkMock.pauseMediaOperation.mockResolvedValue(operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' }));
    const session = new ActivitySession();
    await session.refresh();

    await session.pause(operation().id);

    expect(sdkMock.pauseMediaOperation).toHaveBeenCalledWith({ id: operation().id });
    expect(session.operations[0]).toMatchObject({
      status: MediaOperationStatus.Rendering,
      pauseRequestedAt: '2026-09-23T10:00:00.000Z',
    });
  });

  it('asks again the moment the browser is back online, recovering the exact jobs (FL-43)', async () => {
    sdkMock.searchMediaOperations.mockRejectedValueOnce(new Error('offline'));
    const session = new ActivitySession();
    const stop = session.watch();
    await vi.waitFor(() => expect(session.unreachable).toBe(true));

    const recovered = operation({ status: MediaOperationStatus.Validating, progress: 97 });
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [recovered], total: 1 });
    dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(session.unreachable).toBe(false));
    expect(session.operations).toEqual([recovered]);
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(2);

    stop();
    dispatchEvent(new Event('online'));
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(2);
  });

  it('asks again when the server’s socket reconnects, recovering the exact jobs (FL-43)', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [operation()], total: 1 });
    const session = new ActivitySession();
    const stop = session.watch();
    await vi.waitFor(() => expect(session.operations).toEqual([operation()]));

    // While the socket was down the job moved on; the reconnect reads where it got to.
    const moved = operation({ status: MediaOperationStatus.Validating, progress: 98, processedUnits: '980' });
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [moved], total: 1 });
    eventManager.emit('WebsocketConnect');

    await vi.waitFor(() => expect(session.operations).toEqual([moved]));
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(2);

    stop();
    eventManager.emit('WebsocketConnect');
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(2);
  });

  it('reads the list again when the server says a job changed, once for a burst (FL-43)', async () => {
    vi.useFakeTimers();
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [], total: 0 });
    const session = new ActivitySession();
    const stop = session.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(1);

    const queued = operation({ status: MediaOperationStatus.Queued, progress: 0, processedUnits: '0' });
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [queued], total: 1 });
    eventManager.emit('MediaOperationUpdate', { id: queued.id });
    eventManager.emit('MediaOperationUpdate', { id: queued.id });
    eventManager.emit('MediaOperationUpdate', { id: queued.id });
    await vi.advanceTimersByTimeAsync(300);

    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(2);
    expect(session.operations).toEqual([queued]);

    stop();
    eventManager.emit('MediaOperationUpdate', { id: queued.id });
    await vi.advanceTimersByTimeAsync(300);
    expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(2);
  });

  it('recovers every unfinished job after a reload, exactly as the server kept it (FL-43)', async () => {
    // The server lists unfinished jobs first, so an old running job is on the first page.
    const old = operation({
      id: '0195e2a0-0000-7000-8000-000000000010',
      kind: MediaOperationKind.QuickEdit,
      settings: { edit: 'photo_version' },
      status: MediaOperationStatus.Rendering,
      progress: 60,
      processedUnits: '60',
      totalUnits: '100',
      createdAt: '2026-09-01T09:00:00.000Z',
    });
    const finished = Array.from({ length: 3 }, (_, index) =>
      operation({ id: `0195e2a0-0000-7000-8000-00000000002${index}`, status: MediaOperationStatus.Completed }),
    );
    sdkMock.searchMediaOperations.mockResolvedValue({ items: [old, ...finished], total: 150 });

    // A reload is a new session: nothing survives in the tab, everything comes from the server.
    const reloaded = new ActivitySession();
    await reloaded.refresh();

    expect(sdkMock.searchMediaOperations).toHaveBeenCalledWith({ take: 100 });
    expect(reloaded.operations[0]).toEqual(old);
    expect(reloaded.runningCount).toBe(1);
  });

  it('puts a resumed job back as the server answered (FL-104)', async () => {
    sdkMock.searchMediaOperations.mockResolvedValue({
      items: [operation({ status: MediaOperationStatus.Paused })],
      total: 1,
    });
    sdkMock.resumeMediaOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Queued }));
    const session = new ActivitySession();
    await session.refresh();

    await session.resume(operation().id);

    expect(sdkMock.resumeMediaOperation).toHaveBeenCalledWith({ id: operation().id });
    expect(session.operations[0].status).toBe(MediaOperationStatus.Queued);
  });
});
