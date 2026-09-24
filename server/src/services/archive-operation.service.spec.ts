import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ArchiveOperationSummary } from 'src/repositories/archive-operation.repository.js';
import { ArchiveOperationScope } from 'src/dtos/archive-operation.dto.js';
import { MediaOperationBulkAction, MediaOperationStatus } from 'src/enum.js';
import {
  ArchiveOperationService,
  isArchiveUndoable,
  mapArchiveOperation,
} from 'src/services/archive-operation.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';

const archiveJobId = '0195e2a0-0000-7000-8000-0000000000a1';
const undoJobId = '0195e2a0-0000-7000-8000-0000000000a2';

const summaryOf = (overrides: Partial<ArchiveOperationSummary> = {}): ArchiveOperationSummary => ({
  id: newUuid(),
  ownerId: authStub.user1.user.id,
  sessionId: authStub.user1.session!.id,
  requestKey: newUuid(),
  scope: ArchiveOperationScope.SelectedOwnedAssets,
  descriptor: null,
  prepared: false,
  preparedElevated: false,
  expiresAt: null,
  archiveJobId: null,
  undoJobId: null,
  createdAt: new Date('2026-09-23T10:00:00.000Z'),
  count: 3,
  pending: 3,
  archived: 0,
  skipped: 0,
  undone: 0,
  conflict: 0,
  archiveJobStatus: null,
  undoJobStatus: null,
  ...overrides,
});

const unlocked = { ...authStub.user1, session: { id: newUuid(), hasElevatedPermission: true } };

describe(ArchiveOperationService.name, () => {
  let sut: ArchiveOperationService;
  let repository: Record<string, any>;
  let mediaOperations: { createBulk: any; cancel: any };
  /** The operation as the fake store holds it; `startJob` links jobs into it under its "lock". */
  let stored: ArchiveOperationSummary;
  const logger = { setContext: vi.fn(), log: vi.fn(), debug: vi.fn(), warn: vi.fn() };

  const store = (overrides: Partial<ArchiveOperationSummary> = {}) => {
    stored = summaryOf(overrides);
    return stored;
  };

  beforeEach(() => {
    store();
    let queue = Promise.resolve();
    repository = {
      createSelected: vi.fn(() => Promise.resolve(stored.id)),
      prepareMatching: vi.fn(() => Promise.resolve(stored.id)),
      confirm: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(() => Promise.resolve({ ...stored })),
      list: vi.fn(() => Promise.resolve([{ ...stored }])),
      pendingAssetIds: vi.fn(),
      undoAssetIds: vi.fn(),
      skipLocked: vi.fn().mockResolvedValue(0),
      prune: vi.fn().mockResolvedValue(0),
      // serialises like the row lock: one start at a time, each seeing the link the last one wrote
      startJob: vi.fn((_ownerId: string, _id: string, kind: 'archive' | 'undo', start: any) => {
        const run = queue.then(async () => {
          const linked = kind === 'archive' ? stored.archiveJobId : stored.undoJobId;
          const jobStatus = kind === 'archive' ? stored.archiveJobStatus : stored.undoJobStatus;
          const jobId = await start({ ...stored, jobStatus: linked ? jobStatus : null });
          if (jobId) {
            stored =
              kind === 'archive'
                ? { ...stored, archiveJobId: jobId, archiveJobStatus: MediaOperationStatus.Queued }
                : { ...stored, undoJobId: jobId, undoJobStatus: MediaOperationStatus.Queued };
          }
          return jobId;
        });
        queue = run.then(() => {}).catch(() => {});
        return run;
      }),
    };
    mediaOperations = { createBulk: vi.fn(), cancel: vi.fn() };
    sut = new ArchiveOperationService(logger as never, repository as never, mediaOperations as never);
  });

  describe('create', () => {
    it('freezes the selection and hands it to one durable archive job linked to the operation', async () => {
      const ids = [newUuid(), newUuid()];
      repository.pendingAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      const response = await sut.create(authStub.user1, { requestKey: stored.requestKey, assetIds: ids });

      expect(repository.createSelected).toHaveBeenCalledWith(authStub.user1, stored.requestKey, ids);
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({
          action: MediaOperationBulkAction.Archive,
          assetIds: ids,
          requestId: stored.requestKey,
        }),
        { archiveOperationId: stored.id },
      );
      expect(response).toEqual(expect.objectContaining({ archiveJobId, undoable: true, currentSession: true }));
    });

    it('answers a repeated request with the job it already has', async () => {
      store({ archiveJobId });

      await sut.create(authStub.user1, { requestKey: stored.requestKey, assetIds: [newUuid()] });

      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });

    it('starts one job when the same request arrives twice at the same moment (P2-6)', async () => {
      repository.pendingAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });
      const dto = { requestKey: stored.requestKey, assetIds: [newUuid()] };

      const [first, second] = await Promise.all([sut.create(authStub.user1, dto), sut.create(authStub.user1, dto)]);

      expect(mediaOperations.createBulk).toHaveBeenCalledTimes(1);
      expect(first.archiveJobId).toBe(archiveJobId);
      expect(second.archiveJobId).toBe(archiveJobId);
    });

    it('refuses an API key: an archive belongs to a signed-in session', async () => {
      await expect(
        sut.create({ ...authStub.user1, apiKey: { id: newUuid(), permissions: [] } } as never, {
          requestKey: newUuid(),
          assetIds: [newUuid()],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.createSelected).not.toHaveBeenCalled();
    });
  });

  describe('prepare and confirm', () => {
    it('counts the matching set without starting anything', async () => {
      store({
        scope: ArchiveOperationScope.MatchingOwnedTimeline,
        prepared: true,
        expiresAt: new Date('2026-09-23T10:30:00.000Z'),
        count: 1200,
        pending: 1200,
      });

      const response = await sut.prepare(authStub.user1, {
        requestKey: stored.requestKey,
        scope: ArchiveOperationScope.MatchingOwnedTimeline as never,
      });

      expect(response).toEqual(
        expect.objectContaining({
          prepared: true,
          count: 1200,
          expiresAt: '2026-09-23T10:30:00.000Z',
          undoable: false,
        }),
      );
      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });

    it('reads counts as the asking session may see them (P2-4)', async () => {
      await sut.get(authStub.user1, stored.id);
      await sut.get(unlocked, stored.id);

      expect(repository.get).toHaveBeenNthCalledWith(1, authStub.user1.user.id, { elevated: false }, stored.id);
      expect(repository.get).toHaveBeenNthCalledWith(2, authStub.user1.user.id, { elevated: true }, stored.id);
    });

    it('starts the job only after the exact prepared selection is confirmed', async () => {
      store({ scope: ArchiveOperationScope.MatchingOwnedTimeline });
      repository.pendingAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      await sut.confirm(authStub.user1, stored.id, stored.requestKey);

      expect(repository.confirm).toHaveBeenCalledWith(authStub.user1, stored.id, stored.requestKey);
      expect(repository.confirm.mock.invocationCallOrder[0]).toBeLessThan(
        mediaOperations.createBulk.mock.invocationCallOrder[0],
      );
    });

    it('leaves out items Locked since the selection was frozen instead of refusing the confirmation', async () => {
      store({ scope: ArchiveOperationScope.MatchingOwnedTimeline });
      const ids = [newUuid()];
      repository.skipLocked.mockResolvedValue(2);
      repository.pendingAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      await sut.confirm(authStub.user1, stored.id, stored.requestKey);

      expect(repository.skipLocked).toHaveBeenCalledWith(authStub.user1.user.id, stored.id);
      expect(repository.skipLocked.mock.invocationCallOrder[0]).toBeLessThan(
        repository.pendingAssetIds.mock.invocationCallOrder[0],
      );
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({ assetIds: ids }),
        expect.anything(),
      );
    });

    it('keeps Locked items in an unlocked session’s archive', async () => {
      store({ scope: ArchiveOperationScope.MatchingOwnedTimeline });
      repository.pendingAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      await sut.confirm(unlocked, stored.id, stored.requestKey);

      expect(repository.skipLocked).not.toHaveBeenCalled();
    });

    it('starts nothing for an empty selection', async () => {
      store({ count: 0, pending: 0 });
      repository.pendingAssetIds.mockResolvedValue([]);

      const response = await sut.confirm(authStub.user1, stored.id, stored.requestKey);

      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
      expect(response.archiveJobId).toBeNull();
    });
  });

  describe('undo', () => {
    it('stops a running archive, then undoes the whole frozen set as its own job', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Rendering, archived: 1, pending: 2 });
      const ids = [newUuid(), newUuid(), newUuid()];
      const requestKey = newUuid();
      repository.undoAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      const response = await sut.undo(unlocked, stored.id, requestKey);

      expect(mediaOperations.cancel).toHaveBeenCalledWith(unlocked, archiveJobId);
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(
        unlocked,
        expect.objectContaining({ action: MediaOperationBulkAction.Unarchive, assetIds: ids, requestId: requestKey }),
        { archiveOperationId: stored.id },
      );
      expect(response).toEqual(expect.objectContaining({ undoJobId, undoable: false }));
    });

    it('does not cancel an archive that already finished', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 3 });
      repository.undoAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      await sut.undo(authStub.user1, stored.id, newUuid());

      expect(mediaOperations.cancel).not.toHaveBeenCalled();
    });

    it('answers a repeated undo with the undo that is running or done', async () => {
      store({ archiveJobId, undoJobId, undoJobStatus: MediaOperationStatus.Rendering, archived: 1, undone: 2 });

      await sut.undo(authStub.user1, stored.id, newUuid());

      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });

    it('starts one undo when two arrive at the same moment (P2-6)', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 3 });
      repository.undoAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });
      const requestKey = newUuid();

      await Promise.all([
        sut.undo(authStub.user1, stored.id, requestKey),
        sut.undo(authStub.user1, stored.id, requestKey),
      ]);

      expect(mediaOperations.createBulk).toHaveBeenCalledTimes(1);
    });

    it('can be started again when the undo was cancelled or failed (P2-1)', async () => {
      for (const ended of [MediaOperationStatus.Cancelled, MediaOperationStatus.Failed]) {
        mediaOperations.createBulk.mockReset();
        store({
          archiveJobId,
          archiveJobStatus: MediaOperationStatus.Completed,
          undoJobId,
          undoJobStatus: ended,
          archived: 2,
          undone: 1,
        });
        expect(isArchiveUndoable(stored)).toBe(true);
        repository.undoAssetIds.mockResolvedValue([newUuid()]);
        mediaOperations.createBulk.mockResolvedValue({ id: 'second-undo' });

        const response = await sut.undo(authStub.user1, stored.id, newUuid());

        expect(mediaOperations.createBulk).toHaveBeenCalledTimes(1);
        expect(response.undoJobId).toBe('second-undo');
      }
    });

    it('refuses to restart an ended undo under its own request key', async () => {
      store({
        archiveJobId,
        archiveJobStatus: MediaOperationStatus.Completed,
        undoJobId,
        undoJobStatus: MediaOperationStatus.Cancelled,
        archived: 2,
      });
      repository.undoAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      await expect(sut.undo(authStub.user1, stored.id, newUuid())).rejects.toBeInstanceOf(ConflictException);
      expect(stored.undoJobStatus).toBe(MediaOperationStatus.Cancelled);
    });

    it('refuses an archive with nothing left to undo', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, pending: 0, skipped: 3 });

      await expect(sut.undo(authStub.user1, stored.id, newUuid())).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses the archive’s own request key, which would answer with the archive job', async () => {
      store({ archiveJobId, archived: 3 });

      await expect(sut.undo(authStub.user1, stored.id, stored.requestKey)).rejects.toBeInstanceOf(ConflictException);
      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });

    it('leaves Locked items out of an undo from a session without the PIN and restores the rest', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 3 });
      const restorable = [newUuid(), newUuid()];
      repository.undoAssetIds.mockResolvedValue(restorable);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      await sut.undo(authStub.user1, stored.id, newUuid());

      expect(repository.skipLocked).toHaveBeenCalledWith(authStub.user1.user.id, stored.id);
      expect(repository.undoAssetIds).toHaveBeenCalledWith(authStub.user1.user.id, stored.id, false);
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({ assetIds: restorable }),
        expect.anything(),
      );
    });

    it('undoes Locked items too from an unlocked session', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 3 });
      repository.undoAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      await sut.undo(unlocked, stored.id, newUuid());

      expect(repository.skipLocked).not.toHaveBeenCalled();
      expect(repository.undoAssetIds).toHaveBeenCalledWith(authStub.user1.user.id, stored.id, true);
    });

    it('refuses, without naming anything, when every remaining item is Locked for this session', async () => {
      store({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 1 });
      repository.undoAssetIds.mockResolvedValue([]);

      await expect(sut.undo(authStub.user1, stored.id, newUuid())).rejects.toBeInstanceOf(ConflictException);
      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });
  });

  describe('onNightlyDatabaseCleanup', () => {
    it('forgets operations nobody can act on any more', async () => {
      await sut.onNightlyDatabaseCleanup();
      expect(repository.prune).toHaveBeenCalledWith(30);
    });

    it('waits for the next night when the store cannot be written', async () => {
      repository.prune.mockRejectedValue(new Error('handoff'));
      await expect(sut.onNightlyDatabaseCleanup()).resolves.toBeUndefined();
    });
  });

  describe('mapArchiveOperation', () => {
    it('never offers undo for a prepared, unconfirmed selection', () => {
      expect(isArchiveUndoable(summaryOf({ prepared: true, archiveJobId, archived: 1 }))).toBe(false);
    });

    it('reports no expiry once the selection is confirmed', () => {
      const mapped = mapArchiveOperation(summaryOf({ expiresAt: new Date('2026-09-23T10:30:00.000Z') }));
      expect(mapped.expiresAt).toBeNull();
      expect(mapped.createdAt).toBe('2026-09-23T10:00:00.000Z');
    });

    it('marks only the operations of the session asking as its own (P2-3)', () => {
      const operation = summaryOf();
      expect(mapArchiveOperation(operation, operation.sessionId!).currentSession).toBe(true);
      expect(mapArchiveOperation(operation, newUuid()).currentSession).toBe(false);
      expect(mapArchiveOperation(operation).currentSession).toBe(false);
    });
  });
});
