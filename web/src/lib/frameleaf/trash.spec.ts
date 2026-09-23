import { AssetTypeEnum, type TrashItemResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  allSelected,
  deleteConfirmationPhrase,
  errorStatus,
  isStaleReview,
  matchesDeleteConfirmation,
  mergeTrashPage,
  pruneSelection,
  remainingNames,
  toggleSelection,
  trashAgeDays,
  trashAgeLabel,
  trashTypeFilter,
  withoutIds,
} from '$lib/frameleaf/trash';

const item = (id: string, overrides: Partial<TrashItemResponseDto> = {}): TrashItemResponseDto => ({
  id,
  originalFileName: `${id}.jpg`,
  type: AssetTypeEnum.Image,
  fileSizeInByte: 1024,
  trashedAt: '2026-09-20T10:00:00.000Z',
  isLocked: false,
  isOffline: false,
  ...overrides,
});

const now = Date.parse('2026-09-23T12:00:00.000Z');

describe('trash (FL-47)', () => {
  describe('permanent deletion confirmation', () => {
    it('should ask for DELETE and the count, as the template does', () => {
      expect(deleteConfirmationPhrase(12)).toBe('DELETE 12');
      expect(matchesDeleteConfirmation({ count: 12 }, 'DELETE 12')).toBe(true);
      expect(matchesDeleteConfirmation({ count: 12 }, '  DELETE 12 ')).toBe(true);
      expect(matchesDeleteConfirmation({ count: 12 }, 'DELETE 11')).toBe(false);
      expect(matchesDeleteConfirmation({ count: 12 }, 'delete 12')).toBe(false);
    });
  });

  describe('age', () => {
    it('should count whole days in the trash', () => {
      expect(trashAgeDays('2026-09-20T10:00:00.000Z', now)).toBe(3);
      expect(trashAgeDays('2026-09-23T11:00:00.000Z', now)).toBe(0);
    });

    it('should not invent an age for a missing, unreadable or future date', () => {
      expect(trashAgeDays(null, now)).toBeNull();
      expect(trashAgeDays('yesterday', now)).toBeNull();
      expect(trashAgeDays('2026-09-24T00:00:00.000Z', now)).toBeNull();
    });

    it('should label today, days ago and unknown dates', () => {
      expect(trashAgeLabel('2026-09-23T11:00:00.000Z', now)).toEqual({ key: 'frameleaf_trash_age_today', values: {} });
      expect(trashAgeLabel('2026-09-22T11:00:00.000Z', now)).toEqual({
        key: 'frameleaf_trash_age_days',
        values: { count: 1 },
      });
      expect(trashAgeLabel(null, now)).toEqual({ key: 'frameleaf_trash_age_unknown', values: {} });
    });
  });

  describe('filters', () => {
    it('should map the media filter to the server type', () => {
      expect(trashTypeFilter('all')).toBeUndefined();
      expect(trashTypeFilter('image')).toBe(AssetTypeEnum.Image);
      expect(trashTypeFilter('video')).toBe(AssetTypeEnum.Video);
    });
  });

  describe('selection', () => {
    it('should keep only ids still on the page', () => {
      expect(pruneSelection(['a', 'b', 'c'], [item('c'), item('a')])).toEqual(['a', 'c']);
    });

    it('should toggle one id', () => {
      expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
      expect(toggleSelection(['a', 'b'], 'a')).toEqual(['b']);
    });

    it('should report every row chosen, and nothing for an empty page', () => {
      expect(allSelected(['a', 'b'], [item('a'), item('b')])).toBe(true);
      expect(allSelected(['a'], [item('a'), item('b')])).toBe(false);
      expect(allSelected([], [])).toBe(false);
    });
  });

  describe('pages', () => {
    it('should replace the list on a first page and append later pages without repeats', () => {
      const shown = [item('a'), item('b')];
      expect(mergeTrashPage(shown, [item('c')], true).map(({ id }) => id)).toEqual(['c']);
      expect(mergeTrashPage(shown, [item('b'), item('c')], false).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    });

    it('should drop rows that left the trash', () => {
      expect(withoutIds([item('a'), item('b')], ['a']).map(({ id }) => id)).toEqual(['b']);
      expect(withoutIds([item('a')], [])).toHaveLength(1);
    });
  });

  describe('review', () => {
    it('should say how many names are not listed', () => {
      expect(remainingNames({ names: ['a', 'b'], count: 10 })).toBe(8);
      expect(remainingNames({ names: ['a', 'b'], count: 2 })).toBeNull();
    });

    it('should recognise a review that went stale', () => {
      expect(isStaleReview({ status: 409 })).toBe(true);
      expect(isStaleReview({ status: 400 })).toBe(false);
      expect(isStaleReview(new Error('offline'))).toBe(false);
      expect(errorStatus('nope')).toBeUndefined();
    });
  });
});
