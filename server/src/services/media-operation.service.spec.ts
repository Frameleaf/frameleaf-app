import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationItemStatus,
  MediaOperationKind,
  MediaOperationStatus,
  Permission,
} from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
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
    result: null,
    progress: 42,
    processedUnits: '420',
    totalUnits: '1000',
    attempt: 1,
    maxAttempts: 3,
    autoRetries: 0,
    retryAt: null,
    claimToken: 'claim-token',
    claimedBy: 'worker-1',
    claimExpiresAt: new Date('2026-09-22T10:00:00.000Z'),
    heartbeatAt: new Date('2026-09-22T09:59:00.000Z'),
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    pauseRequestedAt: null,
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
      requestPause: vi.fn(),
      resume: vi.fn(),
      getAggregates: vi.fn().mockResolvedValue([]),
      getUnreleasedRemoteOperations: vi.fn().mockResolvedValue([]),
      getBulkByRequestId: vi.fn().mockResolvedValue(undefined),
      getActiveRetry: vi.fn().mockResolvedValue(undefined),
      countLockedAssets: vi.fn().mockResolvedValue(0),
      getLockedAssetIds: vi.fn().mockResolvedValue(new Set()),
    } as unknown as MediaOperationRepository;

    sut = new MediaOperationService(mocks.logger as never, repository, mocks.access as never);
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

    it('shows a job waiting for its automatic retry, with when it runs again (FL-104)', async () => {
      vi.mocked(repository.list).mockResolvedValue({
        items: [
          operationStub({
            status: MediaOperationStatus.Queued,
            autoRetries: 1,
            retryAt: new Date('2026-09-22T10:00:30.000Z') as never,
            error: 'The worker stopped responding',
            errorCode: 'worker_lost',
          }),
        ],
        total: 1,
      });

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items[0]).toMatchObject({
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        retryAt: '2026-09-22T10:00:30.000Z',
        errorCode: 'worker_lost',
      });
    });
  });

  describe('Locked media (FL-34)', () => {
    const lockedId = '0195e2a0-0000-7000-8000-0000000000aa';
    const visibleId = '0195e2a0-0000-7000-8000-0000000000bb';

    it('never names an asset that is Locked now to a session that has not unlocked it', async () => {
      const operation = operationStub({ assetId: lockedId, resultAssetId: visibleId });
      vi.mocked(repository.list).mockResolvedValue({ items: [operation], total: 1 });
      vi.mocked(repository.getLockedAssetIds).mockResolvedValue(new Set([lockedId]));

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items[0]).toEqual(expect.objectContaining({ assetId: null, resultAssetId: visibleId }));
      expect(repository.getLockedAssetIds).toHaveBeenCalledWith(authStub.user1.user.id, [lockedId, visibleId]);
    });

    it('leaves Locked items out of a bulk job’s detail and names them again once unlocked', async () => {
      const operation = operationStub({
        kind: MediaOperationKind.Bulk,
        result: {
          items: [
            { id: lockedId, status: MediaOperationItemStatus.Ok },
            { id: visibleId, status: MediaOperationItemStatus.Ok },
          ],
        },
      } as never);
      vi.mocked(repository.getForOwner).mockResolvedValue(operation);
      vi.mocked(repository.getLockedAssetIds).mockResolvedValue(new Set([lockedId]));

      const ordinary = await sut.get(authStub.user1, operation.id);
      expect(ordinary.bulkItems.map(({ id }) => id)).toEqual([visibleId]);

      vi.mocked(repository.getLockedAssetIds).mockClear();
      const elevated = await sut.get(
        { ...authStub.user1, session: { id: 'session-id', hasElevatedPermission: true } } as never,
        operation.id,
      );
      expect(elevated.bulkItems.map(({ id }) => id)).toEqual([lockedId, visibleId]);
      expect(repository.getLockedAssetIds).not.toHaveBeenCalled();
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

    it('cancels a paused job, which has no worker to wait for (FL-104)', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub({ status: MediaOperationStatus.Paused }));
      vi.mocked(repository.requestCancel).mockResolvedValue(
        operationStub({ status: MediaOperationStatus.Cancelled, cancelRequestedAt: new Date() }),
      );

      const result = await sut.cancel(authStub.user1, operationStub().id);

      expect(repository.requestCancel).toHaveBeenCalledWith(operationStub().id, authStub.user1.user.id);
      expect(result.status).toBe(MediaOperationStatus.Cancelled);
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

  describe('pause (FL-104)', () => {
    it('says which kinds can pause on every job it returns', async () => {
      vi.mocked(repository.list).mockResolvedValue({
        items: [operationStub(), operationStub({ kind: MediaOperationKind.StudioPreview })],
        total: 2,
      });

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items.map((item) => item.pausable)).toEqual([true, false]);
      expect(items[0].pauseRequestedAt).toBeNull();
    });

    it('refuses a kind that cannot carry on where it stopped', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        operationStub({ kind: MediaOperationKind.StudioPreview, status: MediaOperationStatus.Queued }),
      );

      await expect(sut.pause(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.requestPause).not.toHaveBeenCalled();
    });

    it('answers not found for another account’s job', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(undefined);

      await expect(sut.pause(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.requestPause).not.toHaveBeenCalled();
    });

    it('holds a queued bulk job at once', async () => {
      const queued = operationStub({ kind: MediaOperationKind.Bulk, status: MediaOperationStatus.Queued });
      vi.mocked(repository.getForOwner).mockResolvedValue(queued);
      vi.mocked(repository.requestPause).mockResolvedValue({
        ...queued,
        status: MediaOperationStatus.Paused,
        pauseRequestedAt: new Date('2026-09-23T10:00:00.000Z'),
      } as never);

      const result = await sut.pause(authStub.user1, queued.id);

      expect(repository.requestPause).toHaveBeenCalledWith(
        queued.id,
        authStub.user1.user.id,
        expect.arrayContaining([MediaOperationKind.Bulk]),
      );
      expect(result.status).toBe(MediaOperationStatus.Paused);
      expect(result.pauseRequestedAt).toBe('2026-09-23T10:00:00.000Z');
    });

    it('reports a running export as still running, with the pause pending, until its worker stops', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());
      vi.mocked(repository.requestPause).mockResolvedValue(
        operationStub({ pauseRequestedAt: new Date('2026-09-23T10:00:00.000Z') as never }),
      );

      const result = await sut.pause(authStub.user1, operationStub().id);

      expect(result.status).toBe(MediaOperationStatus.Rendering);
      expect(result.pauseRequestedAt).toBe('2026-09-23T10:00:00.000Z');
    });

    it('answers an already paused job without writing again', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub({ status: MediaOperationStatus.Paused }));

      const result = await sut.pause(authStub.user1, operationStub().id);

      expect(result.status).toBe(MediaOperationStatus.Paused);
      expect(repository.requestPause).not.toHaveBeenCalled();
    });

    it('refuses a job that is validating, stopping or finished', async () => {
      for (const status of [
        MediaOperationStatus.Validating,
        MediaOperationStatus.Cancelling,
        MediaOperationStatus.Completed,
        MediaOperationStatus.Failed,
      ]) {
        vi.mocked(repository.getForOwner).mockResolvedValue(operationStub({ status }));
        await expect(sut.pause(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(repository.requestPause).not.toHaveBeenCalled();
    });

    it('reports the settled state when the job moved on mid-request', async () => {
      vi.mocked(repository.getForOwner)
        .mockResolvedValueOnce(operationStub())
        .mockResolvedValueOnce(operationStub({ status: MediaOperationStatus.Validating }));
      vi.mocked(repository.requestPause).mockResolvedValue(undefined);

      const result = await sut.pause(authStub.user1, operationStub().id);

      expect(result.status).toBe(MediaOperationStatus.Validating);
    });
  });

  describe('resume (FL-104)', () => {
    it('puts a paused job back in the queue', async () => {
      const paused = operationStub({ status: MediaOperationStatus.Paused, pauseRequestedAt: new Date() as never });
      vi.mocked(repository.getForOwner).mockResolvedValue(paused);
      vi.mocked(repository.resume).mockResolvedValue({
        ...paused,
        status: MediaOperationStatus.Queued,
        pauseRequestedAt: null,
      } as never);

      const result = await sut.resume(authStub.user1, paused.id);

      expect(repository.resume).toHaveBeenCalledWith(paused.id, authStub.user1.user.id);
      expect(result.status).toBe(MediaOperationStatus.Queued);
      expect(result.pauseRequestedAt).toBeNull();
    });

    it('withdraws a pause the worker has not reached yet', async () => {
      const pending = operationStub({ pauseRequestedAt: new Date() as never });
      vi.mocked(repository.getForOwner).mockResolvedValue(pending);
      vi.mocked(repository.resume).mockResolvedValue({ ...pending, pauseRequestedAt: null } as never);

      const result = await sut.resume(authStub.user1, pending.id);

      expect(result.status).toBe(MediaOperationStatus.Rendering);
      expect(result.pauseRequestedAt).toBeNull();
    });

    it('refuses a job that is not paused', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());

      await expect(sut.resume(authStub.user1, operationStub().id)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.resume).not.toHaveBeenCalled();
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

  describe('createBulk', () => {
    const assetIds = [newUuid(), newUuid(), newUuid()];

    beforeEach(() => {
      vi.mocked(repository.create).mockImplementation((value) =>
        Promise.resolve(operationStub({ ...value, status: MediaOperationStatus.Queued, progress: 0 } as never)),
      );
    });

    it('freezes the de-duplicated set, in order, as a queued local job', async () => {
      await sut.createBulk(authStub.user1, {
        action: MediaOperationBulkAction.Favorite,
        assetIds: [assetIds[0], assetIds[1], assetIds[0], assetIds[2]],
        submittedTotal: 4,
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.user1.user.id,
          kind: MediaOperationKind.Bulk,
          destination: MediaOperationDestination.Local,
          totalUnits: '3',
          snapshot: expect.objectContaining({
            action: MediaOperationBulkAction.Favorite,
            assetIds,
            submittedTotal: 4,
            truncated: false,
          }),
        }),
      );
    });

    it('answers a repeated request key with the job it already created', async () => {
      const existing = operationStub({ kind: MediaOperationKind.Bulk, status: MediaOperationStatus.Rendering });
      vi.mocked(repository.getBulkByRequestId).mockResolvedValue(existing);
      const requestId = newUuid();

      const result = await sut.createBulk(authStub.user1, {
        action: MediaOperationBulkAction.Archive,
        assetIds,
        requestId,
      });

      expect(repository.getBulkByRequestId).toHaveBeenCalledWith(authStub.user1.user.id, requestId);
      expect(repository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(existing.id);
    });

    it('queues Library Care actions only from Library Care, whose gates it cannot see (FL-69)', async () => {
      const payload = { mediaHealth: [{ assetId: assetIds[0], findingId: newUuid(), candidateId: newUuid() }] };
      const request = { action: MediaOperationBulkAction.RecoverDamagedMedia, assetIds: [assetIds[0]], payload };

      await expect(sut.createBulk(authStub.user1, request)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();

      await sut.createBulk(authStub.user1, request, { libraryCare: true });
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.Bulk,
          snapshot: expect.objectContaining({ action: MediaOperationBulkAction.RecoverDamagedMedia, payload }),
        }),
      );
    });

    it('refuses an action that is missing its payload', async () => {
      await expect(
        sut.createBulk(authStub.user1, { action: MediaOperationBulkAction.AddToAlbum, assetIds }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses a relative date shift that is not a whole number of minutes', async () => {
      await expect(
        sut.createBulk(authStub.user1, {
          action: MediaOperationBulkAction.ChangeDate,
          assetIds,
          payload: { dateMode: 'shift', minutes: 0 },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an album the account may not add to', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

      await expect(
        sut.createBulk(authStub.user1, {
          action: MediaOperationBulkAction.AddToAlbum,
          assetIds,
          payload: { albumId: newUuid() },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('refuses an API key that does not grant the action', async () => {
      const auth = { ...authStub.user1, apiKey: { id: newUuid(), permissions: [Permission.AssetRead] } };

      await expect(
        sut.createBulk(auth, { action: MediaOperationBulkAction.Delete, assetIds }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('records the submitting API key so the worker can re-check it', async () => {
      const apiKey = { id: newUuid(), permissions: [Permission.AssetDelete] };

      await sut.createBulk({ ...authStub.user1, apiKey }, { action: MediaOperationBulkAction.Delete, assetIds });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ apiKeyId: apiKey.id }) }),
      );
    });

    it('refuses Locked items from a session that has not been unlocked', async () => {
      vi.mocked(repository.countLockedAssets).mockResolvedValue(1);

      await expect(
        sut.createBulk(authStub.user1, { action: MediaOperationBulkAction.Favorite, assetIds }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.countLockedAssets).toHaveBeenCalledWith(authStub.user1.user.id, assetIds);
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('accepts Locked items from an unlocked session', async () => {
      vi.mocked(repository.countLockedAssets).mockResolvedValue(2);
      const auth = { ...authStub.user1, session: { id: newUuid(), hasElevatedPermission: true } };

      await sut.createBulk(auth, {
        action: MediaOperationBulkAction.ChangeLocation,
        assetIds,
        payload: { latitude: 1, longitude: 2 },
      });

      expect(repository.countLockedAssets).not.toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalled();
    });

    it('never runs on a shared link', async () => {
      await expect(
        sut.createBulk(authStub.adminSharedLink, { action: MediaOperationBulkAction.Favorite, assetIds }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('bulk jobs', () => {
    const assetIds = [newUuid(), newUuid(), newUuid(), newUuid()];
    const bulkStub = (overrides: Partial<MediaOperation> = {}) =>
      operationStub({
        kind: MediaOperationKind.Bulk,
        status: MediaOperationStatus.Cancelled,
        snapshot: { action: MediaOperationBulkAction.Favorite, assetIds, payload: {}, truncated: true },
        result: {
          requested: 4,
          succeeded: 1,
          failed: 1,
          skipped: 0,
          items: [
            { id: assetIds[1], status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' },
          ],
          itemsTruncated: false,
          inFlight: null,
        },
        processedUnits: '2',
        totalUnits: '4',
        ...overrides,
      });

    it('reports the running totals on the list', async () => {
      vi.mocked(repository.list).mockResolvedValue({ items: [bulkStub()], total: 1 });

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items[0].bulk).toEqual({
        action: MediaOperationBulkAction.Favorite,
        requested: 4,
        succeeded: 1,
        failed: 1,
        skipped: 0,
        snapshotTruncated: true,
        itemsTruncated: false,
        retried: 0,
      });
    });

    it('counts the items given their automatic retry, from the list’s trimmed result', async () => {
      vi.mocked(repository.list).mockResolvedValue({
        // The list query drops the retry ids and keeps their count.
        items: [bulkStub({ result: { requested: 4, succeeded: 3, retry: { total: 1, processed: 0 } } })],
        total: 1,
      });

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items[0].bulk?.retried).toBe(1);
    });

    it('says which items are still waiting for their automatic retry on the detail view', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({
          status: MediaOperationStatus.Queued,
          processedUnits: '4',
          result: {
            requested: 4,
            succeeded: 2,
            failed: 0,
            skipped: 0,
            items: [],
            retry: { ids: [assetIds[1], assetIds[3]], total: 2, processed: 1 },
          },
        }),
      );

      const result = await sut.get(authStub.user1, bulkStub().id);

      expect(result.bulkRetryPending).toEqual([assetIds[3]]);
    });

    it('leaves the retry list empty for every other kind', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(operationStub());

      await expect(sut.get(authStub.user1, operationStub().id)).resolves.toMatchObject({ bulkRetryPending: [] });
    });

    it('leaves the summary empty for every other kind', async () => {
      vi.mocked(repository.list).mockResolvedValue({ items: [operationStub()], total: 1 });

      const { items } = await sut.search(authStub.user1, {} as never);

      expect(items[0].bulk).toBeNull();
    });

    it('shows a count instead of the frozen id list on the detail view', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(bulkStub());

      const result = await sut.get(authStub.user1, bulkStub().id);

      expect(result.snapshot).not.toHaveProperty('assetIds');
      expect(result.snapshot.assetCount).toBe(4);
      expect(result.bulkItems).toEqual([
        {
          id: assetIds[1],
          status: MediaOperationItemStatus.Failed,
          reasonKey: 'frameleaf_bulk_reason_failed',
          message: null,
        },
      ]);
    });

    it('never names the photos of a duplicate decision job on the detail view (FL-61)', async () => {
      const groups = [
        { duplicateId: 'g1', decision: 'keepers', memberIds: [assetIds[0], assetIds[1]], keepAssetIds: [assetIds[0]] },
      ];
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({
          snapshot: {
            action: MediaOperationBulkAction.ResolveDuplicates,
            assetIds,
            payload: { duplicateGroups: groups },
          },
        }),
      );

      const result = await sut.get(authStub.user1, bulkStub().id);

      expect(result.snapshot.payload).toEqual({ groupCount: 1 });
      expect(JSON.stringify(result.snapshot)).not.toContain(assetIds[1]);
    });

    it('sends a Library Care relink, recovery or trash back to Library Care instead of copying it (FL-69)', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({
          snapshot: { action: MediaOperationBulkAction.TrashDamagedMedia, assetIds, payload: { mediaHealth: [] } },
        }),
      );

      await expect(sut.retry(authStub.user1, bulkStub().id)).rejects.toThrow('Library Care');
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('starts a Library Care scan or search again from Library Care only (FL-69)', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        operationStub({ kind: MediaOperationKind.MediaHealth, status: MediaOperationStatus.Failed }),
      );

      await expect(sut.retry(authStub.user1, operationStub().id)).rejects.toThrow('Library Care');
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('retries only the failed and unreached items, with lineage', async () => {
      const cancelled = bulkStub();
      vi.mocked(repository.getForOwner).mockResolvedValue(cancelled);
      vi.mocked(repository.create).mockImplementation((value) =>
        Promise.resolve(operationStub({ ...value, status: MediaOperationStatus.Queued } as never)),
      );

      await sut.retry(authStub.user1, cancelled.id);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.Bulk,
          retryOfId: cancelled.id,
          totalUnits: '3',
          snapshot: expect.objectContaining({ assetIds: [assetIds[1], assetIds[2], assetIds[3]], requestId: null }),
        }),
      );
    });

    it('includes a batch that was in flight when the job stopped, and items still waiting for their retry', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({
          status: MediaOperationStatus.Failed,
          processedUnits: '2',
          result: {
            requested: 4,
            succeeded: 1,
            failed: 0,
            skipped: 0,
            items: [],
            inFlight: { start: 2, size: 2 },
            retry: { ids: [assetIds[1]], total: 1, processed: 0 },
          },
        }),
      );
      vi.mocked(repository.create).mockImplementation((value) =>
        Promise.resolve(operationStub({ ...value, status: MediaOperationStatus.Queued } as never)),
      );

      await sut.retry(authStub.user1, bulkStub().id);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({ assetIds: [assetIds[1], assetIds[2], assetIds[3]] }),
        }),
      );
    });

    it('carries a relative shift’s recorded starting dates over to the retry', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({
          status: MediaOperationStatus.Failed,
          snapshot: {
            action: MediaOperationBulkAction.ChangeDate,
            assetIds,
            payload: { dateMode: 'shift', minutes: 60 },
            truncated: false,
          },
          processedUnits: '2',
          result: {
            requested: 4,
            succeeded: 2,
            failed: 0,
            skipped: 0,
            items: [],
            inFlight: { start: 2, size: 2 },
            shiftFrom: { [assetIds[2]]: '2026-01-01T10:00:00.000Z', [assetIds[3]]: null },
          },
        }),
      );
      vi.mocked(repository.create).mockImplementation((value) =>
        Promise.resolve(operationStub({ ...value, status: MediaOperationStatus.Queued } as never)),
      );

      await sut.retry(authStub.user1, bulkStub().id);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalUnits: '2',
          result: expect.objectContaining({
            shiftFrom: { [assetIds[2]]: '2026-01-01T10:00:00.000Z', [assetIds[3]]: null },
          }),
        }),
      );
    });

    it('retries a completed job that had failures inside it', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({ status: MediaOperationStatus.Completed, processedUnits: '4' }),
      );
      vi.mocked(repository.create).mockImplementation((value) =>
        Promise.resolve(operationStub({ ...value, status: MediaOperationStatus.Queued } as never)),
      );

      await sut.retry(authStub.user1, bulkStub().id);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ assetIds: [assetIds[1]] }) }),
      );
    });

    it('answers a second retry with the one still running', async () => {
      const running = operationStub({ kind: MediaOperationKind.Bulk, status: MediaOperationStatus.Queued });
      vi.mocked(repository.getForOwner).mockResolvedValue(bulkStub());
      vi.mocked(repository.getActiveRetry).mockResolvedValue(running);

      const result = await sut.retry(authStub.user1, bulkStub().id);

      expect(repository.create).not.toHaveBeenCalled();
      expect(result.id).toBe(running.id);
    });

    it('refuses to retry a job with nothing left to do', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(
        bulkStub({
          status: MediaOperationStatus.Completed,
          processedUnits: '4',
          result: { requested: 4, succeeded: 4, failed: 0, skipped: 0, items: [], itemsTruncated: false },
        }),
      );

      await expect(sut.retry(authStub.user1, bulkStub().id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to retry a bulk job that is still running', async () => {
      vi.mocked(repository.getForOwner).mockResolvedValue(bulkStub({ status: MediaOperationStatus.Rendering }));

      await expect(sut.retry(authStub.user1, bulkStub().id)).rejects.toBeInstanceOf(BadRequestException);
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
