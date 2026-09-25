import { BadRequestException, ConflictException } from '@nestjs/common';
import { TrashItemSort, UtilityActivityAction, UtilityActivityTool } from 'src/dtos/trash.dto.js';
import { AssetStatus, AssetType, JobName, JobStatus } from 'src/enum.js';
import { TrashService } from 'src/services/trash.service.js';
import {
  TrashReviewAction,
  type TrashReviewRow,
  type TrashScopeRow,
  trashReviewToken,
} from 'src/utils/trash-review.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

async function* makeAssetIdStream(count: number): AsyncIterableIterator<{ id: string }> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
    yield { id: `asset-${i + 1}` };
  }
}

const trashedAt = new Date('2026-09-20T10:00:00.000Z');

const scopeRow = (id: string, overrides: Partial<TrashScopeRow> = {}): TrashScopeRow => ({
  id,
  ownerId: 'user-id',
  status: AssetStatus.Trashed,
  deletedAt: trashedAt,
  isLocked: false,
  ...overrides,
});

const reviewRow = (id: string, overrides: Partial<TrashReviewRow> = {}): TrashReviewRow => ({
  ...scopeRow(id),
  originalFileName: `${id}.jpg`,
  fileSizeInByte: 1000,
  sharesOriginal: false,
  ...overrides,
});

describe(TrashService.name, () => {
  let sut: TrashService;
  let mocks: ServiceMocks;

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TrashService));
  });

  /** Apply the service's verify callback to `rows`, as the repository does inside its transaction. */
  const applyAgainst = (rows: TrashScopeRow[]) =>
    mocks.trash.applyReviewed.mockImplementation((_userId, _action, _ids, _options, verify) =>
      Promise.resolve(verify(rows) ? rows.map((row) => row.id) : null),
    );

  describe('restoreAssets', () => {
    it('should require asset restore access for all ids', async () => {
      await expect(
        sut.restoreAssets(authStub.user1, {
          ids: ['asset-1'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should handle an empty list', async () => {
      await expect(sut.restoreAssets(authStub.user1, { ids: [] })).resolves.toEqual({ count: 0 });
      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
    });

    it('should restore a batch of assets', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1', 'asset2']));
      mocks.trash.restoreAll.mockResolvedValue(['asset1', 'asset2']);

      await expect(sut.restoreAssets(authStub.user1, { ids: ['asset1', 'asset2'] })).resolves.toEqual({ count: 2 });

      expect(mocks.trash.restoreAll).toHaveBeenCalledWith(['asset1', 'asset2']);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetRestoreAll', {
        assetIds: ['asset1', 'asset2'],
        userId: 'user-id',
      });
      expect(mocks.job.queue.mock.calls).toEqual([]);
    });

    it('should report only the items that were still in the trash (stale restore)', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1', 'asset2']));
      mocks.trash.restoreAll.mockResolvedValue(['asset2']);

      await expect(sut.restoreAssets(authStub.user1, { ids: ['asset1', 'asset2'] })).resolves.toEqual({ count: 1 });

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetRestoreAll', { assetIds: ['asset2'], userId: 'user-id' });
    });

    it('should not announce a restore that changed nothing', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset1']));
      mocks.trash.restoreAll.mockResolvedValue([]);

      await expect(sut.restoreAssets(authStub.user1, { ids: ['asset1'] })).resolves.toEqual({ count: 0 });

      expect(mocks.event.emit).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('should handle an empty trash', async () => {
      mocks.trash.applyReviewed.mockResolvedValue([]);
      await expect(sut.restore(authStub.user1)).resolves.toEqual({ count: 0 });
      expect(mocks.trash.applyReviewed).toHaveBeenCalledWith(
        'user-id',
        TrashReviewAction.RestoreAll,
        undefined,
        { privacy: {} },
        expect.any(Function),
      );
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should restore', async () => {
      mocks.trash.applyReviewed.mockResolvedValue(['asset-1']);
      await expect(sut.restore(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetRestoreAll', { assetIds: ['asset-1'], userId: 'user-id' });
    });
  });

  describe('empty', () => {
    it('should handle an empty trash', async () => {
      mocks.trash.applyReviewed.mockResolvedValue([]);
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 0 });
      expect(mocks.event.emit).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should empty the trash', async () => {
      mocks.trash.applyReviewed.mockResolvedValue(['asset-1']);
      await expect(sut.empty(authStub.user1)).resolves.toEqual({ count: 1 });
      expect(mocks.trash.applyReviewed).toHaveBeenCalledWith(
        'user-id',
        TrashReviewAction.Empty,
        undefined,
        { privacy: {} },
        expect.any(Function),
      );
      // the empty-trash job is queued by the AssetDeleteAll listener
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetDeleteAll', { assetIds: ['asset-1'], userId: 'user-id' });
    });
  });

  describe('Locked media (FL-34)', () => {
    it('should restore and empty Locked media in the trash only from an elevated session', async () => {
      const elevated = authStub.adminWithElevatedPermission;
      mocks.trash.applyReviewed.mockResolvedValue([]);

      await sut.restore(elevated);
      await sut.empty(elevated);

      expect(mocks.trash.applyReviewed).toHaveBeenCalledWith(
        elevated.user.id,
        TrashReviewAction.RestoreAll,
        undefined,
        { lockedOwnerId: elevated.user.id, privacy: {} },
        expect.any(Function),
      );
      expect(mocks.trash.applyReviewed).toHaveBeenCalledWith(
        elevated.user.id,
        TrashReviewAction.Empty,
        undefined,
        { lockedOwnerId: elevated.user.id, privacy: {} },
        expect.any(Function),
      );
    });

    it('should never widen an ordinary session to Locked media', async () => {
      mocks.trash.getSummary.mockResolvedValue({ count: 0, offline: 0, bytes: 0, pendingDeletion: 0 });

      await sut.getSummary(authStub.user1);

      expect(mocks.trash.getSummary).toHaveBeenCalledWith('user-id', { privacy: {} });
    });
  });

  describe('privacy filters (FL-47)', () => {
    it('should keep hidden sensitive media out of an ordinary session', async () => {
      const auth = { ...authStub.user1, hideNsfwAssets: true };
      mocks.trash.getSummary.mockResolvedValue({ count: 0, offline: 0, bytes: 0, pendingDeletion: 0 });

      await sut.getSummary(auth);

      expect(mocks.trash.getSummary).toHaveBeenCalledWith('user-id', { privacy: { excludeNsfw: true } });
    });

    it('should apply suppressed people, pets and tags to the review', async () => {
      const hiddenContent = {
        userId: 'user-id',
        includeNsfw: false,
        tagIds: ['tag-1'],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      };
      const auth = { ...authStub.user1, hiddenContent };
      mocks.trash.getReviewRows.mockResolvedValue([reviewRow('asset-1')]);

      await sut.review(auth, { action: TrashReviewAction.Empty });

      expect(mocks.trash.getReviewRows).toHaveBeenCalledWith('user-id', TrashReviewAction.Empty, undefined, {
        privacy: { hiddenContent },
      });
    });
  });

  describe('getItems', () => {
    it('should map a page of the trash', async () => {
      mocks.trash.getItems.mockResolvedValue({
        items: [
          {
            id: 'asset-1',
            originalFileName: 'Lake morning.mov',
            type: AssetType.Video,
            status: AssetStatus.Trashed,
            fileSizeInByte: '4819000000',
            deletedAt: trashedAt,
            isLocked: false,
            isOffline: false,
          },
        ],
        hasNextPage: true,
        total: 3,
      });

      await expect(
        sut.getItems(authStub.user1, { query: '  lake  morning ', sort: TrashItemSort.Size, size: 1 }),
      ).resolves.toEqual({
        items: [
          {
            id: 'asset-1',
            originalFileName: 'Lake morning.mov',
            type: AssetType.Video,
            fileSizeInByte: 4_819_000_000,
            trashedAt: trashedAt.toISOString(),
            isLocked: false,
            isOffline: false,
          },
        ],
        total: 3,
        nextPage: '2',
      });

      expect(mocks.trash.getItems).toHaveBeenCalledWith('user-id', {
        privacy: {},
        terms: ['lake', 'morning'],
        type: undefined,
        order: TrashItemSort.Size,
        page: 1,
        size: 1,
      });
    });
  });

  describe('missing external originals', () => {
    it("should mark only the library scan's missing originals, not trashed items whose file went missing", async () => {
      const row = {
        originalFileName: 'a.jpg',
        type: AssetType.Image,
        fileSizeInByte: null,
        deletedAt: trashedAt,
        isLocked: false,
        isOffline: true,
      };
      mocks.trash.getItems.mockResolvedValue({
        items: [
          { ...row, id: 'scan', status: AssetStatus.Active },
          { ...row, id: 'owner', status: AssetStatus.Trashed },
        ],
        hasNextPage: false,
        total: 2,
      });

      const { items } = await sut.getItems(authStub.user1, {});

      expect(items.map(({ id, isOffline }) => ({ id, isOffline }))).toEqual([
        { id: 'scan', isOffline: true },
        { id: 'owner', isOffline: false },
      ]);
    });
  });

  describe('review', () => {
    it('should refuse a move to the trash while the trash is turned off', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ trash: { enabled: false } });

      await expect(sut.review(authStub.user1, { action: TrashReviewAction.Trash, ids: ['asset-1'] })).rejects.toThrow(
        'Trash is turned off',
      );
      expect(mocks.trash.getReviewRows).not.toHaveBeenCalled();
    });

    it('should require chosen items for a delete', async () => {
      await expect(sut.review(authStub.user1, { action: TrashReviewAction.Delete, ids: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.trash.getReviewRows).not.toHaveBeenCalled();
    });

    it('should require owner access to chosen items', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(
        sut.review(authStub.user1, { action: TrashReviewAction.Delete, ids: ['asset-1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.trash.getReviewRows).not.toHaveBeenCalled();
    });

    it('should refuse when a chosen item is no longer in the trash', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));
      mocks.trash.getReviewRows.mockResolvedValue([reviewRow('asset-1')]);

      await expect(
        sut.review(authStub.user1, { action: TrashReviewAction.Delete, ids: ['asset-1', 'asset-2'] }),
      ).rejects.toThrow('A chosen item changed or is no longer available');
    });

    it('should refuse to review an empty trash', async () => {
      mocks.trash.getReviewRows.mockResolvedValue([]);

      await expect(sut.review(authStub.user1, { action: TrashReviewAction.Empty })).rejects.toThrow(
        'Your trash is already empty',
      );
    });

    it('should summarise the reviewed set without promising space from shared originals', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));
      const rows = [
        reviewRow('asset-1', { originalFileName: 'b.jpg', fileSizeInByte: '3000' }),
        reviewRow('asset-2', { originalFileName: 'a.jpg', fileSizeInByte: 2000, sharesOriginal: true }),
      ];
      mocks.trash.getReviewRows.mockResolvedValue(rows);

      await expect(
        sut.review(authStub.user1, { action: TrashReviewAction.Delete, ids: ['asset-1', 'asset-2', 'asset-1'] }),
      ).resolves.toEqual({
        action: TrashReviewAction.Delete,
        count: 2,
        bytes: 5000,
        retainedOriginals: 1,
        retainedBytes: 2000,
        names: ['a.jpg', 'b.jpg'],
        token: trashReviewToken('user-id', TrashReviewAction.Delete, rows),
      });
      expect(mocks.trash.getReviewRows).toHaveBeenCalledWith(
        'user-id',
        TrashReviewAction.Delete,
        ['asset-1', 'asset-2'],
        { privacy: {} },
      );
    });

    it('should ignore ids for the whole-trash actions', async () => {
      mocks.trash.getReviewRows.mockResolvedValue([reviewRow('asset-1')]);

      await sut.review(authStub.user1, { action: TrashReviewAction.Empty, ids: ['asset-9'] });

      expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
      expect(mocks.trash.getReviewRows).toHaveBeenCalledWith('user-id', TrashReviewAction.Empty, undefined, {
        privacy: {},
      });
    });
  });

  describe('utility activity (FL-47)', () => {
    const moved = [scopeRow('asset-1', { status: AssetStatus.Active, deletedAt: null })];
    const items = [{ assetId: 'asset-1', fileName: 'Lake.mov', bytes: 4_000_000_000 }];

    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.trash.getActivityItems.mockResolvedValue(items);
      mocks.trash.addUtilityActivity.mockResolvedValue(true);
    });

    it('records a move to the trash made from Large files', async () => {
      applyAgainst(moved);
      const token = trashReviewToken('user-id', TrashReviewAction.Trash, moved);

      await sut.apply(authStub.user1, {
        action: TrashReviewAction.Trash,
        ids: ['asset-1'],
        token,
        source: UtilityActivityTool.LargeFiles,
      });

      expect(mocks.trash.getActivityItems).toHaveBeenCalledWith('user-id', ['asset-1']);
      expect(mocks.trash.addUtilityActivity).toHaveBeenCalledWith({
        userId: 'user-id',
        tool: UtilityActivityTool.LargeFiles,
        action: UtilityActivityAction.Trash,
        items,
      });
    });

    it('records an undo as a restore', async () => {
      const trashed = [scopeRow('asset-1')];
      applyAgainst(trashed);
      const token = trashReviewToken('user-id', TrashReviewAction.Restore, trashed);

      await sut.apply(authStub.user1, {
        action: TrashReviewAction.Restore,
        ids: ['asset-1'],
        token,
        source: UtilityActivityTool.LargeFiles,
      });

      expect(mocks.trash.addUtilityActivity).toHaveBeenCalledWith(
        expect.objectContaining({ action: UtilityActivityAction.Restore }),
      );
    });

    it('records nothing for a change made elsewhere, or for a permanent delete', async () => {
      applyAgainst(moved);
      const token = trashReviewToken('user-id', TrashReviewAction.Trash, moved);
      await sut.apply(authStub.user1, { action: TrashReviewAction.Trash, ids: ['asset-1'], token });

      const trashed = [scopeRow('asset-1')];
      applyAgainst(trashed);
      await sut.apply(authStub.user1, {
        action: TrashReviewAction.Delete,
        ids: ['asset-1'],
        token: trashReviewToken('user-id', TrashReviewAction.Delete, trashed),
        source: UtilityActivityTool.LargeFiles,
      });

      expect(mocks.trash.addUtilityActivity).not.toHaveBeenCalled();
    });

    it('never fails the change when the history cannot be written', async () => {
      applyAgainst(moved);
      mocks.trash.addUtilityActivity.mockRejectedValue(new Error('down'));
      const token = trashReviewToken('user-id', TrashReviewAction.Trash, moved);

      await expect(
        sut.apply(authStub.user1, {
          action: TrashReviewAction.Trash,
          ids: ['asset-1'],
          token,
          source: UtilityActivityTool.LargeFiles,
        }),
      ).resolves.toEqual({ count: 1 });
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Utility activity not recorded'));
    });

    it('names only the items this session may still see', async () => {
      mocks.trash.getUtilityActivity.mockResolvedValue([
        {
          id: 'entry-1',
          action: UtilityActivityAction.Trash,
          createdAt: new Date('2026-09-25T12:00:00.000Z'),
          items: [
            { assetId: 'asset-1', fileName: 'Lake.mov', bytes: 4000 },
            { assetId: 'asset-locked', fileName: 'Private.mov', bytes: 9000 },
          ],
        },
      ]);
      mocks.trash.getVisibleIds.mockResolvedValue(new Set(['asset-1']));

      await expect(sut.getUtilityActivity(authStub.user1, { tool: UtilityActivityTool.LargeFiles })).resolves.toEqual({
        entries: [
          {
            id: 'entry-1',
            action: UtilityActivityAction.Trash,
            createdAt: '2026-09-25T12:00:00.000Z',
            itemCount: 1,
            bytes: 4000,
            items: [{ assetId: 'asset-1', fileName: 'Lake.mov', bytes: 4000 }],
            unavailableCount: 1,
          },
        ],
      });
      expect(mocks.trash.getVisibleIds).toHaveBeenCalledWith(
        'user-id',
        ['asset-1', 'asset-locked'],
        expect.not.objectContaining({ lockedOwnerId: 'user-id' }),
      );
    });
  });

  describe('apply', () => {
    const reviewed = [scopeRow('asset-1'), scopeRow('asset-2')];
    const token = trashReviewToken('user-id', TrashReviewAction.Empty, reviewed);

    it('should apply the reviewed set and queue the removal of its files', async () => {
      applyAgainst(reviewed);

      await expect(sut.apply(authStub.user1, { action: TrashReviewAction.Empty, token })).resolves.toEqual({
        count: 2,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetDeleteAll', {
        assetIds: ['asset-1', 'asset-2'],
        userId: 'user-id',
      });
    });

    it('should refuse when an item was added to the trash after the review', async () => {
      applyAgainst([...reviewed, scopeRow('asset-3')]);

      await expect(sut.apply(authStub.user1, { action: TrashReviewAction.Empty, token })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should refuse when an item was restored elsewhere after the review', async () => {
      applyAgainst([scopeRow('asset-1')]);

      await expect(sut.apply(authStub.user1, { action: TrashReviewAction.Empty, token })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('should refuse when an item was locked after the review', async () => {
      applyAgainst([scopeRow('asset-1'), scopeRow('asset-2', { isLocked: true })]);

      await expect(sut.apply(authStub.user1, { action: TrashReviewAction.Empty, token })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('should refuse a token reviewed for another action', async () => {
      applyAgainst(reviewed);

      await expect(sut.apply(authStub.user1, { action: TrashReviewAction.RestoreAll, token })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('should refuse when a chosen item is missing from the set', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1', 'asset-2']));
      const chosenToken = trashReviewToken('user-id', TrashReviewAction.Delete, [scopeRow('asset-1')]);
      applyAgainst([scopeRow('asset-1')]);

      await expect(
        sut.apply(authStub.user1, {
          action: TrashReviewAction.Delete,
          ids: ['asset-1', 'asset-2'],
          token: chosenToken,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('should move reviewed library items to the trash', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      const active = [scopeRow('asset-1', { status: AssetStatus.Active, deletedAt: null })];
      applyAgainst(active);

      await expect(
        sut.apply(authStub.user1, {
          action: TrashReviewAction.Trash,
          ids: ['asset-1'],
          token: trashReviewToken('user-id', TrashReviewAction.Trash, active),
        }),
      ).resolves.toEqual({ count: 1 });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', { assetIds: ['asset-1'], userId: 'user-id' });
    });

    it('should restore chosen items', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      applyAgainst([scopeRow('asset-1')]);

      await expect(
        sut.apply(authStub.user1, {
          action: TrashReviewAction.Restore,
          ids: ['asset-1'],
          token: trashReviewToken('user-id', TrashReviewAction.Restore, [scopeRow('asset-1')]),
        }),
      ).resolves.toEqual({ count: 1 });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetRestoreAll', { assetIds: ['asset-1'], userId: 'user-id' });
    });
  });

  describe('onAssetsDelete', () => {
    it('should queue the empty trash job', async () => {
      await expect(sut.onAssetsDelete()).resolves.toBeUndefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.AssetEmptyTrash, data: {} });
    });
  });

  describe('handleQueueEmptyTrash', () => {
    it('should queue asset delete jobs', async () => {
      mocks.trash.getDeletedIds.mockReturnValue(makeAssetIdStream(1));
      await expect(sut.handleEmptyTrash()).resolves.toEqual(JobStatus.Success);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetDelete,
          data: { id: 'asset-1', deleteOnDisk: true },
        },
      ]);
    });
  });
});
