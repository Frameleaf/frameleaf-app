import { MemoryExportStatus, MemoryType, type MemoryExportResponseDto, type MemoryResponseDto } from '@immich/sdk';
import {
  eventStoryPlace,
  exportProgress,
  formatLocalDateRange,
  isEventStory,
  isExportActive,
  isYearInReview,
  latestExport,
  memoryStoryKind,
} from '$lib/frameleaf/memory-stories';

const memory = (type: MemoryType, data: Record<string, unknown>) =>
  ({
    id: 'memory',
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    memoryAt: '2026-06-01T09:00:00.000Z',
    ownerId: 'owner',
    isSaved: false,
    assets: [],
    type,
    data,
  }) as unknown as MemoryResponseDto;

const eventStory = memory(MemoryType.EventStory, {
  kind: 'event_story',
  year: 2026,
  startDate: '2026-06-01',
  endDate: '2026-06-04',
  dayCount: 4,
  assetCount: 120,
  place: { city: 'Lisbon', state: 'Lisboa', country: 'Portugal' },
  title: 'Lisbon, Portugal',
});

const recap = memory(MemoryType.YearInReview, {
  kind: 'year_in_review',
  year: 2025,
  assetCount: 400,
  monthCount: 12,
});

const onThisDay = memory(MemoryType.OnThisDay, { year: 2019 });

const run = (overrides: Partial<MemoryExportResponseDto> = {}) =>
  ({
    id: 'export',
    memoryId: 'memory',
    ownerId: 'owner',
    title: 'Lisbon, Portugal',
    format: 'archive',
    status: MemoryExportStatus.Running,
    assetCount: 10,
    processedAssets: 0,
    sizeInBytes: null,
    error: null,
    isDownloadable: false,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    ...overrides,
  }) as MemoryExportResponseDto;

describe('memory stories', () => {
  describe('kind', () => {
    it('recognises each kind', () => {
      expect(memoryStoryKind(eventStory)).toBe('event_story');
      expect(memoryStoryKind(recap)).toBe('year_in_review');
      expect(memoryStoryKind(onThisDay)).toBe('on_this_day');
    });

    it('does not trust the type alone', () => {
      // a memory whose type says story but whose data was written by an older server
      const mismatched = memory(MemoryType.EventStory, { year: 2026 });
      expect(isEventStory(mismatched)).toBe(false);
      expect(memoryStoryKind(mismatched)).toBe('on_this_day');
    });

    it('is exclusive', () => {
      expect(isYearInReview(eventStory)).toBe(false);
      expect(isEventStory(recap)).toBe(false);
    });
  });

  describe('eventStoryPlace', () => {
    it('uses the title the server computed', () => {
      expect(eventStoryPlace(eventStory)).toBe('Lisbon, Portugal');
    });

    it('falls back to the place parts', () => {
      const untitled = memory(MemoryType.EventStory, {
        kind: 'event_story',
        year: 2026,
        startDate: '2026-06-01',
        endDate: '2026-06-02',
        dayCount: 2,
        assetCount: 10,
        place: { city: null, state: 'Lisboa', country: 'Portugal' },
      });
      expect(eventStoryPlace(untitled)).toBe('Lisboa, Portugal');
    });

    it('is undefined for a story with no location and for other kinds', () => {
      const nowhere = memory(MemoryType.EventStory, {
        kind: 'event_story',
        year: 2026,
        startDate: '2026-06-01',
        endDate: '2026-06-02',
        dayCount: 2,
        assetCount: 10,
      });
      expect(eventStoryPlace(nowhere)).toBeUndefined();
      expect(eventStoryPlace(recap)).toBeUndefined();
    });
  });

  describe('formatLocalDateRange', () => {
    it('reads the local days as calendar dates, not instants', () => {
      // parsed as a plain date, so a viewer west of UTC does not see 31 May
      expect(formatLocalDateRange('2026-06-01', '2026-06-04', 'en-GB')).toBe('1 Jun 2026 – 4 Jun 2026');
    });

    it('collapses a single day', () => {
      expect(formatLocalDateRange('2026-06-01', '2026-06-01', 'en-GB')).toBe('1 Jun 2026');
    });

    it('passes a malformed value straight through', () => {
      expect(formatLocalDateRange('nonsense', 'nonsense', 'en-GB')).toBe('nonsense');
    });
  });

  describe('exports', () => {
    it('keeps polling only while there is work', () => {
      expect(isExportActive(MemoryExportStatus.Pending)).toBe(true);
      expect(isExportActive(MemoryExportStatus.Running)).toBe(true);
      expect(isExportActive(MemoryExportStatus.Cancelling)).toBe(true);
      expect(isExportActive(MemoryExportStatus.Ready)).toBe(false);
      expect(isExportActive(MemoryExportStatus.Failed)).toBe(false);
      expect(isExportActive(MemoryExportStatus.Cancelled)).toBe(false);
    });

    it('reports progress as a bounded fraction', () => {
      expect(exportProgress(run({ processedAssets: 5 }))).toBe(0.5);
      expect(exportProgress(run({ assetCount: 0, processedAssets: 0 }))).toBe(0);
      expect(exportProgress(run({ processedAssets: 99 }))).toBe(1);
    });

    it('picks the newest export of the memory it was asked about', () => {
      const older = run({ id: 'older', createdAt: '2026-06-01T00:00:00.000Z' });
      const newer = run({ id: 'newer', createdAt: '2026-06-09T00:00:00.000Z' });
      const other = run({ id: 'other', memoryId: 'somebody-elses', createdAt: '2026-06-10T00:00:00.000Z' });

      expect(latestExport([older, other, newer], 'memory')?.id).toBe('newer');
      expect(latestExport([other], 'memory')).toBeUndefined();
    });
  });
});
