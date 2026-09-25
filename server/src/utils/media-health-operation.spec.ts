import { MediaOperationBulkAction, MediaOperationKind } from 'src/enum.js';
import {
  mediaHealthActivityAction,
  mediaHealthOperationLabel,
  parseLocateResult,
  parseMediaHealthSnapshot,
  parseScanResult,
  scanProgress,
} from 'src/utils/media-health-operation.js';

describe('media-health-operation (FL-69)', () => {
  describe(parseMediaHealthSnapshot.name, () => {
    it('reads a scan and a search', () => {
      expect(
        parseMediaHealthSnapshot({ mode: 'scan', userId: 'u', missingRunId: 'm', corruptRunId: 'c', extra: 1 }),
      ).toEqual({ mode: 'scan', userId: 'u', missingRunId: 'm', corruptRunId: 'c' });
      expect(
        parseMediaHealthSnapshot({ mode: 'locate', userId: 'u', runId: 'r', findingIds: ['a', 'a', 'b', 3] }),
      ).toEqual({ mode: 'locate', userId: 'u', runId: 'r', findingIds: ['a', 'b'], rootIds: null, anyOwner: false });
    });

    it('reads a scheduled incremental scan, ignoring a date it cannot read (Library care)', () => {
      const base = { mode: 'scan', userId: 'u', missingRunId: 'm', corruptRunId: 'c' } as const;
      expect(parseMediaHealthSnapshot({ ...base, changedSince: '2026-09-20T02:00:00.000Z', scheduled: true })).toEqual({
        ...base,
        changedSince: '2026-09-20T02:00:00.000Z',
        scheduled: true,
      });
      expect(parseMediaHealthSnapshot({ ...base, changedSince: 'yesterday', scheduled: 'yes' })).toEqual(base);
      expect(mediaHealthOperationLabel({ ...base, scheduled: true })).toBe('Scheduled library health scan');
    });

    it('refuses anything it cannot run safely', () => {
      expect(() => parseMediaHealthSnapshot(null)).toThrow();
      expect(() => parseMediaHealthSnapshot({ mode: 'scan', userId: 'u' })).toThrow('runs');
      expect(() => parseMediaHealthSnapshot({ mode: 'locate', userId: 'u', runId: 'r', findingIds: [] })).toThrow(
        'findings',
      );
      expect(() => parseMediaHealthSnapshot({ mode: 'delete-everything', userId: 'u' })).toThrow('Unsupported');
    });
  });

  describe('results', () => {
    it('starts a scan from nothing and resumes it from its cursor', () => {
      expect(parseScanResult(null)).toEqual({
        cursor: null,
        total: null,
        checked: 0,
        missing: 0,
        corrupt: 0,
        restored: false,
      });
      expect(parseScanResult({ cursor: 'asset-9', total: 20, checked: 10, missing: 1, corrupt: -3 })).toMatchObject({
        cursor: 'asset-9',
        checked: 10,
        missing: 1,
        corrupt: 0,
      });
    });

    it('keeps a search’s directory cursor only when it is well formed', () => {
      const managedSearch = { cursor: [{ path: '/data/upload', after: 'b' }], matches: {} };
      expect(parseLocateResult({ managedSearch, steps: 2 })).toEqual({
        managedSearch,
        checked: 0,
        found: 0,
        steps: 2,
      });
      expect(parseLocateResult({ managedSearch: { cursor: [{ nope: 1 }], matches: {} } }).managedSearch).toBeNull();
    });

    it('never reports a scan as complete before it is', () => {
      expect(scanProgress(parseScanResult({ total: 200, checked: 200 }))).toBe(99);
      expect(scanProgress(parseScanResult({ total: 200, checked: 50 }))).toBe(25);
      expect(scanProgress(parseScanResult({ checked: 50 }))).toBe(0);
    });
  });

  describe('naming', () => {
    it('labels jobs for readers without a translation', () => {
      expect(mediaHealthOperationLabel({ mode: 'scan', userId: 'u', missingRunId: 'm', corruptRunId: 'c' })).toBe(
        'Library health scan',
      );
      expect(
        mediaHealthOperationLabel({
          mode: 'locate',
          userId: 'u',
          runId: 'r',
          findingIds: ['a', 'b'],
          rootIds: null,
          anyOwner: false,
        }),
      ).toBe('Search for originals (2 items)');
    });

    it('names only Library Care jobs in recent activity', () => {
      expect(mediaHealthActivityAction(MediaOperationKind.MediaHealth, { mode: 'locate' })).toBe('locate');
      expect(
        mediaHealthActivityAction(MediaOperationKind.Bulk, { action: MediaOperationBulkAction.TrashDamagedMedia }),
      ).toBe(MediaOperationBulkAction.TrashDamagedMedia);
      expect(mediaHealthActivityAction(MediaOperationKind.Bulk, { action: MediaOperationBulkAction.Favorite })).toBe(
        null,
      );
      expect(mediaHealthActivityAction(MediaOperationKind.StudioExport, { mode: 'scan' })).toBeNull();
    });
  });
});
