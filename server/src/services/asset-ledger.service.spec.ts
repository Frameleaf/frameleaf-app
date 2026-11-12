import { BadRequestException } from '@nestjs/common';
import { vi } from 'vitest';
import type { AssetLedgerCounts, AssetLedgerRow } from 'src/repositories/asset-ledger.repository.js';
import { AssetStatus } from 'src/enum.js';
import { AssetLedgerService, LEDGER_RECONCILE_PAGE } from 'src/services/asset-ledger.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const counts = (patch: Partial<AssetLedgerCounts> = {}): AssetLedgerCounts => ({
  kept: 0,
  trashed: 0,
  removed: 0,
  merged: 0,
  missing: 0,
  ...patch,
});

const row = (patch: Partial<AssetLedgerRow> = {}): AssetLedgerRow => ({
  assetId: '0b6ad2c2-7a3f-4c0e-9d57-3a1f1f5d9a01',
  checksum: Buffer.from('abc'),
  originalFileName: 'IMG_0001.jpg',
  addedAt: new Date('2026-01-02T03:04:05Z'),
  addedVia: 'upload',
  state: 'removed',
  stateAt: new Date('2026-11-10T08:15:30.123Z'),
  stateBy: 'a1b2c3d4-0000-4000-8000-000000000001',
  reason: 'deleted',
  cursorAt: '2026-11-10 08:15:30.123456+00',
  ...patch,
});

const setup = () => {
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ledger = {
    trashed: vi.fn().mockResolvedValue(undefined),
    restored: vi.fn().mockResolvedValue(undefined),
    removed: vi.fn().mockResolvedValue(undefined),
    counts: vi.fn().mockResolvedValue(counts()),
    missingByOwner: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    backfillPage: vi.fn().mockResolvedValue({ last: null, added: 0 }),
    reconcilePage: vi.fn().mockResolvedValue({ last: null, missing: 0, corrected: 0 }),
  };
  const sut = new AssetLedgerService(logger as never, ledger as never);
  return { sut, ledger, logger };
};

const ids = ['asset-1', 'asset-2'];
const userId = 'user-1';

describe(AssetLedgerService.name, () => {
  describe('write points', () => {
    it('moves trashed photos to the Trash in one write, with the person who trashed them', async () => {
      const { sut, ledger } = setup();
      await sut.onAssetTrashAll({ assetIds: ids, userId });
      expect(ledger.trashed).toHaveBeenCalledExactlyOnceWith(ids, userId);
    });

    it('brings restored photos back in one write, with the person who restored them', async () => {
      const { sut, ledger } = setup();
      await sut.onAssetRestoreAll({ assetIds: ids, userId });
      expect(ledger.restored).toHaveBeenCalledExactlyOnceWith(ids, userId);
    });

    it('marks an emptied Trash or a permanent deletion removed, with the person and the reason', async () => {
      const { sut, ledger } = setup();
      await sut.onAssetDeleteAll({ assetIds: ids, userId });
      expect(ledger.removed).toHaveBeenCalledExactlyOnceWith(ids, { by: userId, reason: 'deleted' });
    });

    it('reads an ordered trash-and-restore bundle as its owner’s changes', async () => {
      const { sut, ledger } = setup();
      await sut.onAssetLocalEffects({
        ownerId: userId,
        assets: [
          { assetId: 'asset-1', status: AssetStatus.Trashed, sourceEpoch: '1' },
          { assetId: 'asset-2', status: AssetStatus.Active, sourceEpoch: '1' },
          { assetId: 'asset-3', status: AssetStatus.Trashed, sourceEpoch: '1' },
        ],
      } as never);
      expect(ledger.trashed).toHaveBeenCalledExactlyOnceWith(['asset-1', 'asset-3'], userId);
      expect(ledger.restored).toHaveBeenCalledExactlyOnceWith(['asset-2'], userId);
    });

    it('never stops the change it records: a failed write is logged and left to the nightly pass', async () => {
      const { sut, ledger, logger } = setup();
      ledger.trashed.mockRejectedValueOnce(new Error('connection terminated'));
      await expect(sut.onAssetTrashAll({ assetIds: ids, userId })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nightly pass'));
    });
  });

  describe('nightly pass', () => {
    it('adds rows for photos that have none, then compares every row, a page at a time', async () => {
      const { sut, ledger } = setup();
      ledger.backfillPage
        .mockResolvedValueOnce({ last: 'asset-b', added: 20_000 })
        .mockResolvedValueOnce({ last: null, added: 5 });
      ledger.reconcilePage
        .mockResolvedValueOnce({ last: 'ledger-b', missing: 1, corrected: 2 })
        .mockResolvedValueOnce({ last: 'ledger-c', missing: 0, corrected: 0 })
        .mockResolvedValueOnce({ last: null, missing: 2, corrected: 1 });

      await expect(sut.reconcile()).resolves.toEqual({ added: 20_005, corrected: 3, missing: 3 });

      expect(ledger.backfillPage.mock.calls).toEqual([
        [null, LEDGER_RECONCILE_PAGE],
        ['asset-b', LEDGER_RECONCILE_PAGE],
      ]);
      expect(ledger.reconcilePage.mock.calls).toEqual([
        [null, LEDGER_RECONCILE_PAGE],
        ['ledger-b', LEDGER_RECONCILE_PAGE],
        ['ledger-c', LEDGER_RECONCILE_PAGE],
      ]);
      // every photo has its row before any row is judged
      expect(ledger.backfillPage.mock.invocationCallOrder.at(-1)).toBeLessThan(
        ledger.reconcilePage.mock.invocationCallOrder[0],
      );
    });

    it('warns when originals are found missing', async () => {
      const { sut, ledger, logger } = setup();
      ledger.reconcilePage.mockResolvedValueOnce({ last: null, missing: 2, corrected: 0 });
      await sut.onNightlyDatabaseCleanup();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('2 original(s) are gone'));
    });

    it('says nothing on a night with nothing to do', async () => {
      const { sut, logger } = setup();
      await sut.onNightlyDatabaseCleanup();
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not fail the other nightly cleanups when it cannot finish', async () => {
      const { sut, ledger, logger } = setup();
      ledger.backfillPage.mockRejectedValueOnce(new Error('statement timeout'));
      await expect(sut.onNightlyDatabaseCleanup()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('did not finish'));
    });
  });

  describe('reads', () => {
    it('totals the reader’s own ledger', async () => {
      const { sut, ledger } = setup();
      ledger.counts.mockResolvedValueOnce(counts({ kept: 10, trashed: 2, removed: 3, merged: 1, missing: 1 }));
      await expect(sut.getSummary(authStub.user1)).resolves.toEqual({
        total: 17,
        states: { kept: 10, trashed: 2, removed: 3, merged: 1, missing: 1 },
      });
      expect(ledger.counts).toHaveBeenCalledExactlyOnceWith(authStub.user1.user.id);
    });

    it('totals every account for an administrator and names the accounts with missing originals', async () => {
      const { sut, ledger } = setup();
      ledger.counts.mockResolvedValueOnce(counts({ kept: 5, missing: 2 }));
      ledger.missingByOwner.mockResolvedValueOnce([
        { ownerId: 'owner-1', count: 2, since: new Date('2026-11-09T02:00:00Z') },
      ]);
      await expect(sut.getAdminSummary()).resolves.toEqual({
        total: 7,
        states: counts({ kept: 5, missing: 2 }),
        missingByOwner: [{ ownerId: 'owner-1', count: 2, since: '2026-11-09T02:00:00.000Z' }],
      });
      expect(ledger.counts).toHaveBeenCalledExactlyOnceWith();
    });

    it('lists only the reader’s rows and leaves locked photos out of a session that has not unlocked them', async () => {
      const { sut, ledger } = setup();
      ledger.list.mockResolvedValueOnce([row()]);

      const response = await sut.getItems(authStub.user1, { state: 'removed', size: 50 });

      expect(ledger.list).toHaveBeenCalledExactlyOnceWith(authStub.user1.user.id, {
        state: 'removed',
        before: undefined,
        take: 51,
        hideLocked: true,
      });
      expect(response).toEqual({
        items: [
          {
            assetId: '0b6ad2c2-7a3f-4c0e-9d57-3a1f1f5d9a01',
            checksum: Buffer.from('abc').toString('base64'),
            originalFileName: 'IMG_0001.jpg',
            addedAt: '2026-01-02T03:04:05.000Z',
            addedVia: 'upload',
            state: 'removed',
            stateAt: '2026-11-10T08:15:30.123Z',
            stateBy: 'a1b2c3d4-0000-4000-8000-000000000001',
            reason: 'deleted',
          },
        ],
        nextCursor: null,
      });
    });

    it('lists locked photos to their owner in an unlocked session', async () => {
      const { sut, ledger } = setup();
      const auth = { ...authStub.user1, session: { ...authStub.user1.session!, hasElevatedPermission: true } };
      await sut.getItems(auth, {});
      expect(ledger.list).toHaveBeenCalledWith(auth.user.id, expect.objectContaining({ hideLocked: false, take: 201 }));
    });

    it('pages with a cursor that carries the database’s own timestamp', async () => {
      const { sut, ledger } = setup();
      const second = row({
        assetId: '0b6ad2c2-7a3f-4c0e-9d57-3a1f1f5d9a02',
        cursorAt: '2026-11-09 01:02:03.000004+00',
      });
      ledger.list.mockResolvedValueOnce([row(), second, row({ assetId: '0b6ad2c2-7a3f-4c0e-9d57-3a1f1f5d9a03' })]);

      const first = await sut.getItems(authStub.user1, { size: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));

      await sut.getItems(authStub.user1, { size: 2, cursor: first.nextCursor! });
      expect(ledger.list).toHaveBeenLastCalledWith(
        authStub.user1.user.id,
        expect.objectContaining({ before: { at: '2026-11-09 01:02:03.000004+00', assetId: second.assetId } }),
      );
    });

    it.each([
      'not-a-cursor',
      Buffer.from('2026-11-09|nope').toString('base64url'),
      Buffer.from('a|b|c').toString('base64url'),
    ])('refuses the cursor %s', async (cursor) => {
      const { sut, ledger } = setup();
      await expect(sut.getItems(authStub.user1, { cursor })).rejects.toBeInstanceOf(BadRequestException);
      expect(ledger.list).not.toHaveBeenCalled();
    });
  });
});
