import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MemoryExportFormat,
  MemoryExportStatus,
  Permission,
  QueueName,
} from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { RUNNING_OPERATIONS_LIMIT, RunningJobService } from 'src/services/running-job.service.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const operationStub = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    ownerId: authStub.user1.user.id,
    kind: MediaOperationKind.Bulk,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.Local,
    destinationDetail: null,
    label: 'Favorite 120 items',
    assetId: null,
    resultAssetId: null,
    retryOfId: null,
    projectId: null,
    revisionId: null,
    snapshot: { action: 'favorite' },
    settings: {},
    estimate: null,
    result: null,
    progress: 25,
    processedUnits: '30',
    totalUnits: '120',
    attempt: 1,
    maxAttempts: 3,
    autoRetries: 0,
    retryAt: null,
    claimToken: 'claim-token',
    claimedBy: 'worker-1',
    claimExpiresAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    pauseRequestedAt: null,
    remoteJobId: null,
    remoteReleasedAt: null,
    error: null,
    errorCode: null,
    startedAt: new Date('2026-09-23T09:50:00.000Z'),
    finishedAt: null,
    dismissedAt: null,
    createdAt: new Date('2026-09-23T09:49:00.000Z'),
    updatedAt: new Date('2026-09-23T09:59:00.000Z'),
    updateId: 'update-id',
    ...overrides,
  }) as unknown as MediaOperation;

const exportRun = (overrides: Record<string, unknown> = {}) => ({
  id: newUuid(),
  ownerId: authStub.user1.user.id,
  memoryId: newUuid(),
  title: 'Summer 2026',
  format: MemoryExportFormat.Archive,
  status: MemoryExportStatus.Running,
  assetIds: [] as string[],
  assetCount: 40,
  processedAssets: 12,
  path: null,
  sizeInBytes: null,
  error: null,
  cancelRequestedAt: null,
  startedAt: new Date('2026-09-23T09:55:00.000Z'),
  finishedAt: null,
  expiresAt: null,
  createdAt: new Date('2026-09-23T09:54:00.000Z'),
  updatedAt: new Date('2026-09-23T09:56:00.000Z'),
  ...overrides,
});

const idle = {
  active: 0,
  waiting: 0,
  processed: 0,
  startedAt: null,
  lastProgressAt: null,
  workerAvailable: true,
  delayed: 0,
  paused: 0,
  blocked: 0,
  retrying: 0,
  noDispatchBacklog: false,
};

describe(RunningJobService.name, () => {
  let sut: RunningJobService;
  let mocks: ServiceMocks;
  let operations: MediaOperationRepository;

  beforeEach(() => {
    mocks = getMocks();
    operations = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      getLockedAssetIds: vi.fn().mockResolvedValue(new Set()),
    } as unknown as MediaOperationRepository;
    mocks.memory.searchExports.mockResolvedValue([]);
    mocks.job.observeQueueRun.mockResolvedValue(idle);
    mocks.job.isPaused.mockResolvedValue(false);
    // The real service over a mocked repository: the summary must read jobs exactly as Activity does.
    const operationService = new MediaOperationService(
      mocks.logger as never,
      operations,
      mocks.access as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    sut = new RunningJobService(mocks.logger as never, mocks.job as never, operationService, mocks.memory as never);
  });

  describe('the viewer’s own work', () => {
    it('reads only the signed-in account’s unfinished operations, paused ones included', async () => {
      vi.mocked(operations.list).mockResolvedValue({
        items: [operationStub(), operationStub({ status: MediaOperationStatus.Paused })],
        total: 2,
      });

      const result = await sut.getRunning(authStub.user1);

      expect(operations.list).toHaveBeenCalledWith({
        ownerId: authStub.user1.user.id,
        statuses: ACTIVE_MEDIA_OPERATION_STATUSES,
        includeDismissed: false,
        take: RUNNING_OPERATIONS_LIMIT,
        skip: 0,
      });
      expect(ACTIVE_MEDIA_OPERATION_STATUSES).toContain(MediaOperationStatus.Paused);
      expect(result.operations.map((operation) => operation.status)).toEqual([
        MediaOperationStatus.Rendering,
        MediaOperationStatus.Paused,
      ]);
      expect(result.operations[0]).toMatchObject({ pausable: true, processedUnits: '30', totalUnits: '120' });
      expect(result.operations[0]).not.toHaveProperty('claimToken');
    });

    it('withholds a Locked asset id from a session that has not unlocked it (FL-34)', async () => {
      const lockedId = newUuid();
      vi.mocked(operations.list).mockResolvedValue({
        items: [operationStub({ kind: MediaOperationKind.Restoration, assetId: lockedId })],
        total: 1,
      });
      vi.mocked(operations.getLockedAssetIds).mockResolvedValue(new Set([lockedId]));

      const result = await sut.getRunning(authStub.user1);

      expect(operations.getLockedAssetIds).toHaveBeenCalledWith(authStub.user1.user.id, [lockedId]);
      expect(result.operations[0].assetId).toBeNull();
    });

    it('includes the account’s highlight exports that are still being written', async () => {
      mocks.memory.searchExports.mockResolvedValue([exportRun()] as never);

      const result = await sut.getRunning(authStub.user1);

      expect(mocks.memory.searchExports).toHaveBeenCalledWith(authStub.user1.user.id, {
        status: [MemoryExportStatus.Pending, MemoryExportStatus.Running, MemoryExportStatus.Cancelling],
      });
      expect(result.memoryExports).toHaveLength(1);
      expect(result.memoryExports[0]).toMatchObject({ assetCount: 40, processedAssets: 12 });
    });

    it('leaves highlight exports out for an API key that may not read memories', async () => {
      const auth = { ...authStub.user1, apiKey: { id: 'key', permissions: [Permission.AssetRead] } } as never;

      const result = await sut.getRunning(auth);

      expect(mocks.memory.searchExports).not.toHaveBeenCalled();
      expect(result.memoryExports).toEqual([]);
    });
  });

  describe('server queues', () => {
    it('never reads the server queues for somebody who is not an administrator', async () => {
      const result = await sut.getRunning(authStub.user1);

      expect(result.queues).toEqual([]);
      expect(result.canManageQueues).toBe(false);
      expect(mocks.job.observeQueueRun).not.toHaveBeenCalled();
      expect(mocks.job.isPaused).not.toHaveBeenCalled();
    });

    it('never reads them for an administrator’s API key that may not read queues', async () => {
      const auth = { ...authStub.admin, apiKey: { id: 'key', permissions: [Permission.AssetRead] } } as never;

      const result = await sut.getRunning(auth);

      expect(result.canManageQueues).toBe(false);
      expect(mocks.job.observeQueueRun).not.toHaveBeenCalled();
    });

    it('shows an administrator every queue with work, with the progress of its run', async () => {
      mocks.job.observeQueueRun.mockImplementation((name: QueueName) =>
        Promise.resolve(
          name === QueueName.ThumbnailGeneration
            ? { ...idle, active: 4, waiting: 96, processed: 300, startedAt: new Date('2026-09-23T09:40:00.000Z') }
            : idle,
        ),
      );

      const result = await sut.getRunning(authStub.admin);

      expect(result.canManageQueues).toBe(true);
      expect(result.queues).toEqual([
        {
          name: QueueName.ThumbnailGeneration,
          isPaused: false,
          canPause: true,
          active: 4,
          waiting: 96,
          processed: 300,
          total: 400,
          startedAt: '2026-09-23T09:40:00.000Z',
          unavailable: false,
          state: 'running',
          noDispatchBacklog: false,
          lastProgressAt: null,
        },
      ]);
      expect(mocks.job.observeQueueRun).toHaveBeenCalledTimes(Object.values(QueueName).length);
    });

    it('shows a paused queue that is holding work, so it can be resumed', async () => {
      mocks.job.observeQueueRun.mockImplementation((name: QueueName) =>
        Promise.resolve(name === QueueName.SmartSearch ? { ...idle, waiting: 12, startedAt: new Date() } : idle),
      );
      mocks.job.isPaused.mockImplementation((name: QueueName) => Promise.resolve(name === QueueName.SmartSearch));

      const result = await sut.getRunning(authStub.admin);

      expect(result.queues).toEqual([expect.objectContaining({ name: QueueName.SmartSearch, isPaused: true })]);
    });

    it('marks a queue that cannot be paused', async () => {
      mocks.job.observeQueueRun.mockImplementation((name: QueueName) =>
        Promise.resolve(name === QueueName.BackgroundTask ? { ...idle, active: 1, startedAt: new Date() } : idle),
      );

      const result = await sut.getRunning(authStub.admin);

      expect(result.queues).toEqual([expect.objectContaining({ name: QueueName.BackgroundTask, canPause: false })]);
    });

    it('reports an unavailable queue without losing the viewer’s other work', async () => {
      vi.mocked(operations.list).mockResolvedValue({ items: [operationStub()], total: 1 });
      mocks.job.observeQueueRun.mockImplementation((name: QueueName) =>
        name === QueueName.Ocr ? Promise.reject(new Error('private database diagnostic')) : Promise.resolve(idle),
      );

      const result = await sut.getRunning(authStub.admin);

      expect(result.queues).toEqual([
        expect.objectContaining({ name: QueueName.Ocr, unavailable: true, state: 'unavailable', canPause: false }),
      ]);
      expect(result.operations).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private database diagnostic');
    });
  });
  describe('durable run authority is separate from queue authority', () => {
    it('never reads runs for another account or an administrator key without JobRead', async () => {
      await sut.getRunning(authStub.user1);
      const auth = { ...authStub.admin, apiKey: { id: 'key', permissions: [Permission.QueueRead] } } as never;
      const result = await sut.getRunning(auth);
      expect(result.canManageQueues).toBe(true);
      expect(result.canReadJobRuns).toBe(false);
      expect(result.durableRuns).toEqual([]);
      expect(mocks.job.listRuns).not.toHaveBeenCalled();
    });
    it('reads durable summaries for JobRead without reading queues for a key lacking QueueRead', async () => {
      const auth = { ...authStub.admin, apiKey: { id: 'key', permissions: [Permission.JobRead] } } as never;
      const result = await sut.getRunning(auth);
      expect(result.canReadJobRuns).toBe(true);
      expect(result.canManageQueues).toBe(false);
      expect(mocks.job.listRuns).toHaveBeenCalledWith(25, 0);
      expect(mocks.job.observeQueueRun).not.toHaveBeenCalled();
    });
    it('keeps own work when the durable history lookup fails and does not expose diagnostics', async () => {
      vi.mocked(operations.list).mockResolvedValue({ items: [operationStub()], total: 1 });
      mocks.job.listRuns.mockRejectedValue(new Error('secret payload diagnostics'));
      const result = await sut.getRunning(authStub.admin);
      expect(result.operations).toHaveLength(1);
      expect(result.durableRunsUnavailable).toBe(true);
      expect(result.canReadJobRuns).toBe(true);
      expect(JSON.stringify([result, mocks.logger.warn.mock.calls])).not.toContain('secret payload diagnostics');
    });
  });
});
