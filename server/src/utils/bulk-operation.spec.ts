import { BadRequestException } from '@nestjs/common';
import { AssetVisibility, MediaOperationBulkAction, MediaOperationItemStatus } from 'src/enum.js';
import {
  BULK_RECORDED_ITEM_LIMIT,
  BulkOperationSnapshot,
  bulkAssetUpdate,
  bulkPayloadProblem,
  bulkProgress,
  bulkResumeIds,
  bulkRetryPending,
  carriedShiftOrigins,
  chunkIds,
  classifyBulkError,
  emptyBulkResult,
  fromBulkIdResponse,
  isMediaHealthBulkAction,
  isRelativeDateShift,
  mergeBulkOutcomes,
  parseBulkResult,
  parseBulkSnapshot,
  planBulkRetryPass,
  pruneShiftOrigins,
  recordShiftOrigins,
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

    it('includes an interrupted relative date shift, which is now safe to apply again', () => {
      const snapshot = snapshotOf({
        action: MediaOperationBulkAction.ChangeDate,
        payload: { dateMode: 'shift', minutes: 30 },
      });
      const result = { ...emptyBulkResult(5), inFlight: { start: 2, size: 2 } };

      expect(bulkResumeIds(snapshot, result, 2)).toEqual(['c', 'd', 'e']);
    });

    it('replays an interrupted batch of any other action', () => {
      const result = { ...emptyBulkResult(5), inFlight: { start: 2, size: 2 } };

      expect(bulkResumeIds(snapshotOf(), result, 2)).toEqual(['c', 'd', 'e']);
    });

    it('covers the items the automatic retry pass had not reached', () => {
      const result = {
        ...emptyBulkResult(5),
        succeeded: 3,
        retry: { ids: ['b', 'd'], total: 2, processed: 1, inFlight: null },
      };

      expect(bulkResumeIds(snapshotOf(), result, 5)).toEqual(['d']);
    });
  });

  describe(planBulkRetryPass.name, () => {
    const withOutcomes = () =>
      mergeBulkOutcomes(emptyBulkResult(5), [
        { id: 'a', status: MediaOperationItemStatus.Ok },
        { id: 'b', status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' },
        { id: 'c', status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_no_permission' },
        { id: 'd', status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' },
        { id: 'e', status: MediaOperationItemStatus.Ok },
      ]);

    it('moves every recorded failure into one retry pass, keeping the counts exact', () => {
      const planned = planBulkRetryPass(snapshotOf(), withOutcomes());

      expect(planned).toEqual(
        expect.objectContaining({
          succeeded: 2,
          failed: 0,
          skipped: 1,
          retry: { ids: ['b', 'd'], total: 2, processed: 0, inFlight: null },
        }),
      );
      expect(planned!.items.map((item) => item.id)).toEqual(['c']);
      expect(bulkRetryPending(planned!)).toEqual(['b', 'd']);
    });

    it('plans the pass only once and not at all without failures', () => {
      const planned = planBulkRetryPass(snapshotOf(), withOutcomes())!;

      expect(planBulkRetryPass(snapshotOf(), planned)).toBeNull();
      expect(planBulkRetryPass(snapshotOf(), emptyBulkResult(5))).toBeNull();
    });

    it('reads the pass back from the row, and its count without its ids as the list returns it', () => {
      const planned = planBulkRetryPass(snapshotOf(), withOutcomes())!;
      const stored = JSON.parse(JSON.stringify(planned));

      expect(parseBulkResult(stored, 5).retry).toEqual(planned.retry);
      expect(parseBulkResult({ ...stored, retry: { total: 2, processed: 1 } }, 5).retry).toEqual({
        ids: [],
        total: 2,
        processed: 1,
        inFlight: null,
      });
    });
  });

  describe('relative date shift origins', () => {
    const shift = snapshotOf({
      action: MediaOperationBulkAction.ChangeDate,
      payload: { dateMode: 'shift', minutes: 30 },
    });

    it('recognises only a relative shift', () => {
      expect(isRelativeDateShift(shift)).toBe(true);
      expect(isRelativeDateShift(snapshotOf({ action: MediaOperationBulkAction.ChangeDate, payload: {} }))).toBe(false);
      expect(isRelativeDateShift(snapshotOf())).toBe(false);
    });

    it('records a starting date once and never overwrites it with a shifted one', () => {
      const first = recordShiftOrigins(
        emptyBulkResult(5),
        ['a', 'b', 'c'],
        new Map<string, Date | null>([
          ['a', new Date('2026-09-22T10:00:00.000Z')],
          ['b', null],
        ]),
      );

      expect(first.shiftFrom).toEqual({ a: '2026-09-22T10:00:00.000Z', b: null });

      // The same batch again, after the shift reached `a`: its first value stands.
      const again = recordShiftOrigins(first, ['a'], new Map([['a', new Date('2026-09-22T10:30:00.000Z')]]));
      expect(again.shiftFrom.a).toBe('2026-09-22T10:00:00.000Z');
    });

    it('keeps starting dates only while an item might be applied again', () => {
      const result = {
        ...mergeBulkOutcomes(emptyBulkResult(5), [
          { id: 'a', status: MediaOperationItemStatus.Ok },
          { id: 'b', status: MediaOperationItemStatus.Failed },
        ]),
        inFlight: { start: 2, size: 1 },
        shiftFrom: {
          a: '2026-01-01T00:00:00.000Z',
          b: '2026-01-02T00:00:00.000Z',
          c: '2026-01-03T00:00:00.000Z',
          d: '2026-01-04T00:00:00.000Z',
        },
      };

      expect(Object.keys(pruneShiftOrigins(shift, result).shiftFrom).toSorted()).toEqual(['b', 'c']);
    });

    it('carries recorded starting dates over to a manual retry', () => {
      expect(carriedShiftOrigins({ shiftFrom: { a: null, b: '2026-01-02T00:00:00.000Z' } }, ['b', 'e'])).toEqual({
        b: '2026-01-02T00:00:00.000Z',
      });
    });

    it('reads back only well-formed starting dates', () => {
      const stored = { shiftFrom: { a: null, b: '2026-01-02T00:00:00.000Z', c: 'soon', d: 4 } };

      expect(parseBulkResult(stored, 4).shiftFrom).toEqual({ a: null, b: '2026-01-02T00:00:00.000Z' });
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

    it('builds an absolute date and leaves a relative shift to the runner', () => {
      // `dateTimeRelative` adds to the current date; repeating it would move items twice.
      expect(bulkAssetUpdate(MediaOperationBulkAction.ChangeDate, { dateMode: 'shift', minutes: -90 })).toBeNull();
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

    it('requires a matching still + video pair for every id in the frozen set (FL-70)', () => {
      expect(bulkPayloadProblem(MediaOperationBulkAction.RelinkLivePhoto, {}, ['a', 'b'])).not.toBeNull();
      expect(
        bulkPayloadProblem(MediaOperationBulkAction.RelinkLivePhoto, { pairs: [{ photoId: 'a', videoId: 'x' }] }, [
          'a',
          'b',
        ]),
      ).not.toBeNull();
      expect(
        bulkPayloadProblem(
          MediaOperationBulkAction.RelinkLivePhoto,
          {
            pairs: [
              { photoId: 'a', videoId: 'x' },
              { photoId: 'a', videoId: 'y' },
            ],
          },
          ['a'],
        ),
      ).not.toBeNull();
      expect(
        bulkPayloadProblem(MediaOperationBulkAction.RelinkLivePhoto, { pairs: [{ photoId: 'a', videoId: 'a' }] }, [
          'a',
        ]),
      ).not.toBeNull();
      expect(
        bulkPayloadProblem(
          MediaOperationBulkAction.RelinkLivePhoto,
          {
            pairs: [
              { photoId: 'a', videoId: 'x' },
              { photoId: 'b', videoId: 'y' },
            ],
          },
          ['a', 'b'],
        ),
      ).toBeNull();
    });

    it.each([MediaOperationBulkAction.RelinkMissingMedia, MediaOperationBulkAction.RecoverDamagedMedia])(
      'requires one reviewed finding and candidate for every item of %s (FL-69)',
      (action) => {
        const entry = (assetId: string, findingId: string, candidateId?: string) => ({
          assetId,
          findingId,
          candidateId,
        });
        expect(bulkPayloadProblem(action, {}, ['a'])).not.toBeNull();
        expect(bulkPayloadProblem(action, { mediaHealth: [entry('a', 'f1')] }, ['a'])).not.toBeNull();
        expect(bulkPayloadProblem(action, { mediaHealth: [entry('a', 'f1', 'c1')] }, ['a', 'b'])).not.toBeNull();
        expect(
          bulkPayloadProblem(action, { mediaHealth: [entry('a', 'f1', 'c1'), entry('a', 'f2', 'c2')] }, ['a']),
        ).not.toBeNull();
        expect(
          bulkPayloadProblem(action, { mediaHealth: [entry('a', 'f1', 'c1'), entry('b', 'f1', 'c2')] }, ['a', 'b']),
        ).not.toBeNull();
        expect(bulkPayloadProblem(action, { mediaHealth: [entry('a', 'f1', 'c1')] }, ['a'])).toBeNull();
      },
    );

    it('trashes confirmed damage without a candidate (FL-69)', () => {
      expect(
        bulkPayloadProblem(
          MediaOperationBulkAction.TrashDamagedMedia,
          { mediaHealth: [{ assetId: 'a', findingId: 'f1' }] },
          ['a'],
        ),
      ).toBeNull();
    });
  });

  describe(isMediaHealthBulkAction.name, () => {
    it('names exactly the three Library Care actions (FL-69)', () => {
      expect(Object.values(MediaOperationBulkAction).filter((action) => isMediaHealthBulkAction(action))).toEqual([
        MediaOperationBulkAction.RelinkMissingMedia,
        MediaOperationBulkAction.RecoverDamagedMedia,
        MediaOperationBulkAction.TrashDamagedMedia,
      ]);
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
