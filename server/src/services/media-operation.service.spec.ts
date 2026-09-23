import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const operationStub = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    ownerId: authStub.user1.user.id,
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.Local,
    destinationDetail: null,
    label: 'Summer in the Rockies',
    assetId: null,
    resultAssetId: null,
    retryOfId: null,
    projectId: 'project-1',
    revisionId: 'revision-7',
    snapshot: { engineDigest: 'abc', outputProfile: 'rec709' },
    settings: { resolution: '3840×2160' },
    estimate: { seconds: 300, sizeBytes: '1024' },
    progress: 42,
    processedUnits: '420',
    totalUnits: '1000',
    attempt: 1,
    maxAttempts: 3,
    claimToken: 'claim-token',
    claimedBy: 'worker-1',
    claimExpiresAt: new Date('2026-09-22T10:00:00.000Z'),
    heartbeatAt: new Date('2026-09-22T09:59:00.000Z'),
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    remoteJobId: null,
    remoteReleasedAt: null,
    error: null,
    errorCode: null,
    startedAt: new Date('2026-09-22T09:50:00.000Z'),
    finishedAt: null,
    dismissedAt: null,
    createdAt: new Date('2026-09-22T09:49:00.000Z'),
    updatedAt: new Date('2026-09-22T09:59:00.000Z'),
    updateId: 'update-id',
    ...overrides,
  }) as unknown as MediaOperation;

describe(MediaOperationService.name, () => {
  let sut: MediaOperationService;
  let mocks: ServiceMocks;
  let repository: MediaOperationRepository;

  beforeEach(() => {
    mocks = getMocks();
    repository = {
      create: vi.fn(),
      getForOwner: vi.fn(),
      list: vi.fn(),
      getCheckpoints: vi.fn().mockResolvedValue([]),
      dismiss: vi.fn().mockResolvedValue(true),
      requestCancel: vi.fn(),
      getAggregates: vi.fn().mockResolvedValue([]),
      getUnreleasedRemoteOperations: vi.fn().mockResolvedValue([]),
    } as unknown as MediaOperationRepository;

    sut = new MediaOperationService(mocks.logger as never, repository);
  });

  describe('search', () => {
    it('only ever asks for the signed-in account', async () => {
      vi.mocked(repository.list).mockResolvedValue({ items: [operationStub()], total: 1 });

      const result = await sut.search(authStub.user1, { take: 25, skip: 0 } as never);

      expect(repository.list).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: authStub.user1.user.id, take: 25, skip: 0 }),
      );
      expect(result.total).toBe(1);
    });

    it('hides jobs the owner cleared unless they ask', async () => {
      vi.mocked(repository.list).mockResolvedValue({ items: [], total: 0 });

      await sut.search(authStub.user1, {} as never);

      expect(repository.list).toHaveBeenCalledWith(expect.objectContaining({ includeDismissed: false }));
    });

    it('never leaks the claim token or the worker identity', async () => {
      vi.mocked(repository.list).mockResolvedValue({ items: [operationStub()], total: 1 });

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items[0]).not.toHaveProperty('claimToken');
      expect(items[0]).not.toHaveProperty('claimedBy');
      expect(items[0]).not.toHaveProperty('remoteJobId');
      expect(items[0]).not.toHaveProperty('snapshot');
    });
  });

  describe('get', () => {
    it('answers not found for another account’s job', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(undefined);

      await expect(sut.get(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.getForOwner).toHaveBeenCalledWith(operationStub().id, authStub.user1.user.id);
    });

    it('includes the immutable snapshot and the checkpoints on the detail view', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());
      vi.mocked(repository.getCheckpoints).mockResolvedValue([
        {
          id: '0195e2a0-0000-7000-8000-00000000000a',
          sequence: 0,
          state: 'complete',
          chunkKey: 'key',
          timebase: '30000/1001',
          startTicks: '0',
          endTicks: '1000',
          requiresSequentialContext: false,
          sizeInBytes: '2048',
          completedAt: new Date('2026-09-22T09:55:00.000Z'),
        } as never,
      ]);

      const result = await sut.get(authStub.user1, operationStub().id);

      expect(result.snapshot).toEqual({ engineDigest: 'abc', outputProfile: 'rec709' });
      expect(result.checkpoints).toHaveLength(1);
      expect(result.checkpoints[0].chunkKey).toBe('key');
    });
  });

  describe('cancel', () => {
    it('refuses to cancel a job that already finished', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub({ status: MediaOperationStatus.Completed }));

      await expect(sut.cancel(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.requestCancel).not.toHaveBeenCalled();
    });

    it('reports cancelling while the worker has not acknowledged', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());
      vi.mocked(repository.requestCancel).mockResolvedValue(
        operationStub({ status: MediaOperationStatus.Cancelling, cancelRequestedAt: new Date() }),
      );

      const result = await sut.cancel(authStub.user1, operationStub().id);

      expect(result.status).toBe(MediaOperationStatus.Cancelling);
      expect(result.cancelAcknowledgedAt).toBeNull();
    });

    it('reports the settled state when the job finished mid-request', async () => {
      vi.mocked(repository.getForOwner)
        .mockResolvedValueOnce(operationStub())
        .mockResolvedValueOnce(operationStub({ status: MediaOperationStatus.Completed }));
      vi.mocked(repository.requestCancel).mockResolvedValue(undefined);

      const result = await sut.cancel(authStub.user1, operationStub().id);

      expect(result.status).toBe(MediaOperationStatus.Completed);
    });
  });

  describe('retry', () => {
    it('refuses to retry a running job', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());

      await expect(sut.retry(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('copies the snapshot and destination into a new row and records the lineage', async () => {
      const failed = operationStub({ status: MediaOperationStatus.Failed, destination: MediaOperationDestination.RunPod });
      vi.mocked(repository.getForOwner).mockResolvedValue(failed);
      vi.mocked(repository.create).mockResolvedValue(
        operationStub({
          id: '0195e2a0-0000-7000-8000-000000000002',
          status: MediaOperationStatus.Queued,
          destination: MediaOperationDestination.RunPod,
          retryOfId: failed.id,
          progress: 0,
        }),
      );

      const result = await sut.retry(authStub.user1, failed.id);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          retryOfId: failed.id,
          destination: MediaOperationDestination.RunPod,
          snapshot: failed.snapshot,
          resultAssetId: null,
        }),
      );
      expect(result.retryOfId).toBe(failed.id);
      expect(result.status).toBe(MediaOperationStatus.Queued);
    });
  });

  describe('dismiss', () => {
    it('refuses to clear a running job', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());

      await expect(sut.dismiss(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.dismiss).not.toHaveBeenCalled();
    });

    it('clears a finished job', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub({ status: MediaOperationStatus.Failed }));

      await sut.dismiss(authStub.user1, operationStub().id);

      expect(repository.dismiss).toHaveBeenCalledWith(operationStub().id, authStub.user1.user.id);
    });
  });

  describe('getStatistics', () => {
    it('returns counts without any owner or media detail', async () => {
      vi.mocked(repository.getAggregates).mockResolvedValue([
        {
          kind: MediaOperationKind.StudioExport,
          status: MediaOperationStatus.Rendering,
          destination: MediaOperationDestination.RunPod,
          count: 3,
          oldestQueuedAt: new Date('2026-09-22T09:00:00.000Z'),
        },
        {
          kind: MediaOperationKind.Restoration,
          status: MediaOperationStatus.Failed,
          destination: MediaOperationDestination.Local,
          count: 2,
          oldestQueuedAt: null,
        },
      ]);
      vi.mocked(repository.getUnreleasedRemoteOperations).mockResolvedValue([operationStub()]);

      const result = await sut.getStatistics();

      expect(result.active).toBe(3);
      expect(result.failed).toBe(2);
      expect(result.unreleasedRemote).toBe(1);
      for (const bucket of result.buckets) {
        expect(bucket).not.toHaveProperty('ownerId');
        expect(bucket).not.toHaveProperty('label');
        expect(bucket).not.toHaveProperty('assetId');
      }
    });
  });
});
