import { AssetType, DuplicateDecisionKind, DuplicateGroupKind, DuplicateQualityReason } from 'src/enum.js';
import {
  type DuplicateGroupDecision,
  classifyDuplicateGroup,
  duplicateDecisionProblem,
  duplicateGroupIndex,
  duplicateQualityReasons,
  duplicateStackPrimary,
  duplicateTrashIds,
  groupAlignedBatchSize,
  parseDuplicateGroups,
} from 'src/utils/duplicate-review.js';

const rawImage = (id: string, dateTimeOriginal: string | null, exif: Record<string, unknown> = {}) => ({
  id,
  type: AssetType.Image,
  localDateTime: dateTimeOriginal ?? '2026-09-06T16:24:12.000Z',
  originalFileName: `${id}.jpg`,
  exifInfo: { dateTimeOriginal, ...exif },
});

const image = (id: string, dateTimeOriginal: string | null, exif: Record<string, unknown> = {}) =>
  rawImage(id, dateTimeOriginal, exif) as never;

const group = (overrides: Partial<DuplicateGroupDecision> = {}): DuplicateGroupDecision => ({
  duplicateId: 'g1',
  decision: DuplicateDecisionKind.Keepers,
  memberIds: ['a', 'b', 'c'],
  keepAssetIds: ['a'],
  ...overrides,
});

describe('duplicate review rules', () => {
  describe('classifyDuplicateGroup', () => {
    it('reads copies captured at the same instant as duplicates', () => {
      expect(
        classifyDuplicateGroup([image('a', '2026-09-06T16:24:12.000Z'), image('b', '2026-09-06T16:24:12.000Z')]),
      ).toBe(DuplicateGroupKind.Duplicates);
    });

    it('reads photos at distinct instants within a few seconds as a burst', () => {
      const frames = Array.from({ length: 24 }, (_, index) =>
        image(`f${index}`, new Date(Date.UTC(2026, 8, 6, 16, 24, 12) + index * 100).toISOString()),
      );
      expect(classifyDuplicateGroup(frames)).toBe(DuplicateGroupKind.Burst);
    });

    it('reads a group as copies when two share an instant, a time is missing, or it spans too long', () => {
      expect(
        classifyDuplicateGroup([
          image('a', '2026-09-06T16:24:12.000Z'),
          image('b', '2026-09-06T16:24:12.100Z'),
          image('c', '2026-09-06T16:24:12.100Z'),
        ]),
      ).toBe(DuplicateGroupKind.Duplicates);
      const undated = { ...rawImage('b', null), localDateTime: '' } as never;
      expect(classifyDuplicateGroup([image('a', '2026-09-06T16:24:12.000Z'), undated])).toBe(
        DuplicateGroupKind.Duplicates,
      );
      const later = image('b', '2026-09-06T16:30:12.000Z');
      expect(classifyDuplicateGroup([image('a', '2026-09-06T16:24:12.000Z'), later])).toBe(
        DuplicateGroupKind.Duplicates,
      );
    });

    it('never reads videos as a burst', () => {
      const clip = { ...rawImage('b', '2026-09-06T16:24:13.000Z'), type: AssetType.Video } as never;
      expect(classifyDuplicateGroup([image('a', '2026-09-06T16:24:12.000Z'), clip])).toBe(
        DuplicateGroupKind.Duplicates,
      );
    });
  });

  describe('duplicateQualityReasons', () => {
    it('explains the original against the compressed, smaller copy', () => {
      const raw = {
        ...rawImage('raw', '2026-09-06T16:24:12.000Z', {
          exifImageWidth: 6000,
          exifImageHeight: 4000,
          fileSizeInByte: 48_600_000,
          make: 'Sony',
        }),
        originalFileName: 'Moraine Lake.ARW',
      } as never;
      const copy = image('copy', '2026-09-06T16:24:12.000Z', {
        exifImageWidth: 3840,
        exifImageHeight: 2160,
        fileSizeInByte: 4_400_000,
      });

      const reasons = duplicateQualityReasons([raw, copy]);

      expect(reasons.get('raw')).toEqual([
        DuplicateQualityReason.OriginalFormat,
        DuplicateQualityReason.HighestResolution,
        DuplicateQualityReason.LargestFile,
        DuplicateQualityReason.MostMetadata,
      ]);
      expect(reasons.get('copy')).toEqual([
        DuplicateQualityReason.CompressedCopy,
        DuplicateQualityReason.LowerResolution,
      ]);
    });

    it('says nothing about identical copies', () => {
      const a = image('a', null, { exifImageWidth: 100, exifImageHeight: 100, fileSizeInByte: 10 });
      const b = image('b', null, { exifImageWidth: 100, exifImageHeight: 100, fileSizeInByte: 10 });
      const reasons = duplicateQualityReasons([a, b]);
      expect(reasons.get('a')).toEqual([]);
      expect(reasons.get('b')).toEqual([]);
    });
  });

  describe('decisions', () => {
    it('trashes every member that is not kept, for keepers only', () => {
      expect(duplicateTrashIds(group({ keepAssetIds: ['a', 'c'] }))).toEqual(['b']);
      expect(duplicateTrashIds(group({ decision: DuplicateDecisionKind.KeepAll }))).toEqual([]);
      expect(duplicateTrashIds(group({ decision: DuplicateDecisionKind.Stack }))).toEqual([]);
    });

    it('puts the first keeper on top of a stack, or the first member', () => {
      expect(duplicateStackPrimary(group({ keepAssetIds: ['c'] }))).toBe('c');
      expect(duplicateStackPrimary(group({ keepAssetIds: [] }))).toBe('a');
    });

    it('accepts complete, disjoint groups whose members are the job, group by group', () => {
      const groups = [group(), group({ duplicateId: 'g2', memberIds: ['d', 'e'], keepAssetIds: ['e'] })];
      expect(duplicateDecisionProblem(groups, ['a', 'b', 'c', 'd', 'e'], { undo: false })).toBeNull();
    });

    it('refuses a keeper outside the group, a keepers decision with none, and a lone photo', () => {
      expect(duplicateDecisionProblem([group({ keepAssetIds: ['z'] })], ['a', 'b', 'c'], { undo: false })).toMatch(
        /same group/,
      );
      expect(duplicateDecisionProblem([group({ keepAssetIds: [] })], ['a', 'b', 'c'], { undo: false })).toMatch(
        /at least one/,
      );
      expect(duplicateDecisionProblem([group({ memberIds: ['a'] })], ['a'], { undo: false })).toMatch(/two photos/);
    });

    it('refuses a photo in two groups, a group twice, and a job whose photos are not its groups in order', () => {
      const overlapping = [group(), group({ duplicateId: 'g2', memberIds: ['c', 'd'], keepAssetIds: ['d'] })];
      expect(duplicateDecisionProblem(overlapping, ['a', 'b', 'c', 'c', 'd'], { undo: false })).toMatch(
        /one duplicate/,
      );
      expect(duplicateDecisionProblem([group(), group()], ['a', 'b', 'c', 'a', 'b', 'c'], { undo: false })).toMatch(
        /only be decided once/,
      );
      expect(duplicateDecisionProblem([group()], ['a', 'c', 'b'], { undo: false })).toMatch(/group by group/);
      expect(duplicateDecisionProblem([group()], ['a', 'b'], { undo: false })).toMatch(/group by group/);
    });

    it('refuses an undo that does not name the decision it reverses', () => {
      expect(duplicateDecisionProblem([group()], ['a', 'b', 'c'], { undo: true })).toMatch(/decision it reverses/);
      expect(duplicateDecisionProblem([group({ decisionId: 'd1' })], ['a', 'b', 'c'], { undo: true })).toBeNull();
    });

    it('reads groups back defensively, dropping malformed ones', () => {
      expect(
        parseDuplicateGroups([
          { duplicateId: 'g1', decision: 'keepers', memberIds: ['a', 'a', 'b', 3], keepAssetIds: ['a'] },
          { duplicateId: 'g2', decision: 'delete-everything', memberIds: ['c', 'd'] },
          'nonsense',
        ]),
      ).toEqual([
        { duplicateId: 'g1', decision: DuplicateDecisionKind.Keepers, memberIds: ['a', 'b'], keepAssetIds: ['a'] },
      ]);
      expect(parseDuplicateGroups(undefined)).toEqual([]);
    });
  });

  describe('groupAlignedBatchSize', () => {
    const groups = [
      group({ duplicateId: 'g1', memberIds: ['a', 'b'] }),
      group({ duplicateId: 'g2', memberIds: ['c', 'd', 'e'] }),
      group({ duplicateId: 'g3', memberIds: ['f', 'g'] }),
    ];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const index = duplicateGroupIndex(groups);

    it('ends a batch at the end of the group it would otherwise split', () => {
      expect(groupAlignedBatchSize(ids, 0, 3, index)).toBe(5);
      expect(groupAlignedBatchSize(ids, 5, 3, index)).toBe(2);
    });

    it('keeps a batch that already ends on a boundary as it is', () => {
      expect(groupAlignedBatchSize(ids, 0, 2, index)).toBe(2);
    });

    it('takes a group larger than a batch whole', () => {
      expect(groupAlignedBatchSize(ids, 2, 1, index)).toBe(3);
    });

    it('answers nothing past the end', () => {
      expect(groupAlignedBatchSize(ids, 7, 3, index)).toBe(0);
    });
  });
});
