import { AssetStatus } from 'src/enum.js';
import {
  TrashReviewAction,
  type TrashReviewRow,
  type TrashScopeRow,
  escapeLikeTerm,
  summarizeTrashReview,
  toByteCount,
  trashActionSourceStatus,
  trashActionTargetStatus,
  trashReviewToken,
  trashSearchTerms,
} from 'src/utils/trash-review.js';

const row = (id: string, overrides: Partial<TrashScopeRow> = {}): TrashScopeRow => ({
  id,
  ownerId: 'user-1',
  status: AssetStatus.Trashed,
  deletedAt: new Date('2026-09-01T00:00:00.000Z'),
  isLocked: false,
  ...overrides,
});

const reviewRow = (id: string, overrides: Partial<TrashReviewRow> = {}): TrashReviewRow => ({
  ...row(id),
  originalFileName: `${id}.jpg`,
  fileSizeInByte: 100,
  sharesOriginal: false,
  ...overrides,
});

describe('trash review (FL-47)', () => {
  describe('trashReviewToken', () => {
    it('should not depend on row order', () => {
      expect(trashReviewToken('user-1', TrashReviewAction.Empty, [row('a'), row('b')])).toBe(
        trashReviewToken('user-1', TrashReviewAction.Empty, [row('b'), row('a')]),
      );
    });

    it('should treat a string and a date for the same instant alike', () => {
      expect(trashReviewToken('user-1', TrashReviewAction.Empty, [row('a')])).toBe(
        trashReviewToken('user-1', TrashReviewAction.Empty, [row('a', { deletedAt: '2026-09-01T00:00:00.000Z' })]),
      );
    });

    it.each([
      ['an added item', [row('a'), row('b'), row('c')]],
      ['a removed item', [row('a')]],
      ['a newly locked item', [row('a'), row('b', { isLocked: true })]],
      ['a status change', [row('a'), row('b', { status: AssetStatus.Active })]],
      ['a new trash date', [row('a'), row('b', { deletedAt: new Date('2026-09-02T00:00:00.000Z') })]],
      ['another owner', [row('a'), row('b', { ownerId: 'user-2' })]],
    ])('should change with %s', (_, changed) => {
      const reviewed = trashReviewToken('user-1', TrashReviewAction.Empty, [row('a'), row('b')]);
      expect(trashReviewToken('user-1', TrashReviewAction.Empty, changed)).not.toBe(reviewed);
    });

    it('should differ between actions and between accounts', () => {
      const rows = [row('a')];
      const token = trashReviewToken('user-1', TrashReviewAction.Delete, rows);
      expect(trashReviewToken('user-1', TrashReviewAction.Restore, rows)).not.toBe(token);
      expect(trashReviewToken('user-2', TrashReviewAction.Delete, rows)).not.toBe(token);
    });
  });

  describe('statuses', () => {
    it('should start moves to the trash from the library and everything else from the trash', () => {
      expect(trashActionSourceStatus(TrashReviewAction.Trash)).toBe(AssetStatus.Active);
      for (const action of [
        TrashReviewAction.Restore,
        TrashReviewAction.RestoreAll,
        TrashReviewAction.Delete,
        TrashReviewAction.Empty,
      ]) {
        expect(trashActionSourceStatus(action)).toBe(AssetStatus.Trashed);
      }
    });

    it('should end each action in its own state', () => {
      expect(trashActionTargetStatus(TrashReviewAction.Trash)).toBe(AssetStatus.Trashed);
      expect(trashActionTargetStatus(TrashReviewAction.Restore)).toBe(AssetStatus.Active);
      expect(trashActionTargetStatus(TrashReviewAction.RestoreAll)).toBe(AssetStatus.Active);
      expect(trashActionTargetStatus(TrashReviewAction.Delete)).toBe(AssetStatus.Deleted);
      expect(trashActionTargetStatus(TrashReviewAction.Empty)).toBe(AssetStatus.Deleted);
    });
  });

  describe('summarizeTrashReview', () => {
    it('should count shared originals as retained', () => {
      expect(
        summarizeTrashReview([
          reviewRow('a', { fileSizeInByte: '2048' }),
          reviewRow('b', { fileSizeInByte: 1024, sharesOriginal: true }),
          reviewRow('c', { fileSizeInByte: null }),
        ]),
      ).toEqual({
        count: 3,
        bytes: 3072,
        retainedOriginals: 1,
        retainedBytes: 1024,
        names: ['a.jpg', 'b.jpg', 'c.jpg'],
      });
    });

    it('should list at most eight names, alphabetically', () => {
      const rows = 'jihgfedcba'.split('').map((id) => reviewRow(id));
      expect(summarizeTrashReview(rows).names).toEqual([
        'a.jpg',
        'b.jpg',
        'c.jpg',
        'd.jpg',
        'e.jpg',
        'f.jpg',
        'g.jpg',
        'h.jpg',
      ]);
    });
  });

  describe('helpers', () => {
    it('should read byte counts defensively', () => {
      expect(toByteCount('4819000000')).toBe(4_819_000_000);
      expect(toByteCount(null)).toBe(0);
      expect(toByteCount('not a number')).toBe(0);
      expect(toByteCount(-5)).toBe(0);
    });

    it('should split search words', () => {
      expect(trashSearchTerms('  lake   morning ')).toEqual(['lake', 'morning']);
      expect(trashSearchTerms(undefined)).toEqual([]);
    });

    it('should match wildcard characters literally', () => {
      expect(escapeLikeTerm('100%_done\\')).toBe(String.raw`100\%\_done\\`);
    });
  });
});
