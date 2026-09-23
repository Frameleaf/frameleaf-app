import {
  DuplicateDecisionKind,
  DuplicateGroupBlock,
  DuplicateGroupKind,
  MediaOperationItemStatus,
  MediaOperationStatus,
  type DuplicateDecisionBatchDto,
  type MediaOperationDetailDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildDecisionGroups,
  canSuggest,
  decisionAssetIds,
  decisionParts,
  DuplicateDecisionError,
  filterReviewGroups,
  frameOffsetSeconds,
  groupProgressFrom,
  isActionable,
  matchReviewShortcut,
  nextGroupId,
  suggestedKeeper,
  toggleKeepers,
  undoableBatches,
  undoGroupsFor,
  usesContactSheet,
  type GroupProgress,
  type ReviewGroup,
} from '$lib/frameleaf/duplicate-review';

const asset = (id: string, name = `${id}.jpg`, time = '2026-09-06T16:24:12.000Z') =>
  ({
    id,
    originalFileName: name,
    localDateTime: time,
    thumbhash: null,
    exifInfo: { dateTimeOriginal: time, fileSizeInByte: 1000 },
  }) as unknown as ReviewGroup['assets'][number];

const group = (id: string, ids: string[], overrides: Partial<ReviewGroup> = {}): ReviewGroup => ({
  duplicateId: id,
  assets: ids.map((assetId) => asset(assetId)),
  suggestedKeepAssetIds: [ids[0]],
  kind: DuplicateGroupKind.Duplicates,
  editable: true,
  blockedReason: null,
  hiddenMemberCount: 0,
  totalBytes: ids.length * 1000,
  qualities: [],
  ...overrides,
});

const none = new Map<string, GroupProgress>();

describe('duplicate review', () => {
  describe('filterReviewGroups', () => {
    const lake = group('lake', ['lake-raw', 'lake-copy'], {
      assets: [asset('lake-raw', 'Moraine Lake.ARW'), asset('lake-copy', 'Moraine Lake copy.jpg')],
    });
    const hike = group('hike', ['hike-1', 'hike-2'], {
      editable: false,
      blockedReason: DuplicateGroupBlock.OtherOwner,
    });
    const ids = (groups: ReviewGroup[]) => groups.map(({ duplicateId }) => duplicateId);
    const forest = group('forest', ['forest-1', 'forest-2']);

    it('lists the groups the person can decide first', () => {
      expect(ids(filterReviewGroups([hike, lake, forest], { progress: none }))).toEqual(['lake', 'forest', 'hike']);
    });

    it('narrows the groups a search matches, never the photos inside a group', () => {
      const [match] = filterReviewGroups([lake, forest], { query: 'moraine copy', progress: none });
      expect(match.duplicateId).toBe('lake');
      expect(match.assets).toHaveLength(2);
    });

    it('hides decided groups from "Needs attention" and shows them in "All results"', () => {
      const progress = new Map<string, GroupProgress>([['lake', { state: 'done' }]]);
      expect(ids(filterReviewGroups([lake, forest], { progress }))).toEqual(['forest']);
      expect(filterReviewGroups([lake, forest], { filter: 'all', progress })).toHaveLength(2);
    });
  });

  describe('suggestions', () => {
    it('never suggests a keeper in a burst, nor guesses between two suggestions', () => {
      expect(suggestedKeeper(group('b', ['a', 'b'], { kind: DuplicateGroupKind.Burst }))).toBeNull();
      expect(suggestedKeeper(group('g', ['a', 'b'], { suggestedKeepAssetIds: ['a', 'b'] }))).toBeNull();
      expect(suggestedKeeper(group('g', ['a', 'b']))).toBe('a');
    });

    it('stops offering a group while a job works on it', () => {
      const g = group('g', ['a', 'b']);
      expect(isActionable(g, { state: 'pending' })).toBe(false);
      expect(isActionable(g, { state: 'failed', reasonKey: 'frameleaf_bulk_reason_failed' })).toBe(true);
      expect(canSuggest(g, { state: 'done' })).toBe(false);
    });

    it('reviews bursts and larger groups on a contact sheet', () => {
      expect(usesContactSheet(group('g', ['a', 'b']))).toBe(false);
      expect(usesContactSheet(group('g', ['a', 'b', 'c']))).toBe(true);
      expect(usesContactSheet(group('g', ['a', 'b'], { kind: DuplicateGroupKind.Burst }))).toBe(true);
    });
  });

  describe('buildDecisionGroups', () => {
    it('sends the complete group and the suggested keeper', () => {
      expect(buildDecisionGroups([group('g', ['a', 'b', 'c'])], 'suggested')).toEqual([
        { duplicateId: 'g', decision: DuplicateDecisionKind.Keepers, memberIds: ['a', 'b', 'c'], keepAssetIds: ['a'] },
      ]);
    });

    it('refuses to decide a burst by suggestion or a group the person cannot decide', () => {
      const burst = group('b', ['a', 'b'], { kind: DuplicateGroupKind.Burst });
      expect(() => buildDecisionGroups([burst], 'suggested')).toThrow(DuplicateDecisionError);
      expect(() => buildDecisionGroups([group('g', ['a', 'b'], { editable: false })], 'keep-all')).toThrow(
        'frameleaf_duplicates_error_not_editable',
      );
    });

    it('keeps several chosen keepers from one group, and only from that group', () => {
      const g = group('g', ['a', 'b', 'c']);
      expect(buildDecisionGroups([g], 'keepers', { keeperIds: ['a', 'c'] })[0].keepAssetIds).toEqual(['a', 'c']);
      expect(() => buildDecisionGroups([g], 'keepers', { keeperIds: ['z'] })).toThrow(
        'frameleaf_duplicates_error_keeper_outside',
      );
      expect(() => buildDecisionGroups([g, group('h', ['d', 'e'])], 'keepers', { keeperIds: ['a'] })).toThrow(
        'frameleaf_duplicates_error_one_group',
      );
    });

    it('stacks with the chosen keeper, else the suggestion, on top', () => {
      const g = group('g', ['a', 'b', 'c']);
      expect(buildDecisionGroups([g], 'stack', { keeperIds: ['c'] })[0]).toEqual(
        expect.objectContaining({ decision: DuplicateDecisionKind.Stack, keepAssetIds: ['c'] }),
      );
      expect(buildDecisionGroups([g], 'stack')[0].keepAssetIds).toEqual(['a']);
      expect(buildDecisionGroups([g], 'keep-all')[0]).toEqual(
        expect.objectContaining({ decision: DuplicateDecisionKind.KeepAll, keepAssetIds: [] }),
      );
    });
  });

  describe('decisionParts', () => {
    it('splits a large review into jobs the server accepts, never splitting a group', () => {
      const groups = [
        { duplicateId: '1', memberIds: ['a', 'b'] },
        { duplicateId: '2', memberIds: ['c', 'd', 'e'] },
        { duplicateId: '3', memberIds: ['f', 'g'] },
      ];
      const parts = decisionParts(groups, { maxGroups: 5000, maxItems: 5 });
      expect(parts.map((part) => part.map(({ duplicateId }) => duplicateId))).toEqual([['1', '2'], ['3']]);
      expect(decisionAssetIds(parts[0])).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(decisionParts(groups, { maxGroups: 1 })).toHaveLength(3);
    });
  });

  describe('undo', () => {
    const batch = (overrides: Partial<DuplicateDecisionBatchDto> = {}): DuplicateDecisionBatchDto => ({
      operationId: 'op-1',
      createdAt: '2026-09-23T10:00:00.000Z',
      undoable: true,
      groups: [
        {
          decisionId: 'd-1',
          duplicateId: 'g',
          decision: DuplicateDecisionKind.Keepers,
          memberIds: ['a', 'b'],
          keepAssetIds: ['a'],
          trashAssetIds: ['b'],
          applied: true,
          undone: false,
          undoing: false,
        },
      ],
      ...overrides,
    });

    it('undoes every applied decision of a job, naming each decision', () => {
      expect(undoGroupsFor(batch())).toEqual([
        {
          duplicateId: 'g',
          decision: DuplicateDecisionKind.Keepers,
          memberIds: ['a', 'b'],
          keepAssetIds: ['a'],
          decisionId: 'd-1',
        },
      ]);
    });

    it('offers only jobs the server says can be undone', () => {
      expect(undoableBatches([batch({ undoable: false }), batch({ operationId: 'op-2' })])).toHaveLength(1);
    });
  });

  describe('groupProgressFrom', () => {
    const groups = [
      { duplicateId: 'one', memberIds: ['a', 'b'] },
      { duplicateId: 'two', memberIds: ['c', 'd'] },
    ];
    const detail = (overrides: Partial<MediaOperationDetailDto>) =>
      ({
        status: MediaOperationStatus.Rendering,
        processedUnits: '0',
        bulkItems: [],
        bulkRetryPending: [],
        bulk: { retried: 0, itemsTruncated: false },
        ...overrides,
      }) as unknown as MediaOperationDetailDto;

    it('keeps a loader on every group the job has not reached', () => {
      const progress = groupProgressFrom(groups, detail({ processedUnits: '2' }));
      expect(progress.get('one')).toEqual({ state: 'done' });
      expect(progress.get('two')).toEqual({ state: 'pending' });
    });

    it('reads a refused group as failed, with the reason the server gave', () => {
      const progress = groupProgressFrom(
        groups,
        detail({
          status: MediaOperationStatus.Completed,
          processedUnits: '4',
          bulkItems: [
            {
              id: 'c',
              status: MediaOperationItemStatus.Skipped,
              reasonKey: 'frameleaf_bulk_reason_group_changed',
              message: null,
            },
            {
              id: 'd',
              status: MediaOperationItemStatus.Skipped,
              reasonKey: 'frameleaf_bulk_reason_group_changed',
              message: null,
            },
          ],
        }),
      );
      expect(progress.get('one')).toEqual({ state: 'done' });
      expect(progress.get('two')).toEqual({ state: 'failed', reasonKey: 'frameleaf_bulk_reason_group_changed' });
    });

    it('shows nothing for a group a cancelled job never reached', () => {
      const cancelled = detail({ status: MediaOperationStatus.Cancelled, processedUnits: '2' });
      const progress = groupProgressFrom(groups, cancelled);
      expect(progress.get('two')).toBeNull();
    });
  });

  describe('queue movement and keepers', () => {
    it('moves through the queue, skipping decided groups and wrapping when asked', () => {
      const ids = ['a', 'b', 'c'];
      expect(nextGroupId(ids, 'a')).toBe('b');
      expect(nextGroupId(ids, 'c')).toBeNull();
      expect(nextGroupId(ids, 'c', { wrap: true })).toBe('a');
      expect(nextGroupId(ids, 'a', { excludeIds: ['b'] })).toBe('c');
      expect(nextGroupId(ids, 'a', { direction: -1, wrap: true })).toBe('c');
      expect(nextGroupId(ids, 'missing')).toBe('a');
    });

    it('toggles one keeper, or a shift-clicked range', () => {
      const ids = ['a', 'b', 'c', 'd'];
      expect(toggleKeepers(ids, [], 1)).toEqual(['b']);
      expect(toggleKeepers(ids, ['b'], 3, { lastIndex: 1, shift: true })).toEqual(['b', 'c', 'd']);
      expect(toggleKeepers(ids, ['b', 'c', 'd'], 2, { lastIndex: 3, shift: true })).toEqual(['b']);
      expect(toggleKeepers(ids, ['b'], 1)).toEqual([]);
    });

    it('offsets burst frames from the first capture', () => {
      const burst = group('b', [], {
        kind: DuplicateGroupKind.Burst,
        assets: [asset('f1', 'f1.jpg', '2026-09-06T16:24:12.000Z'), asset('f2', 'f2.jpg', '2026-09-06T16:24:12.300Z')],
      });
      expect(frameOffsetSeconds(burst, burst.assets[1])).toBeCloseTo(0.3);
      expect(frameOffsetSeconds(group('g', ['a', 'b']), asset('a'))).toBeNull();
    });
  });

  describe('matchReviewShortcut', () => {
    const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) =>
      matchReviewShortcut({
        key: value,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        ...modifiers,
      });

    it('maps the prototype keys', () => {
      expect(key('k')).toEqual({ id: 'suggested' });
      expect(key('A')).toEqual({ id: 'keep-all' });
      expect(key('s')).toEqual({ id: 'stack' });
      expect(key('e')).toEqual({ id: 'keepers' });
      expect(key('7')).toEqual({ id: 'digit', digit: 7 });
      expect(key('ArrowRight')).toEqual({ id: 'next' });
      expect(key('?')).toEqual({ id: 'help' });
      expect(key('z', { metaKey: true })).toEqual({ id: 'undo' });
      expect(key('z', { ctrlKey: true, shiftKey: true })).toBeNull();
      expect(key('k', { repeat: true })).toBeNull();
      expect(key('0')).toBeNull();
    });
  });
});
