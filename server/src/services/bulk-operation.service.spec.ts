import { BadRequestException } from '@nestjs/common';
import {
  AssetVisibility,
  DuplicateDecisionKind,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
  MediaOperationKind,
  MediaOperationStatus,
} from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { BulkOperationService } from 'src/services/bulk-operation.service.js';
import { BulkOperationSnapshot } from 'src/utils/bulk-operation.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const ownerId = authStub.user1.user.id;

const snapshotOf = (overrides: Partial<BulkOperationSnapshot> = {}): BulkOperationSnapshot => ({
  action: MediaOperationBulkAction.Favorite,
  assetIds: [newUuid(), newUuid(), newUuid()],
  payload: {},
  submittedTotal: null,
  truncated: false,
  requestId: null,
  apiKeyId: null,
  ...overrides,
});

const operationOf = (snapshot: BulkOperationSnapshot, overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: '0195e2a0-0000-7000-8000-0000000000b1',
    ownerId,
    kind: MediaOperationKind.Bulk,
    status: MediaOperationStatus.Preparing,
    snapshot,
    result: null,
    processedUnits: '0',
    totalUnits: String(snapshot.assetIds.length),
    ...overrides,
  }) as unknown as MediaOperation;

describe(BulkOperationService.name, () => {
  let sut: BulkOperationService;
  let mocks: ServiceMocks;
  let operations: MediaOperationRepository;
  let assets: {
    updateAll: any;
    shiftDateTimeOriginalFrom: any;
    run: any;
    deleteAll: any;
    lock: any;
    notifyVisibilityChanged: any;
  };
  let albums: { addAssets: any; removeAssets: any };
  let tags: { bulkTagAssets: any; removeAssets: any };
  let trash: { restoreAssets: any };
  let stacks: { create: any; deleteAll: any };
  let enrichment: { updateAssetEnrichment: any; unlockAssets: any };
  let users: { get: any; getMetadata: any };
  let apiKeys: { getById: any };
  let livePhoto: { relinkOne: any };
  let duplicateDecisions: { applyGroup: any; undoGroup: any; getLockedIds: any };
  let mediaHealth: { applyBulkEntry: any };
  let classification: { applyBulkBatch: any };
  let archiveOperations: { publish: any; restore: any; skipUnreached: any };

  const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

  beforeEach(() => {
    mocks = getMocks();
    operations = {
      claimNext: vi.fn().mockResolvedValue(undefined),
      recoverExpiredClaims: vi
        .fn()
        .mockResolvedValue({ requeued: 0, retried: 0, failed: 0, abandonedCancels: 0, paused: 0 }),
      setBulkResult: vi.fn().mockResolvedValue(running),
      reportProgress: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
      getDateTimeOriginals: vi.fn().mockResolvedValue(new Map()),
      getLockedIds: vi.fn().mockResolvedValue(new Set()),
    } as unknown as MediaOperationRepository;
    assets = {
      updateAll: vi.fn().mockResolvedValue(undefined),
      shiftDateTimeOriginalFrom: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(undefined),
      notifyVisibilityChanged: vi.fn().mockResolvedValue(undefined),
    };
    albums = { addAssets: vi.fn(), removeAssets: vi.fn() };
    tags = { bulkTagAssets: vi.fn().mockResolvedValue({ count: 0 }), removeAssets: vi.fn() };
    trash = { restoreAssets: vi.fn().mockResolvedValue({ count: 0 }) };
    stacks = { create: vi.fn(), deleteAll: vi.fn() };
    enrichment = {
      updateAssetEnrichment: vi.fn().mockResolvedValue({}),
      unlockAssets: vi.fn().mockResolvedValue(undefined),
    };
    users = { get: vi.fn().mockResolvedValue({ ...authStub.user1.user }), getMetadata: vi.fn().mockResolvedValue([]) };
    apiKeys = { getById: vi.fn() };
    livePhoto = { relinkOne: vi.fn().mockResolvedValue({ success: true }) };
    duplicateDecisions = {
      applyGroup: vi.fn(),
      undoGroup: vi.fn(),
      getLockedIds: vi.fn().mockResolvedValue(new Set()),
    };
    mediaHealth = {
      applyBulkEntry: vi
        .fn()
        .mockImplementation((_auth, _action, entry) => Promise.resolve({ id: entry.assetId, status: 'ok' })),
    };

    classification = {
      applyBulkBatch: vi
        .fn()
        .mockImplementation((_auth, _ruleId, ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, status: 'ok' }))),
        ),
    };

    archiveOperations = { publish: vi.fn(), restore: vi.fn(), skipUnreached: vi.fn().mockResolvedValue(0) };

    sut = new BulkOperationService(
      mocks.logger as never,
      operations,
      mocks.access as never,
      users as never,
      apiKeys as never,
      assets as never,
      albums as never,
      tags as never,
      trash as never,
      stacks as never,
      enrichment as never,
      livePhoto as never,
      duplicateDecisions as never,
      mediaHealth as never,
      classification as never,
      archiveOperations as never,
    );
  });

  describe('authFor', () => {
    it('acts as the owner through an elevated system session, so Locked items are reachable', async () => {
      const auth = await sut.authFor(ownerId);

      expect(auth?.user.id).toBe(ownerId);
      expect(auth?.session?.hasElevatedPermission).toBe(true);
      expect(auth?.apiKey).toBeUndefined();
      expect(auth?.sharedLink).toBeUndefined();
    });

    it('does not filter out the owner’s sensitive or hidden items', async () => {
      const auth = await sut.authFor(ownerId);

      expect(auth?.hiddenContent).toBeUndefined();
      expect(auth?.hideNsfwAssets).toBeUndefined();
    });

    it('answers null for an account that no longer exists', async () => {
      users.get.mockResolvedValue(undefined);

      await expect(sut.authFor(ownerId)).resolves.toBeNull();
    });
  });

  describe('applyBatch', () => {
    describe('a transactional archive (FL-32)', () => {
      const archiveOperationId = newUuid();
      const jobId = '0195e2a0-0000-7000-8000-0000000000b1';

      it('publishes through the operation and reports what each item answered', async () => {
        const snapshot = snapshotOf({ action: MediaOperationBulkAction.Archive, payload: { archiveOperationId } });
        const [archived, moved, gone] = snapshot.assetIds;
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
        archiveOperations.publish.mockResolvedValue(
          new Map([
            [archived, 'archived'],
            [moved, 'skipped'],
            [gone, 'missing'],
          ]),
        );

        const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, jobId);

        expect(archiveOperations.publish).toHaveBeenCalledWith(
          authStub.user1.user.id,
          archiveOperationId,
          jobId,
          snapshot.assetIds,
        );
        expect(assets.updateAll).not.toHaveBeenCalled();
        expect(assets.notifyVisibilityChanged).toHaveBeenCalledWith([archived], authStub.user1.user.id);
        expect(outcomes).toEqual([
          { id: archived, status: MediaOperationItemStatus.Ok },
          { id: moved, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_archive_moved' },
          { id: gone, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_not_found' },
        ]);
      });

      it('undoes through the operation, leaving changed and unreached items as they are', async () => {
        const snapshot = snapshotOf({ action: MediaOperationBulkAction.Unarchive, payload: { archiveOperationId } });
        const [restored, changed, unreached] = snapshot.assetIds;
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
        archiveOperations.restore.mockResolvedValue(
          new Map([
            [restored, 'undone'],
            [changed, 'conflict'],
            [unreached, 'cancelled'],
          ]),
        );

        const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, jobId);

        expect(archiveOperations.restore).toHaveBeenCalledWith(
          authStub.user1.user.id,
          archiveOperationId,
          jobId,
          snapshot.assetIds,
        );
        expect(assets.notifyVisibilityChanged).toHaveBeenCalledWith([restored], authStub.user1.user.id);
        expect(outcomes).toEqual([
          { id: restored, status: MediaOperationItemStatus.Ok },
          {
            id: changed,
            status: MediaOperationItemStatus.Skipped,
            reasonKey: 'frameleaf_bulk_reason_archive_undo_changed',
          },
          { id: unreached, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_cancelled' },
        ]);
      });

      it('never lets an item the owner may not change reach the operation', async () => {
        const snapshot = snapshotOf({ action: MediaOperationBulkAction.Archive, payload: { archiveOperationId } });
        const [mine, theirs] = snapshot.assetIds;
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([mine]));
        archiveOperations.publish.mockResolvedValue(new Map([[mine, 'archived']]));

        const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, jobId);

        expect(archiveOperations.publish).toHaveBeenCalledWith(authStub.user1.user.id, archiveOperationId, jobId, [
          mine,
        ]);
        expect(outcomes).toContainEqual(
          expect.objectContaining({ id: theirs, reasonKey: 'frameleaf_bulk_reason_no_permission' }),
        );
      });

      it('records an item Locked since the job started as skipped in the operation, for either direction', async () => {
        for (const action of [MediaOperationBulkAction.Archive, MediaOperationBulkAction.Unarchive]) {
          archiveOperations.skipUnreached.mockClear();
          const snapshot = snapshotOf({ action, payload: { archiveOperationId } });
          const [lockedSince, ...rest] = snapshot.assetIds;
          mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
          vi.mocked(operations.getLockedIds).mockResolvedValue(new Set([lockedSince]));
          archiveOperations.publish.mockResolvedValue(new Map(rest.map((id) => [id, 'archived'])));
          archiveOperations.restore.mockResolvedValue(new Map(rest.map((id) => [id, 'undone'])));

          const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, jobId);

          expect(archiveOperations.skipUnreached).toHaveBeenCalledWith(
            authStub.user1.user.id,
            archiveOperationId,
            jobId,
            [lockedSince],
          );
          const touched =
            action === MediaOperationBulkAction.Archive ? archiveOperations.publish : archiveOperations.restore;
          expect(touched).toHaveBeenLastCalledWith(authStub.user1.user.id, archiveOperationId, jobId, rest);
          expect(outcomes).toContainEqual({
            id: lockedSince,
            status: MediaOperationItemStatus.Skipped,
            reasonKey: 'frameleaf_bulk_reason_locked',
          });
        }
      });

      it('archives an ordinary job without an operation as before', async () => {
        const snapshot = snapshotOf({ action: MediaOperationBulkAction.Archive });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

        await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, jobId);

        expect(archiveOperations.publish).not.toHaveBeenCalled();
        expect(assets.updateAll).toHaveBeenCalledWith(
          authStub.user1,
          expect.objectContaining({ visibility: AssetVisibility.Archive }),
        );
      });
    });

    it('skips items the owner may not change and sends only the rest', async () => {
      const snapshot = snapshotOf();
      const [mine, theirs, gone] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([mine]));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(assets.updateAll).toHaveBeenCalledWith(authStub.user1, { ids: [mine], isFavorite: true });
      expect(outcomes).toEqual(
        expect.arrayContaining([
          { id: mine, status: MediaOperationItemStatus.Ok },
          expect.objectContaining({
            id: theirs,
            status: MediaOperationItemStatus.Skipped,
            reasonKey: 'frameleaf_bulk_reason_no_permission',
          }),
          expect.objectContaining({ id: gone, status: MediaOperationItemStatus.Skipped }),
        ]),
      );
    });

    it('checks ownership with the elevated flag, so Locked items are not skipped', async () => {
      const auth = (await sut.authFor(ownerId))!;
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      await sut.applyBatch(auth, snapshot, snapshot.assetIds);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(ownerId, new Set(snapshot.assetIds), true);
      expect(assets.updateAll).toHaveBeenCalledWith(auth, { ids: snapshot.assetIds, isFavorite: true });
    });

    it('skips items locked after a job submitted without the PIN was queued (FL-34)', async () => {
      const auth = (await sut.authFor(ownerId))!;
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.Archive });
      const [lockedSince, ...rest] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      vi.mocked(operations.getLockedIds).mockResolvedValue(new Set([lockedSince]));

      const outcomes = await sut.applyBatch(auth, snapshot, snapshot.assetIds);

      expect(assets.updateAll).toHaveBeenCalledWith(auth, expect.objectContaining({ ids: rest }));
      expect(outcomes).toContainEqual({
        id: lockedSince,
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_locked',
      });
    });

    it('changes locked items for a job submitted from an unlocked session (FL-34)', async () => {
      const auth = (await sut.authFor(ownerId))!;
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.UnmarkSensitive, elevated: true });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      await sut.applyBatch(auth, snapshot, snapshot.assetIds);

      expect(operations.getLockedIds).not.toHaveBeenCalled();
      expect(enrichment.unlockAssets).toHaveBeenCalledWith(auth, { ids: snapshot.assetIds });
    });

    it('names the items a rejected batch actually failed on', async () => {
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.Archive });
      const [first, second] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      assets.updateAll.mockImplementation((_auth: unknown, { ids }: { ids: string[] }) =>
        ids.length > 1 || ids[0] === second ? Promise.reject(new Error('database said no')) : Promise.resolve(),
      );

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(assets.updateAll).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({ visibility: AssetVisibility.Archive }),
      );
      expect(outcomes.find((outcome) => outcome.id === first)?.status).toBe(MediaOperationItemStatus.Ok);
      expect(outcomes.find((outcome) => outcome.id === second)).toEqual(
        expect.objectContaining({ status: MediaOperationItemStatus.Failed, message: 'database said no' }),
      );
    });

    it('reports a per-item access refusal as skipped, not as a retryable failure', async () => {
      const snapshot = snapshotOf({ assetIds: [newUuid()] });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      assets.updateAll.mockRejectedValue(new BadRequestException('Not found or no asset.update access'));

      const [outcome] = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(outcome).toEqual(
        expect.objectContaining({
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_no_permission',
        }),
      );
    });

    it('marks sensitive as the lock record, never through visibility, albums or enrichment tags (FL-34)', async () => {
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.MarkSensitive });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(assets.lock).toHaveBeenCalledWith(authStub.user1, { ids: snapshot.assetIds });
      expect(enrichment.updateAssetEnrichment).not.toHaveBeenCalled();
      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(albums.addAssets).not.toHaveBeenCalled();
      expect(albums.removeAssets).not.toHaveBeenCalled();
      expect(outcomes.every((outcome) => outcome.status === MediaOperationItemStatus.Ok)).toBe(true);
    });

    it('relinks each still with its paired video, one pair at a time (FL-70)', async () => {
      const [photoA, photoB] = [newUuid(), newUuid()];
      const [videoA, videoB] = [newUuid(), newUuid()];
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.RelinkLivePhoto,
        assetIds: [photoA, photoB],
        payload: {
          pairs: [
            { photoId: photoA, videoId: videoA },
            { photoId: photoB, videoId: videoB },
          ],
        },
      });
      livePhoto.relinkOne.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
        success: false,
        error: 'Image is already linked to a motion video',
      });

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(livePhoto.relinkOne).toHaveBeenNthCalledWith(1, authStub.user1, photoA, videoA);
      expect(livePhoto.relinkOne).toHaveBeenNthCalledWith(2, authStub.user1, photoB, videoB);
      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        { id: photoA, status: MediaOperationItemStatus.Ok },
        expect.objectContaining({
          id: photoB,
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_live_photo_relink_rejected',
          message: 'Image is already linked to a motion video',
        }),
      ]);
    });

    it('retries a relink pair whose service call throws, rather than treating it as a permanent refusal', async () => {
      const photoId = newUuid();
      const videoId = newUuid();
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.RelinkLivePhoto,
        assetIds: [photoId],
        payload: { pairs: [{ photoId, videoId }] },
      });
      livePhoto.relinkOne.mockRejectedValue(new Error('database said no'));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(outcomes).toEqual([
        expect.objectContaining({ id: photoId, status: MediaOperationItemStatus.Failed, message: 'database said no' }),
      ]);
    });

    it('skips a still the payload has no pair for, without calling the relink service', async () => {
      const photoId = newUuid();
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.RelinkLivePhoto,
        assetIds: [photoId],
        payload: { pairs: [] },
      });

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(livePhoto.relinkOne).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        { id: photoId, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_not_found' },
      ]);
    });

    it.each([
      MediaOperationBulkAction.RelinkMissingMedia,
      MediaOperationBulkAction.RecoverDamagedMedia,
      MediaOperationBulkAction.TrashDamagedMedia,
    ])('hands each reviewed finding of a %s job to Library Care (FL-69)', async (action) => {
      const [first, second, unreviewed] = [newUuid(), newUuid(), newUuid()];
      const entries = [
        { assetId: first, findingId: newUuid(), candidateId: newUuid() },
        { assetId: second, findingId: newUuid(), candidateId: newUuid() },
      ];
      const snapshot = snapshotOf({ action, assetIds: [first, second, unreviewed], payload: { mediaHealth: entries } });
      mediaHealth.applyBulkEntry.mockResolvedValueOnce({ id: first, status: MediaOperationItemStatus.Ok });
      mediaHealth.applyBulkEntry.mockResolvedValueOnce({
        id: second,
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_media_health_changed',
      });

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(mediaHealth.applyBulkEntry).toHaveBeenNthCalledWith(1, authStub.user1, action, entries[0]);
      expect(mediaHealth.applyBulkEntry).toHaveBeenNthCalledWith(2, authStub.user1, action, entries[1]);
      expect(mediaHealth.applyBulkEntry).toHaveBeenCalledTimes(2);
      // Library Care checks owner and Locked itself: an administrator may repair another account.
      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        { id: first, status: MediaOperationItemStatus.Ok },
        expect.objectContaining({ id: second, status: MediaOperationItemStatus.Skipped }),
        { id: unreviewed, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_not_found' },
      ]);
    });

    it('skips a Library Care item locked since a job submitted without the PIN (FL-69)', async () => {
      const assetId = newUuid();
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.RelinkMissingMedia,
        assetIds: [assetId],
        payload: { mediaHealth: [{ assetId, findingId: newUuid(), candidateId: newUuid() }] },
        elevated: false,
      });
      vi.mocked(operations.getLockedIds).mockResolvedValue(new Set([assetId]));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(mediaHealth.applyBulkEntry).not.toHaveBeenCalled();
      expect(outcomes).toEqual([
        { id: assetId, status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_locked' },
      ]);
    });

    it('reports an item already in the album as skipped', async () => {
      const albumId = newUuid();
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.AddToAlbum, payload: { albumId } });
      const [added, duplicate, denied] = snapshot.assetIds;
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
      albums.addAssets.mockResolvedValue([
        { id: added, success: true },
        { id: duplicate, success: false, error: 'duplicate' },
        { id: denied, success: false, error: 'no_permission' },
      ]);

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(albums.addAssets).toHaveBeenCalledWith(authStub.user1, albumId, { ids: snapshot.assetIds });
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        MediaOperationItemStatus.Ok,
        MediaOperationItemStatus.Skipped,
        MediaOperationItemStatus.Skipped,
      ]);
    });

    it('checks the tagged items itself, because bulk tagging drops refusals silently', async () => {
      const tagId = newUuid();
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.Tag, payload: { tagIds: [tagId] } });
      const [allowed] = snapshot.assetIds;
      mocks.access.tag.checkOwnerAccess.mockResolvedValue(new Set([tagId]));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([allowed]));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds);

      expect(tags.bulkTagAssets).toHaveBeenCalledWith(authStub.user1, { assetIds: [allowed], tagIds: [tagId] });
      expect(outcomes.filter((outcome) => outcome.status === MediaOperationItemStatus.Skipped)).toHaveLength(2);
    });
  });

  describe('run', () => {
    it('works through the frozen set and completes', async () => {
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      await sut.run(operationOf(snapshot), 'claim');

      expect(assets.updateAll).toHaveBeenCalledWith(expect.anything(), { ids: snapshot.assetIds, isFavorite: true });
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({
          processedUnits: 3,
          totalUnits: 3,
          progress: 100,
          result: expect.objectContaining({ succeeded: 3, inFlight: null }),
        }),
      );
      expect(operations.complete).toHaveBeenCalledWith(expect.any(String), 'claim', { resultAssetId: null });
    });

    it('resumes from the durable cursor rather than starting again', async () => {
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      await sut.run(operationOf(snapshot, { processedUnits: '2' } as never), 'claim');

      expect(assets.updateAll).toHaveBeenCalledTimes(1);
      expect(assets.updateAll).toHaveBeenCalledWith(expect.anything(), {
        ids: [snapshot.assetIds[2]],
        isFavorite: true,
      });
    });

    it('stops at a cancel and records what was already changed', async () => {
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      vi.mocked(operations.setBulkResult)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({
          status: MediaOperationStatus.Cancelling,
          cancelRequestedAt: new Date(),
          pauseRequestedAt: null,
        });

      await sut.run(operationOf(snapshot), 'claim');

      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({ processedUnits: 3, result: expect.objectContaining({ succeeded: 3 }) }),
      );
      expect(operations.acknowledgeCancel).toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('pauses at the batch boundary, keeping what it changed, and hands the claim back (FL-104)', async () => {
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      vi.mocked(operations.setBulkResult)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({ ...running, pauseRequestedAt: new Date() });

      await sut.run(operationOf(snapshot), 'claim');

      expect(assets.updateAll).toHaveBeenCalledTimes(1);
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({ processedUnits: 3, result: expect.objectContaining({ succeeded: 3 }) }),
      );
      expect(operations.settlePause).toHaveBeenCalledWith(expect.any(String), 'claim');
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('stops before a batch it has not sent when a pause is already waiting', async () => {
      const snapshot = snapshotOf();
      vi.mocked(operations.setBulkResult).mockResolvedValue({ ...running, pauseRequestedAt: new Date() });

      await sut.run(operationOf(snapshot), 'claim');

      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(operations.settlePause).toHaveBeenCalledTimes(1);
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('carries on when the owner resumed before the worker reached the boundary', async () => {
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      vi.mocked(operations.setBulkResult).mockResolvedValueOnce({ ...running, pauseRequestedAt: new Date() });
      vi.mocked(operations.settlePause).mockResolvedValueOnce(false);

      await sut.run(operationOf(snapshot), 'claim');

      expect(assets.updateAll).toHaveBeenCalledTimes(1);
      expect(operations.complete).toHaveBeenCalled();
    });

    it('stops writing the moment its claim is taken away', async () => {
      const snapshot = snapshotOf();
      vi.mocked(operations.setBulkResult).mockResolvedValue(undefined);

      await sut.run(operationOf(snapshot), 'stale');

      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('applies an interrupted relative shift again from the recorded starting dates, never twice', async () => {
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.ChangeDate,
        payload: { dateMode: 'shift', minutes: 60 },
      });
      const [first, second, undated] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      const operation = operationOf(snapshot, {
        result: {
          requested: 3,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          items: [],
          itemsTruncated: false,
          inFlight: { start: 0, size: 3 },
          retry: null,
          // Recorded before the interrupted batch was first sent; the dates may have moved since.
          shiftFrom: { [first]: '2026-01-01T10:00:00.000Z', [second]: '2026-01-02T10:00:00.000Z', [undated]: null },
        },
      } as never);

      await sut.run(operation, 'claim');

      // The dates are not read again: they may already be shifted.
      expect(operations.getDateTimeOriginals).not.toHaveBeenCalled();
      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(assets.shiftDateTimeOriginalFrom).toHaveBeenCalledWith(
        expect.anything(),
        [
          { id: first, from: new Date('2026-01-01T10:00:00.000Z') },
          { id: second, from: new Date('2026-01-02T10:00:00.000Z') },
        ],
        60,
      );
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({
          processedUnits: 3,
          result: expect.objectContaining({ succeeded: 3, skipped: 0, inFlight: null, shiftFrom: {} }),
        }),
      );
      expect(operations.complete).toHaveBeenCalled();
    });

    it('records each starting date before the shift is sent', async () => {
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.ChangeDate,
        payload: { dateMode: 'shift', minutes: -30 },
      });
      const [first, second, undated] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      vi.mocked(operations.getDateTimeOriginals).mockResolvedValue(
        new Map<string, Date | null>([
          [first, new Date('2026-01-01T10:00:00.000Z')],
          [second, new Date('2026-01-02T10:00:00.000Z')],
          [undated, null],
        ]),
      );

      await sut.run(operationOf(snapshot), 'claim');

      const marked = vi
        .mocked(operations.setBulkResult)
        .mock.calls.findIndex((call) => (call[2].result as { inFlight: unknown }).inFlight !== null);
      expect(vi.mocked(operations.setBulkResult).mock.calls[marked][2].result).toEqual(
        expect.objectContaining({
          inFlight: { start: 0, size: 3 },
          shiftFrom: {
            [first]: '2026-01-01T10:00:00.000Z',
            [second]: '2026-01-02T10:00:00.000Z',
            [undated]: null,
          },
        }),
      );
      expect(vi.mocked(operations.setBulkResult).mock.invocationCallOrder[marked]).toBeLessThan(
        vi.mocked(assets.shiftDateTimeOriginalFrom).mock.invocationCallOrder[0],
      );
      expect(assets.shiftDateTimeOriginalFrom).toHaveBeenCalledWith(
        expect.anything(),
        [
          { id: first, from: new Date('2026-01-01T10:00:00.000Z') },
          { id: second, from: new Date('2026-01-02T10:00:00.000Z') },
        ],
        -30,
      );
    });

    it('refuses to shift an item whose starting date was never recorded', async () => {
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.ChangeDate,
        payload: { dateMode: 'shift', minutes: 5 },
      });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {});

      expect(assets.shiftDateTimeOriginalFrom).not.toHaveBeenCalled();
      expect(outcomes.every((outcome) => outcome.status === MediaOperationItemStatus.Failed)).toBe(true);
    });

    it('gives failed items one automatic retry after a pause instead of reporting them', async () => {
      const snapshot = snapshotOf();
      const [, flaky] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      assets.updateAll.mockImplementation((_auth: unknown, { ids }: { ids: string[] }) =>
        ids.includes(flaky) ? Promise.reject(new Error('connection reset')) : Promise.resolve(),
      );

      await sut.run(operationOf(snapshot), 'claim');

      expect(operations.requeue).toHaveBeenCalledWith(expect.any(String), 'claim', {
        delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
        // Handing the job back for its item retry is not a lost claim (FL-43).
        returnAttempt: true,
      });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({
          processedUnits: 3,
          result: expect.objectContaining({
            succeeded: 2,
            failed: 0,
            items: [],
            retry: { ids: [flaky], total: 1, processed: 0, inFlight: null },
          }),
        }),
      );
    });

    it('runs the retry pass on the next claim and reports what happened then', async () => {
      const snapshot = snapshotOf();
      const [, flaky] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      const waiting = operationOf(snapshot, {
        processedUnits: '3',
        result: {
          requested: 3,
          succeeded: 2,
          failed: 0,
          skipped: 0,
          items: [],
          itemsTruncated: false,
          inFlight: null,
          retry: { ids: [flaky], total: 1, processed: 0, inFlight: null },
          shiftFrom: {},
        },
      } as never);

      await sut.run(waiting, 'claim-2');

      expect(assets.updateAll).toHaveBeenCalledTimes(1);
      expect(assets.updateAll).toHaveBeenCalledWith(expect.anything(), { ids: [flaky], isFavorite: true });
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim-2',
        expect.objectContaining({
          result: expect.objectContaining({
            succeeded: 3,
            failed: 0,
            retry: { ids: [flaky], total: 1, processed: 1, inFlight: null },
          }),
        }),
      );
      expect(operations.complete).toHaveBeenCalled();
    });

    it('reports an item that fails its automatic retry too, and does not retry it again', async () => {
      const snapshot = snapshotOf();
      const [, flaky] = snapshot.assetIds;
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      assets.updateAll.mockRejectedValue(new Error('connection reset'));
      const waiting = operationOf(snapshot, {
        processedUnits: '3',
        result: {
          requested: 3,
          succeeded: 2,
          failed: 0,
          skipped: 0,
          items: [],
          itemsTruncated: false,
          inFlight: null,
          retry: { ids: [flaky], total: 1, processed: 0, inFlight: null },
          shiftFrom: {},
        },
      } as never);

      await sut.run(waiting, 'claim-2');

      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim-2',
        expect.objectContaining({
          result: expect.objectContaining({
            succeeded: 2,
            failed: 1,
            items: [expect.objectContaining({ id: flaky, status: MediaOperationItemStatus.Failed })],
          }),
        }),
      );
      expect(operations.complete).toHaveBeenCalled();
    });
    it('replays an interrupted batch when repeating it is harmless', async () => {
      const snapshot = snapshotOf();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(snapshot.assetIds));
      const operation = operationOf(snapshot, {
        result: {
          requested: 3,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          items: [],
          itemsTruncated: false,
          inFlight: { start: 0, size: 3 },
        },
      } as never);

      await sut.run(operation, 'claim');

      expect(assets.updateAll).toHaveBeenCalledWith(expect.anything(), { ids: snapshot.assetIds, isFavorite: true });
    });

    it('fails the job, leaving the batch unreached, when the album is no longer writable', async () => {
      const snapshot = snapshotOf({ action: MediaOperationBulkAction.AddToAlbum, payload: { albumId: newUuid() } });
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

      await sut.run(operationOf(snapshot), 'claim');

      expect(albums.addAssets).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({ errorCode: 'bulk_target_unavailable' }),
      );
      expect(operations.setBulkResult).toHaveBeenLastCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({ processedUnits: 0, result: expect.objectContaining({ inFlight: null }) }),
      );
    });

    it('stops a job whose API key was revoked', async () => {
      const snapshot = snapshotOf({ apiKeyId: newUuid() });
      apiKeys.getById.mockResolvedValue(undefined);

      await sut.run(operationOf(snapshot), 'claim');

      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({ errorCode: 'bulk_credentials_revoked' }),
      );
    });

    it('fails a job it cannot read rather than guessing', async () => {
      const unreadable = { ...operationOf(snapshotOf()), snapshot: { action: 'rename-everything' } } as MediaOperation;

      await sut.run(unreadable, 'claim');

      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'claim',
        expect.objectContaining({ errorCode: 'bulk_snapshot_invalid' }),
      );
    });
  });

  describe('drain', () => {
    it('only claims bulk jobs and leaves recovery to the one media-operation sweep', async () => {
      await sut.drain();

      expect(operations.claimNext).toHaveBeenCalledWith(expect.objectContaining({ kinds: [MediaOperationKind.Bulk] }));
      expect(operations.recoverExpiredClaims).not.toHaveBeenCalled();
    });
  });
  describe('duplicate decisions (FL-61)', () => {
    const operationId = '0195e2a0-0000-7000-8000-0000000000d1';
    const groupOf = (size: number) => ({
      duplicateId: newUuid(),
      decision: DuplicateDecisionKind.Keepers,
      memberIds: Array.from({ length: size }, () => newUuid()),
      keepAssetIds: [] as string[],
    });
    const decisionSnapshot = (groups: ReturnType<typeof groupOf>[], overrides: Partial<BulkOperationSnapshot> = {}) =>
      snapshotOf({
        action: MediaOperationBulkAction.ResolveDuplicates,
        assetIds: groups.flatMap((group) => group.memberIds),
        payload: {
          duplicateGroups: groups.map((group) => ({ ...group, keepAssetIds: [group.memberIds[0]] })),
        },
        ...overrides,
      });
    const okAll = (ids: string[]) => ids.map((id) => ({ id, status: MediaOperationItemStatus.Ok }));

    it('hands every complete group of the batch to the decision service, as the job', async () => {
      const [first, second] = [groupOf(2), groupOf(3)];
      const snapshot = decisionSnapshot([first, second], { elevated: true });
      duplicateDecisions.applyGroup.mockImplementation((_auth: unknown, _id: string, group: { memberIds: string[] }) =>
        Promise.resolve(okAll(group.memberIds)),
      );

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, operationId);

      expect(duplicateDecisions.applyGroup).toHaveBeenCalledTimes(2);
      expect(duplicateDecisions.applyGroup).toHaveBeenCalledWith(
        authStub.user1,
        operationId,
        expect.objectContaining({ duplicateId: first.duplicateId, memberIds: first.memberIds }),
      );
      expect(outcomes).toEqual(okAll([...first.memberIds, ...second.memberIds]));
      // a decision never goes through the per-item update paths
      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(duplicateDecisions.getLockedIds).not.toHaveBeenCalled();
    });

    it('skips a whole group that holds an item locked since a job queued without the PIN', async () => {
      const [lockedGroup, openGroup] = [groupOf(2), groupOf(2)];
      const snapshot = decisionSnapshot([lockedGroup, openGroup], { elevated: false });
      duplicateDecisions.getLockedIds.mockResolvedValue(new Set([lockedGroup.memberIds[1]]));
      duplicateDecisions.applyGroup.mockResolvedValue(okAll(openGroup.memberIds));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, operationId);

      expect(duplicateDecisions.applyGroup).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual([
        ...lockedGroup.memberIds.map((id) =>
          expect.objectContaining({
            id,
            status: MediaOperationItemStatus.Skipped,
            reasonKey: 'frameleaf_bulk_reason_locked',
          }),
        ),
        ...okAll(openGroup.memberIds),
      ]);
    });

    it('reports every member of a group that threw as refused, and carries on with the next group', async () => {
      const [broken, fine] = [groupOf(2), groupOf(2)];
      const snapshot = decisionSnapshot([broken, fine], { elevated: true });
      duplicateDecisions.applyGroup
        .mockRejectedValueOnce(new Error('database went away'))
        .mockResolvedValueOnce(okAll(fine.memberIds));

      const outcomes = await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, operationId);

      expect(outcomes.slice(0, 2)).toEqual(
        broken.memberIds.map((id) => expect.objectContaining({ id, status: MediaOperationItemStatus.Failed })),
      );
      expect(outcomes.slice(2)).toEqual(okAll(fine.memberIds));
    });

    it('routes an undo job to the undo side', async () => {
      const group = groupOf(2);
      const snapshot = decisionSnapshot([group], { action: MediaOperationBulkAction.UndoDuplicates, elevated: true });
      duplicateDecisions.undoGroup.mockResolvedValue(okAll(group.memberIds));

      await sut.applyBatch(authStub.user1, snapshot, snapshot.assetIds, {}, operationId);

      expect(duplicateDecisions.undoGroup).toHaveBeenCalledWith(authStub.user1, operationId, expect.anything());
      expect(duplicateDecisions.applyGroup).not.toHaveBeenCalled();
    });

    it('never splits a group across two batches', async () => {
      // 499 ids of small groups, then one group of three that straddles the 500 boundary
      const small = Array.from({ length: 249 }, () => groupOf(2));
      const straddling = groupOf(3);
      const tail = groupOf(2);
      const snapshot = decisionSnapshot([...small, straddling, tail], { elevated: true });
      duplicateDecisions.applyGroup.mockImplementation((_auth: unknown, _id: string, group: { memberIds: string[] }) =>
        Promise.resolve(okAll(group.memberIds)),
      );
      const applyBatch = vi.spyOn(sut, 'applyBatch');

      await sut.run(operationOf(snapshot), 'claim-token');

      const batches = applyBatch.mock.calls.map((call) => call[2]);
      expect(batches).toHaveLength(2);
      expect(batches[0]).toHaveLength(498 + 3);
      expect(batches[0].slice(-3)).toEqual(straddling.memberIds);
      expect(batches[1]).toEqual(tail.memberIds);
      expect(applyBatch.mock.calls[0][4]).toBe(operationOf(snapshot).id);
    });
  });
});
