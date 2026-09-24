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
  ...overrides,
});

describe(ArchiveOperationService.name, () => {
  let sut: ArchiveOperationService;
  let repository: Record<string, any>;
  let mediaOperations: { createBulk: any; cancel: any };
  const logger = { setContext: vi.fn(), log: vi.fn(), debug: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    repository = {
      createSelected: vi.fn(),
      prepareMatching: vi.fn(),
      confirm: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(),
      list: vi.fn(),
      orderedAssetIds: vi.fn(),
      pendingAssetIds: vi.fn(),
      skipLocked: vi.fn().mockResolvedValue(0),
      prune: vi.fn().mockResolvedValue(0),
      linkArchiveJob: vi.fn().mockResolvedValue(true),
      linkUndoJob: vi.fn().mockResolvedValue(true),
    };
    mediaOperations = { createBulk: vi.fn(), cancel: vi.fn() };
    sut = new ArchiveOperationService(logger as never, repository as never, mediaOperations as never);
  });

  describe('create', () => {
    it('freezes the selection and hands it to one durable archive job linked to the operation', async () => {
      const operation = summaryOf();
      const ids = [newUuid(), newUuid()];
      repository.createSelected.mockResolvedValue(operation.id);
      repository.get
        .mockResolvedValueOnce(operation)
        .mockResolvedValueOnce({ ...operation, archiveJobId, archiveJobStatus: MediaOperationStatus.Queued });
      repository.pendingAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      const response = await sut.create(authStub.user1, { requestKey: operation.requestKey, assetIds: ids });

      expect(repository.createSelected).toHaveBeenCalledWith(authStub.user1, operation.requestKey, ids);
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({
          action: MediaOperationBulkAction.Archive,
          assetIds: ids,
          requestId: operation.requestKey,
        }),
        { archiveOperationId: operation.id },
      );
      expect(repository.linkArchiveJob).toHaveBeenCalledWith(operation.id, archiveJobId);
      expect(response).toEqual(expect.objectContaining({ archiveJobId, undoable: true }));
    });

    it('answers a repeated request with the job it already has', async () => {
      const operation = summaryOf({ archiveJobId });
      repository.createSelected.mockResolvedValue(operation.id);
      repository.get.mockResolvedValue(operation);

      await sut.create(authStub.user1, { requestKey: operation.requestKey, assetIds: [newUuid()] });

      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
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
      const operation = summaryOf({
        scope: ArchiveOperationScope.MatchingOwnedTimeline,
        prepared: true,
        expiresAt: new Date('2026-09-23T10:30:00.000Z'),
        count: 1200,
        pending: 1200,
      });
      repository.prepareMatching.mockResolvedValue(operation.id);
      repository.get.mockResolvedValue(operation);

      const response = await sut.prepare(authStub.user1, {
        requestKey: operation.requestKey,
        scope: ArchiveOperationScope.MatchingOwnedTimeline,
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

    it('starts the job only after the exact prepared selection is confirmed', async () => {
      const operation = summaryOf({ scope: ArchiveOperationScope.MatchingOwnedTimeline });
      const ids = [newUuid()];
      repository.get.mockResolvedValue(operation);
      repository.pendingAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      await sut.confirm(authStub.user1, operation.id, operation.requestKey);

      expect(repository.confirm).toHaveBeenCalledWith(authStub.user1, operation.id, operation.requestKey);
      expect(repository.confirm.mock.invocationCallOrder[0]).toBeLessThan(
        mediaOperations.createBulk.mock.invocationCallOrder[0],
      );
    });

    it('leaves out items Locked since the selection was frozen instead of refusing the confirmation', async () => {
      const operation = summaryOf({ scope: ArchiveOperationScope.MatchingOwnedTimeline });
      const ids = [newUuid()];
      repository.get.mockResolvedValue(operation);
      repository.skipLocked.mockResolvedValue(2);
      repository.pendingAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });

      await sut.confirm(authStub.user1, operation.id, operation.requestKey);

      expect(repository.skipLocked).toHaveBeenCalledWith(authStub.user1.user.id, operation.id);
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
      const operation = summaryOf({ scope: ArchiveOperationScope.MatchingOwnedTimeline });
      repository.get.mockResolvedValue(operation);
      repository.pendingAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: archiveJobId });
      const unlocked = { ...authStub.user1, session: { id: newUuid(), hasElevatedPermission: true } };

      await sut.confirm(unlocked, operation.id, operation.requestKey);

      expect(repository.skipLocked).not.toHaveBeenCalled();
    });

    it('starts nothing for an empty selection', async () => {
      const operation = summaryOf({ count: 0, pending: 0 });
      repository.get.mockResolvedValue(operation);
      repository.pendingAssetIds.mockResolvedValue([]);

      await sut.confirm(authStub.user1, operation.id, operation.requestKey);

      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });
  });

  describe('undo', () => {
    it('stops a running archive, then undoes the whole frozen set as its own job', async () => {
      const operation = summaryOf({
        archiveJobId,
        archiveJobStatus: MediaOperationStatus.Rendering,
        archived: 1,
        pending: 2,
      });
      const ids = [newUuid(), newUuid(), newUuid()];
      const requestKey = newUuid();
      repository.get.mockResolvedValueOnce(operation).mockResolvedValueOnce({ ...operation, undoJobId });
      repository.orderedAssetIds.mockResolvedValue(ids);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      const response = await sut.undo(authStub.user1, operation.id, requestKey);

      expect(mediaOperations.cancel).toHaveBeenCalledWith(authStub.user1, archiveJobId);
      expect(mediaOperations.createBulk).toHaveBeenCalledWith(
        authStub.user1,
        expect.objectContaining({ action: MediaOperationBulkAction.Unarchive, assetIds: ids, requestId: requestKey }),
        { archiveOperationId: operation.id },
      );
      expect(repository.linkUndoJob).toHaveBeenCalledWith(operation.id, undoJobId);
      expect(response).toEqual(expect.objectContaining({ undoJobId, undoable: false }));
    });

    it('does not cancel an archive that already finished', async () => {
      const operation = summaryOf({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 3 });
      repository.get.mockResolvedValue(operation);
      repository.orderedAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });

      await sut.undo(authStub.user1, operation.id, newUuid());

      expect(mediaOperations.cancel).not.toHaveBeenCalled();
    });

    it('answers a repeated undo with the undo that already exists', async () => {
      const operation = summaryOf({ archiveJobId, undoJobId, archived: 0, undone: 3 });
      repository.get.mockResolvedValue(operation);

      await sut.undo(authStub.user1, operation.id, newUuid());

      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });

    it('refuses an archive with nothing left to undo', async () => {
      const operation = summaryOf({
        archiveJobId,
        archiveJobStatus: MediaOperationStatus.Completed,
        pending: 0,
        skipped: 3,
      });
      repository.get.mockResolvedValue(operation);

      await expect(sut.undo(authStub.user1, operation.id, newUuid())).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses the archive’s own request key, which would answer with the archive job', async () => {
      const operation = summaryOf({ archiveJobId, archived: 3 });
      repository.get.mockResolvedValue(operation);

      await expect(sut.undo(authStub.user1, operation.id, operation.requestKey)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mediaOperations.createBulk).not.toHaveBeenCalled();
    });

    it('refuses when a concurrent undo linked its job first', async () => {
      const operation = summaryOf({ archiveJobId, archiveJobStatus: MediaOperationStatus.Completed, archived: 3 });
      repository.get.mockResolvedValue(operation);
      repository.orderedAssetIds.mockResolvedValue([newUuid()]);
      mediaOperations.createBulk.mockResolvedValue({ id: undoJobId });
      repository.linkUndoJob.mockResolvedValue(false);

      await expect(sut.undo(authStub.user1, operation.id, newUuid())).rejects.toBeInstanceOf(ConflictException);
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
  });
});
