import { BadRequestException } from '@nestjs/common';
import { AssetVisibility, MediaOperationBulkAction, MediaOperationItemStatus } from 'src/enum.js';
import {
  BULK_RECORDED_ITEM_LIMIT,
  BulkOperationSnapshot,
  bulkAssetUpdate,
  bulkPayloadProblem,
  bulkProgress,
  bulkResumeIds,
  chunkIds,
  classifyBulkError,
  emptyBulkResult,
  fromBulkIdResponse,
  isReplaySafe,
  mergeBulkOutcomes,
  parseBulkResult,
  parseBulkSnapshot,
} from 'src/utils/bulk-operation.js';

const ids = ['a', 'b', 'c', 'd', 'e'];

const snapshotOf = (overrides: Partial<BulkOperationSnapshot> = {}): BulkOperationSnapshot => ({
  action: MediaOperationBulkAction.Favorite,
  assetIds: ids,
  payload: {},
  submittedTotal: null,
  truncated: false,
  requestId: null,
  apiKeyId: null,
  ...overrides,
});

describe('bulk-operation', () => {
  describe(parseBulkSnapshot.name, () => {
    it('refuses a snapshot it does not understand', () => {
      expect(() => parseBulkSnapshot(null)).toThrow();
      expect(() => parseBulkSnapshot({ action: 'rename-everything', assetIds: ids })).toThrow();
      expect(() => parseBulkSnapshot({ action: MediaOperationBulkAction.Favorite, assetIds: [] })).toThrow();
    });

    it('drops duplicate ids and keeps the order', () => {
      const parsed = parseBulkSnapshot({ action: MediaOperationBulkAction.Archive, assetIds: ['b', 'a', 'b', 'c'] });

      expect(parsed.assetIds).toEqual(['b', 'a', 'c']);
      expect(parsed.requestId).toBeNull();
      expect(parsed.apiKeyId).toBeNull();
    });
  });

  describe(mergeBulkOutcomes.name, () => {
    it('counts successes without recording them', () => {
      const merged = mergeBulkOutcomes(emptyBulkResult(3), [
        { id: 'a', status: MediaOperationItemStatus.Ok },
        { id: 'b', status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_no_permission' },
        { id: 'c', status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' },
      ]);

      expect(merged).toEqual(expect.objectContaining({ succeeded: 1, skipped: 1, failed: 1, itemsTruncated: false }));
      expect(merged.items.map((item) => item.id)).toEqual(['b', 'c']);
    });

    it('keeps counts exact and says so when the recorded list is full', () => {
      const outcomes = Array.from({ length: BULK_RECORDED_ITEM_LIMIT + 5 }, (_, index) => ({
        id: `id-${index}`,
        status: MediaOperationItemStatus.Failed,
      }));

      const merged = mergeBulkOutcomes(emptyBulkResult(outcomes.length), outcomes);

      expect(merged.failed).toBe(BULK_RECORDED_ITEM_LIMIT + 5);
      expect(merged.items).toHaveLength(BULK_RECORDED_ITEM_LIMIT);
      expect(merged.itemsTruncated).toBe(true);
    });
  });

  describe(parseBulkResult.name, () => {
    it('tolerates a row that has never been written to', () => {
      expect(parseBulkResult(null, 4)).toEqual(emptyBulkResult(4));
    });

    it('reads back the in-flight marker and ignores a malformed one', () => {
      expect(parseBulkResult({ inFlight: { start: 500, size: 500 } }, 1000).inFlight).toEqual({
        start: 500,
        size: 500,
      });
      expect(parseBulkResult({ inFlight: { start: -1, size: 'x' } }, 1000).inFlight).toBeNull();
    });
  });

  describe(bulkResumeIds.name, () => {
    it('covers failed and unreached items, never skipped or finished ones', () => {
      const result = mergeBulkOutcomes(emptyBulkResult(5), [
        { id: 'a', status: MediaOperationItemStatus.Ok },
        { id: 'b', status: MediaOperationItemStatus.Failed },
        { id: 'c', status: MediaOperationItemStatus.Skipped },
      ]);

      expect(bulkResumeIds(snapshotOf(), result, 3)).toEqual(['b', 'd', 'e']);
    });

    it('leaves out an interrupted relative date shift so nothing moves twice', () => {
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.ChangeDate,
        payload: { dateMode: 'shift', minutes: 30 },
      });
      const result = { ...emptyBulkResult(5), inFlight: { start: 2, size: 2 } };

      expect(bulkResumeIds(snapshot, result, 2)).toEqual(['e']);
    });

    it('replays an interrupted batch that is safe to repeat', () => {
      const result = { ...emptyBulkResult(5), inFlight: { start: 2, size: 2 } };

      expect(bulkResumeIds(snapshotOf(), result, 2)).toEqual(['c', 'd', 'e']);
    });
  });

  describe(isReplaySafe.name, () => {
    it('treats only a relative date shift as unsafe to repeat', () => {
      expect(isReplaySafe(snapshotOf())).toBe(true);
      expect(
        isReplaySafe(snapshotOf({ action: MediaOperationBulkAction.ChangeDate, payload: { dateMode: 'set' } })),
      ).toBe(true);
      expect(
        isReplaySafe(snapshotOf({ action: MediaOperationBulkAction.ChangeDate, payload: { dateMode: 'shift' } })),
      ).toBe(false);
    });
  });

  describe(classifyBulkError.name, () => {
    it('pins the access refusal wording from requireAccess', () => {
      expect(classifyBulkError(new BadRequestException('Not found or no asset.update access'))).toEqual({
        status: MediaOperationItemStatus.Skipped,
        reasonKey: 'frameleaf_bulk_reason_no_permission',
      });
    });

    it('treats anything else as a retryable failure', () => {
      expect(classifyBulkError(new Error('connection reset')).status).toBe(MediaOperationItemStatus.Failed);
    });
  });

  describe(fromBulkIdResponse.name, () => {
    it('maps per-id answers onto outcomes', () => {
      expect(fromBulkIdResponse({ id: 'a', success: true }).status).toBe(MediaOperationItemStatus.Ok);
      expect(fromBulkIdResponse({ id: 'a', success: false, error: 'duplicate' })).toEqual(
        expect.objectContaining({
          status: MediaOperationItemStatus.Skipped,
          reasonKey: 'frameleaf_bulk_reason_duplicate',
        }),
      );
      expect(fromBulkIdResponse({ id: 'a', success: false, error: 'unknown' }).status).toBe(
        MediaOperationItemStatus.Failed,
      );
    });
  });

  describe(bulkAssetUpdate.name, () => {
    it('never writes the Locked visibility', () => {
      for (const action of Object.values(MediaOperationBulkAction)) {
        expect(bulkAssetUpdate(action, {})?.visibility).not.toBe(AssetVisibility.Locked);
      }
    });

    it('builds a relative shift and an absolute date', () => {
      expect(bulkAssetUpdate(MediaOperationBulkAction.ChangeDate, { dateMode: 'shift', minutes: -90 })).toEqual({
        dateTimeRelative: -90,
      });
      expect(
        bulkAssetUpdate(MediaOperationBulkAction.ChangeDate, {
          dateMode: 'set',
          dateTimeOriginal: '2026-09-22T10:00:00.000Z',
          timeZone: 'America/Edmonton',
        }),
      ).toEqual({ dateTimeOriginal: '2026-09-22T10:00:00.000Z', timeZone: 'America/Edmonton' });
    });
  });

  describe(bulkPayloadProblem.name, () => {
    it('requires what each action needs', () => {
      expect(bulkPayloadProblem(MediaOperationBulkAction.Favorite, {}, ids)).toBeNull();
      expect(bulkPayloadProblem(MediaOperationBulkAction.AddToAlbum, {}, ids)).not.toBeNull();
      expect(bulkPayloadProblem(MediaOperationBulkAction.Tag, { tagIds: [] }, ids)).not.toBeNull();
      expect(bulkPayloadProblem(MediaOperationBulkAction.ChangeDate, { dateMode: 'set' }, ids)).not.toBeNull();
      expect(
        bulkPayloadProblem(
          MediaOperationBulkAction.ChangeDate,
          { dateMode: 'set', dateTimeOriginal: '2026-09-22T10:00:00Z', timeZone: 'Not/AZone' },
          ids,
        ),
      ).not.toBeNull();
      expect(bulkPayloadProblem(MediaOperationBulkAction.Stack, {}, ['a'])).not.toBeNull();
      expect(bulkPayloadProblem(MediaOperationBulkAction.Stack, { primaryId: 'z' }, ids)).not.toBeNull();
    });

    it('allows clearing a description', () => {
      expect(bulkPayloadProblem(MediaOperationBulkAction.ChangeDescription, { description: '' }, ids)).toBeNull();
    });
  });

  describe(chunkIds.name, () => {
    it('splits in order', () => {
      expect(chunkIds(ids, 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    });
  });

  describe(bulkProgress.name, () => {
    it('is a clamped percentage of answered items', () => {
      expect(bulkProgress(1, 3)).toBe(33.33);
      expect(bulkProgress(5, 3)).toBe(100);
      expect(bulkProgress(0, 0)).toBe(0);
    });
  });
});
