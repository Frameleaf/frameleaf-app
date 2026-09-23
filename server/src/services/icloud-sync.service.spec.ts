import { ICloudConfigSchema, ICloudConnectionUpdateDto } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, JobName, MediaOperationKind, MediaOperationStatus, NotificationLevel } from 'src/enum.js';
import { ICloudTransportError } from 'src/repositories/icloud-transport.repository.js';
import {
  ICLOUD_IDLE_WAIT_MS,
  ICLOUD_MAX_IDLE_WAITS,
  ICLOUD_SIGN_IN_WAIT_MS,
  ICloudSyncService,
  mapICloudRun,
} from 'src/services/icloud-sync.service.js';

describe(ICloudSyncService.name, () => {
  const connection = {
    id: 'connection',
    ownerId: 'owner',
    label: 'Photos',
    state: 'connected',
    config: ICloudConfigSchema.parse({}),
    encryptedSession: 'ciphertext',
    lastError: null as string | null,
    nextRunAt: null as Date | null,
  };
  const resource = {
    id: 'resource',
    ownerId: 'owner',
    connectionId: 'connection',
    leaseToken: 'lease',
    status: 'pending',
    expectedSize: 4,
    source: { originalFileName: 'renamed.jpg', type: AssetType.Image, isHidden: true },
    pendingJobs: [],
  };
  const operation = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'run',
      ownerId: 'owner',
      kind: MediaOperationKind.ICloudSync,
      status: MediaOperationStatus.Preparing,
      label: 'Photos',
      snapshot: { connectionId: 'connection', trigger: 'schedule' },
      result: null,
      progress: 0,
      processedUnits: '0',
      totalUnits: null,
      autoRetries: 0,
      retryAt: null,
      pauseRequestedAt: null,
      errorCode: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date('2026-09-23T10:00:00.000Z'),
      ...overrides,
    }) as never;
  const repository = {
    refreshResource: vi.fn(),
    invalidateCursor: vi.fn(),
    block: vi.fn(),
    finalize: vi.fn(),
    defer: vi.fn(),
    counts: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    startRun: vi.fn(),
    withSession: vi.fn(),
    checkpoint: vi.fn(),
    inventory: vi.fn(),
    savePage: vi.fn(),
    claim: vi.fn(),
    resource: vi.fn(),
    finish: vi.fn(),
    clearOutbox: vi.fn(),
    hasPending: vi.fn(),
    completeRun: vi.fn(),
    update: vi.fn(),
    admitAuth: vi.fn(),
    latestOperation: vi.fn(),
    queueOperation: vi.fn(),
    endRun: vi.fn(),
    notify: vi.fn(),
    disconnect: vi.fn(),
    reviewItems: vi.fn(),
    receipts: vi.fn(),
  };
  const transport = { decodeSession: vi.fn(), encodeSession: vi.fn(), authenticate: vi.fn(), enabled: vi.fn() };
  const staging = { download: vi.fn(), cleanup: vi.fn(), root: vi.fn() };
  const recovery = { verifyMapped: vi.fn(), reconcile: vi.fn() };
  const jobs = { queue: vi.fn() };
  const albums = { reconcile: vi.fn() };
  const operations = {
    claimNext: vi.fn(),
    reportProgress: vi.fn(),
    setBulkResult: vi.fn(),
    heartbeat: vi.fn(),
    beginValidation: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    requeue: vi.fn(),
    settlePause: vi.fn(),
    acknowledgeCancel: vi.fn(),
    requestPause: vi.fn(),
    requestCancel: vi.fn(),
    resume: vi.fn(),
  };
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const working = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };
  let sut: ICloudSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    repository.get.mockResolvedValue(connection);
    repository.withSession.mockImplementation(async (_id, _owner, callback) => {
      const result = await callback(connection);
      return result.value;
    });
    repository.checkpoint.mockResolvedValue({ complete: true });
    // a run that ends closes its run record
    repository.endRun.mockResolvedValue(undefined);
    repository.inventory.mockResolvedValue({ libraries: [], albums: [] });
    repository.claim.mockReset();
    repository.claim.mockResolvedValueOnce(resource).mockResolvedValue(undefined);
    repository.resource.mockResolvedValue({
      ...resource,
      status: 'committed',
      pendingJobs: [{ name: JobName.AssetGenerateThumbnails, data: { id: 'same-asset' } }],
    });
    repository.hasPending.mockResolvedValue(false);
    repository.counts.mockResolvedValue({ resources: 2, finalized: 1, pending: 1 });
    repository.latestOperation.mockResolvedValue(undefined);
    repository.list.mockResolvedValue([]);
    repository.notify.mockResolvedValue(undefined);
    staging.download.mockResolvedValue('/private/complete');
    recovery.verifyMapped.mockResolvedValue(undefined);
    recovery.reconcile.mockResolvedValue({ outcome: 'repaired-missing', assetId: 'same-asset' });
    jobs.queue.mockResolvedValue(undefined);
    albums.reconcile.mockResolvedValue(true);
    repository.finalize.mockImplementation(async (_resource, cleanup) => {
      await cleanup();
      return true;
    });
    transport.enabled.mockReturnValue(true);
    operations.reportProgress.mockResolvedValue(true);
    operations.setBulkResult.mockResolvedValue(working);
    operations.heartbeat.mockResolvedValue(true);
    operations.beginValidation.mockResolvedValue(true);
    operations.complete.mockResolvedValue(true);
    operations.fail.mockResolvedValue('failed');
    operations.requeue.mockResolvedValue(true);
    operations.acknowledgeCancel.mockResolvedValue(true);
    sut = new ICloudSyncService(
      repository as never,
      transport as never,
      staging as never,
      recovery as never,
      jobs as never,
      {} as never,
      albums as never,
      albums as never,
      {} as never,
      albums as never,
      operations as never,
      logger as never,
    );
  });

  it('patches only supplied config fields and validates the merged settings', async () => {
    const auth = { user: { id: 'owner' }, session: { hasElevatedPermission: true } } as never;
    const config = ICloudConfigSchema.parse({
      libraries: ['selected-library'],
      albums: ['selected-album'],
      includeHidden: true,
      includeEdits: false,
      recoverExternalAsManaged: true,
      concurrency: 3,
      stagingBytes: 40 * 1024 ** 3,
    });
    repository.get.mockResolvedValue({ ...connection, config });
    const dto = ICloudConnectionUpdateDto.schema.parse({ config: { intervalHours: 12 } });
    expect(dto.config).toEqual({ intervalHours: 12 });
    await sut.update(auth, connection.id, dto);
    expect(repository.update).toHaveBeenLastCalledWith(connection.id, connection.ownerId, {
      config: { ...config, intervalHours: 12 },
    });

    await sut.update(
      auth,
      connection.id,
      ICloudConnectionUpdateDto.schema.parse({ config: { albums: [], includeHidden: false } }),
    );
    expect(repository.update).toHaveBeenLastCalledWith(connection.id, connection.ownerId, {
      config: { ...config, albums: [], includeHidden: false },
    });
    expect(ICloudConnectionUpdateDto.schema.safeParse({ config: { typo: true } }).success).toBe(false);

    repository.update.mockClear();
    await expect(sut.update({ user: { id: 'owner' }, session: {} } as never, connection.id, dto)).rejects.toThrow(
      'Elevated permission is required',
    );
    expect(repository.update).not.toHaveBeenCalled();
    vi.stubEnv('IMMICH_ICLOUD_MAX_CONCURRENCY', '2');
    try {
      await expect(sut.update(auth, connection.id, dto)).rejects.toThrow('icloud_admin_limit_exceeded');
      expect(repository.update).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never returns the stored Apple session, only whether one exists', async () => {
    repository.list.mockResolvedValue([connection]);
    const response = await sut.list({ user: { id: 'owner' }, session: {} } as never);
    expect(response.connections[0].authenticated).toBe(true);
    expect(JSON.stringify(response)).not.toContain('ciphertext');
  });

  it('keeps an account to twenty connections, counted under the insert lock', async () => {
    repository.create.mockResolvedValue(undefined);
    const config = ICloudConfigSchema.parse({});
    await expect(
      sut.create({ user: { id: 'owner' }, session: {} } as never, { label: 'Another', config }),
    ).rejects.toThrow('icloud_connection_limit');
    expect(repository.create).toHaveBeenCalledWith('owner', 'Another', config, 20);
  });

  describe('a durable run', () => {
    it('recovers a damaged unchanged mapping, forwards hidden visibility and only cleans after durable outbox dispatch', async () => {
      await sut.run(operation(), 'token');
      expect(recovery.verifyMapped).toHaveBeenCalledOnce();
      expect(staging.download).toHaveBeenCalledOnce();
      expect(recovery.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: 'resource',
          stagedPath: '/private/complete',
          sourceHidden: true,
          originalFileName: 'renamed.jpg',
        }),
      );
      expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.AssetGenerateThumbnails, data: { id: 'same-asset' } });
      expect(staging.cleanup.mock.invocationCallOrder[0]).toBeGreaterThan(
        repository.clearOutbox.mock.invocationCallOrder[0],
      );
      expect(repository.finalize).toHaveBeenCalledWith(resource, expect.any(Function));
      expect(repository.completeRun).toHaveBeenCalledOnce();
      expect(operations.complete).toHaveBeenCalledWith('run', 'token', { resultAssetId: null });
    });

    it('records real progress from resources settled out of those known, never an invented figure', async () => {
      await sut.run(operation(), 'token');
      expect(operations.setBulkResult).toHaveBeenCalledWith(
        'run',
        'token',
        expect.objectContaining({ processedUnits: 1, totalUnits: 2, progress: 50 }),
      );
    });

    it('avoids transfer only after verified reuse and preserves intentionally trashed mappings', async () => {
      recovery.verifyMapped.mockResolvedValue({ outcome: 'reused', assetId: 'same-asset' });
      await sut.run(operation(), 'token');
      expect(staging.download).not.toHaveBeenCalled();
      expect(recovery.reconcile).not.toHaveBeenCalled();
      expect(staging.cleanup).toHaveBeenCalledTimes(1);
      expect(repository.finalize).toHaveBeenCalledWith(resource, expect.any(Function));
      staging.cleanup.mockClear();
      repository.claim.mockResolvedValueOnce(resource);
      recovery.verifyMapped.mockResolvedValue({ outcome: 'preserve-trashed', reason: 'destination_not_active' });
      await sut.run(operation(), 'token');
      expect(repository.finish).toHaveBeenLastCalledWith(resource, 'preserve-trashed', 'destination_not_active');
      expect(staging.cleanup).not.toHaveBeenCalled();
    });

    it('retains committed state and good staging when follow-up dispatch fails', async () => {
      jobs.queue.mockRejectedValueOnce(new Error('queue unavailable'));
      await sut.run(operation(), 'token');
      expect(staging.cleanup).not.toHaveBeenCalled();
      expect(repository.clearOutbox).not.toHaveBeenCalled();
      expect(repository.finish).toHaveBeenCalledWith(resource, 'committed', 'icloud_transfer_failed');
    });

    it('preserves upload source and notification flags when dispatching the durable outbox', async () => {
      const pendingJobs = [
        { name: JobName.AssetExtractMetadata, data: { id: 'same-asset', source: 'upload' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: 'same-asset', source: 'upload', notify: true } },
      ];
      repository.resource.mockResolvedValue({ ...resource, status: 'committed', pendingJobs });
      await sut.run(operation(), 'token');
      for (const job of pendingJobs) {
        expect(jobs.queue).toHaveBeenCalledWith(job);
      }
    });

    it('refreshes changed resources without consuming the invalid cursor reset budget', async () => {
      staging.download.mockRejectedValueOnce(new ICloudTransportError('resource_changed'));
      repository.resource.mockResolvedValueOnce(resource);
      await sut.run(operation(), 'token');
      expect(repository.finish).toHaveBeenCalledWith(resource, 'retry', 'resource_changed');
      expect(repository.refreshResource).toHaveBeenCalledWith(resource);
      expect(repository.invalidateCursor).not.toHaveBeenCalled();
      expect(repository.block).not.toHaveBeenCalled();
    });

    it('waits out a reset change token without spending an attempt or failing the run', async () => {
      repository.withSession.mockRejectedValueOnce(new ICloudTransportError('invalid_change_token'));
      await sut.run(operation(), 'token');
      expect(repository.invalidateCursor).toHaveBeenCalledWith('connection', 'owner');
      expect(repository.refreshResource).not.toHaveBeenCalled();
      expect(operations.requeue).toHaveBeenCalledWith('run', 'token', {
        delayMs: ICLOUD_IDLE_WAIT_MS,
        returnAttempt: true,
      });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('waits for the provider back-off after a rate limit', async () => {
      repository.withSession.mockRejectedValueOnce(new ICloudTransportError('rate_limited'));
      const later = new Date(Date.now() + 60_000);
      repository.get
        .mockResolvedValueOnce(connection)
        .mockResolvedValueOnce(connection)
        .mockResolvedValueOnce({ ...connection, nextRunAt: later });
      await sut.run(operation(), 'token');
      expect(repository.defer).toHaveBeenCalledWith('connection', 'owner', 'rate_limited');
      const options = operations.requeue.mock.calls[0][2];
      expect(options.returnAttempt).toBe(true);
      expect(options.delayMs).toBeGreaterThan(0);
      expect(options.delayMs).toBeLessThanOrEqual(60_000);
    });

    it('hands the run back while only backed-off items remain', async () => {
      repository.claim.mockReset();
      repository.claim.mockResolvedValue(undefined);
      repository.hasPending.mockResolvedValue(true);
      await sut.run(operation(), 'token');
      expect(operations.requeue).toHaveBeenCalledWith('run', 'token', {
        delayMs: ICLOUD_IDLE_WAIT_MS,
        returnAttempt: true,
      });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(repository.completeRun).not.toHaveBeenCalled();
    });

    it('fails with the account reason and leaves the notification to the connection', async () => {
      repository.get.mockResolvedValue({ ...connection, state: 'reauthentication-required' });
      await sut.run(operation(), 'token');
      expect(operations.fail).toHaveBeenCalledWith('run', 'token', {
        error: 'reauthentication_required',
        errorCode: 'reauthentication_required',
      });
      expect(repository.notify).not.toHaveBeenCalled();
      expect(staging.download).not.toHaveBeenCalled();
    });

    it('reports an operational failure once its automatic retry is spent, with the code only', async () => {
      repository.withSession.mockRejectedValueOnce(new Error('bridge said: secret-token-123'));
      repository.get
        .mockResolvedValueOnce(connection)
        .mockResolvedValueOnce(connection)
        .mockResolvedValue({ ...connection, state: 'error', lastError: 'icloud_operation_failed' });
      await sut.run(operation(), 'token');
      expect(repository.block).toHaveBeenCalledWith('connection', 'owner', 'error', 'icloud_operation_failed');
      expect(operations.fail).toHaveBeenCalledWith('run', 'token', {
        error: 'icloud_operation_failed',
        errorCode: 'icloud_operation_failed',
      });
      expect(repository.notify).toHaveBeenCalledWith(
        'owner',
        NotificationLevel.Error,
        expect.any(String),
        expect.not.stringContaining('secret-token-123'),
      );
    });

    it('gives an operational error one real second attempt on the automatic retry', async () => {
      repository.get
        .mockResolvedValueOnce({ ...connection, state: 'error', lastError: 'icloud_operation_failed' })
        .mockResolvedValue(connection);
      await sut.run(operation({ autoRetries: 1 }), 'token');
      expect(repository.update).toHaveBeenCalledWith('connection', 'owner', { state: 'connected', lastError: null });
      expect(operations.complete).toHaveBeenCalled();
    });

    it('stops at the next boundary when its owner cancels, and closes the run record', async () => {
      operations.setBulkResult.mockResolvedValue({ ...working, status: MediaOperationStatus.Cancelling });
      await sut.run(operation(), 'token');
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run', 'token', { released: false });
      expect(repository.endRun).toHaveBeenCalledWith('connection', 'cancelled');
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('hands the claim back at the next boundary when its owner pauses', async () => {
      operations.setBulkResult.mockResolvedValue({ ...working, pauseRequestedAt: new Date() });
      operations.settlePause.mockResolvedValue(true);
      await sut.run(operation(), 'token');
      expect(operations.settlePause).toHaveBeenCalledWith('run', 'token');
      expect(repository.claim).toHaveBeenCalledTimes(1);
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('waits, without spending an attempt, while its owner is signing in again', async () => {
      repository.get.mockResolvedValue({ ...connection, state: 'authenticating' });
      await sut.run(operation(), 'token');
      expect(operations.requeue).toHaveBeenCalledWith('run', 'token', {
        delayMs: ICLOUD_SIGN_IN_WAIT_MS,
        returnAttempt: true,
      });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('reports a run that cannot move for a day instead of waiting forever', async () => {
      repository.claim.mockReset();
      repository.claim.mockResolvedValue(undefined);
      repository.hasPending.mockResolvedValue(true);
      await sut.run(operation({ result: { phase: 'waiting', idleWaits: ICLOUD_MAX_IDLE_WAITS } }), 'token');
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith('run', 'token', {
        error: 'icloud_sync_stalled',
        errorCode: 'icloud_sync_stalled',
      });
      expect(repository.endRun).toHaveBeenCalledWith('connection', 'failed');
    });

    it('fails a run whose connection is gone without touching the provider', async () => {
      repository.get.mockResolvedValue(undefined);
      await sut.run(operation(), 'token');
      expect(operations.fail).toHaveBeenCalledWith('run', 'token', {
        error: 'icloud_connection_unavailable',
        errorCode: 'icloud_connection_unavailable',
      });
      expect(repository.withSession).not.toHaveBeenCalled();
    });
  });

  describe('controls', () => {
    const auth = { user: { id: 'owner' }, session: {} } as never;

    it('queues a run through the locked path and wakes a worker', async () => {
      repository.queueOperation.mockResolvedValue({ outcome: 'created', operation: operation() });
      await sut.control(auth, 'connection', { action: 'run' });
      expect(repository.queueOperation).toHaveBeenCalledWith('connection', 'owner', {
        trigger: 'manual',
        retryOfId: null,
      });
      expect(jobs.queue).toHaveBeenCalledWith({ name: JobName.ICloudSync, data: { id: 'connection' } });
    });

    it('refuses a retry or rescan beside an unfinished run and asks for the account when signed out', async () => {
      repository.queueOperation.mockResolvedValue({ outcome: 'busy', operation: operation() });
      await expect(sut.control(auth, 'connection', { action: 'rescan' })).rejects.toThrow('icloud_run_active');
      repository.queueOperation.mockResolvedValue({ outcome: 'not-ready' });
      await expect(sut.control(auth, 'connection', { action: 'retry' })).rejects.toThrow('icloud_sign_in_required');
    });

    it('retries as a new run that records the one it follows', async () => {
      const failed = operation({ status: MediaOperationStatus.Failed });
      repository.latestOperation.mockImplementation((_id, _owner, options) =>
        Promise.resolve(options?.activeOnly ? undefined : failed),
      );
      repository.queueOperation.mockResolvedValue({ outcome: 'created', operation: operation() });
      await sut.control(auth, 'connection', { action: 'retry' });
      expect(repository.queueOperation).toHaveBeenCalledWith('connection', 'owner', {
        trigger: 'retry',
        retryOfId: 'run',
      });
    });

    it('pauses and cancels the unfinished run, and refuses when there is none', async () => {
      await expect(sut.control(auth, 'connection', { action: 'pause' })).rejects.toThrow('icloud_no_active_run');
      await expect(sut.control(auth, 'connection', { action: 'cancel' })).rejects.toThrow('icloud_no_active_run');

      const active = operation({ status: MediaOperationStatus.Queued });
      repository.latestOperation.mockResolvedValue(active);
      operations.requestPause.mockResolvedValue(operation({ status: MediaOperationStatus.Paused }));
      await sut.control(auth, 'connection', { action: 'pause' });
      expect(operations.requestPause).toHaveBeenCalledWith('run', 'owner', [MediaOperationKind.ICloudSync]);

      operations.requestCancel.mockResolvedValue(operation({ status: MediaOperationStatus.Cancelled }));
      await sut.control(auth, 'connection', { action: 'cancel' });
      expect(operations.requestCancel).toHaveBeenCalledWith('run', 'owner');
      expect(repository.endRun).toHaveBeenCalledWith('connection', 'cancelled');
    });

    it('disconnects under the lock first, then cancels the last run there can be', async () => {
      repository.latestOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Rendering }));
      operations.requestCancel.mockResolvedValue(operation({ status: MediaOperationStatus.Cancelling }));
      await sut.disconnect(auth, 'connection');
      expect(repository.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        operations.requestCancel.mock.invocationCallOrder[0],
      );
      expect(operations.requestCancel).toHaveBeenCalledWith('run', 'owner');
    });

    it('explains why a connection cannot be removed yet and releases only staging copies', async () => {
      const remove = vi.fn();
      (repository as Record<string, unknown>).remove = remove;
      remove.mockResolvedValue('still-connected');
      await expect(sut.remove(auth, 'connection')).rejects.toThrow('icloud_disconnect_first');
      remove.mockResolvedValue('in-flight');
      await expect(sut.remove(auth, 'connection')).rejects.toThrow('icloud_remove_in_flight');
      remove.mockImplementation(async (_id, _owner, cleanup) => {
        await cleanup([resource]);
        return 'removed';
      });
      await sut.remove(auth, 'connection');
      expect(staging.cleanup).toHaveBeenCalledWith(resource);
    });
  });

  describe('sign-in', () => {
    it('rejects cross-owner and insecure credential submission before calling Apple, and redacts provider errors', async () => {
      const auth = { user: { id: 'owner' }, session: {} } as never;
      const dto = { action: 'login', appleId: 'user@example.test', password: 'private-password' } as const;
      await expect(sut.authenticate(auth, 'connection', dto, false)).rejects.toThrow('icloud_requires_https');
      expect(transport.authenticate).not.toHaveBeenCalled();
      repository.get.mockResolvedValueOnce(undefined);
      await expect(sut.authenticate(auth, 'other-connection', dto, true)).rejects.toThrow();
      expect(transport.authenticate).not.toHaveBeenCalled();
      repository.admitAuth.mockResolvedValue(true);
      transport.authenticate.mockRejectedValue(new ICloudTransportError('reauthentication_required'));
      const response = await sut.authenticate(auth, 'connection', dto, true);
      expect(repository.block).toHaveBeenCalledWith(
        'connection',
        'owner',
        'reauthentication-required',
        'reauthentication_required',
      );
      expect(JSON.stringify(response)).not.toContain('private-password');
      expect(repository.queueOperation).not.toHaveBeenCalled();
    });

    it('queues a run once the account is connected, and not while a code is awaited', async () => {
      const auth = { user: { id: 'owner' }, session: {} } as never;
      repository.admitAuth.mockResolvedValue(true);
      transport.authenticate.mockResolvedValue({ state: 'awaiting-2fa', session: {} });
      repository.get.mockResolvedValue({ ...connection, state: 'awaiting-2fa' });
      await sut.authenticate(auth, 'connection', { action: 'login', appleId: 'a@example.test', password: 'x' }, true);
      expect(repository.queueOperation).not.toHaveBeenCalled();

      transport.authenticate.mockResolvedValue({ state: 'connected', session: {} });
      repository.get.mockResolvedValue(connection);
      repository.queueOperation.mockResolvedValue({ outcome: 'created', operation: operation() });
      await sut.authenticate(auth, 'connection', { action: 'two-factor', code: '123456' }, true);
      expect(repository.queueOperation).toHaveBeenCalledWith('connection', 'owner', {
        trigger: 'authenticated',
        retryOfId: null,
      });
    });
  });

  it('shows a waiting run apart from one retrying after a failure, by the same rule as Activity', () => {
    const retryAt = new Date();
    expect(mapICloudRun(operation({ status: MediaOperationStatus.Queued, retryAt, autoRetries: 0 }))).toMatchObject({
      waiting: true,
      retrying: false,
    });
    expect(mapICloudRun(operation({ status: MediaOperationStatus.Queued, retryAt, autoRetries: 1 }))).toMatchObject({
      waiting: false,
      retrying: true,
    });
  });
});
