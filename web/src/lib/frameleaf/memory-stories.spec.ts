import { MemoryExportStatus, MemoryType, type MemoryExportResponseDto, type MemoryResponseDto } from '@immich/sdk';
import { MemoryShowLessKind } from '@immich/sdk';
import { addMessages, t as translations } from 'svelte-i18n';
import { get } from 'svelte/store';
import {
  dayDiff,
  eventStoryPlace,
  exportProgress,
  formatLocalDateRange,
  groupMemories,
  isEventStory,
  isExportActive,
  isYearInReview,
  latestExport,
  memoryEvidenceMs,
  memoryHeadline,
  memoryLocalDay,
  memoryStoryKind,
  moveMemoryItem,
  showLessOptions,
  showLessRuleLabel,
} from '$lib/frameleaf/memory-stories';
import en from '../../../../i18n/en.json';

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

  describe('the Memories index (FL-62)', () => {
    let t: (key: string, options?: { values?: Record<string, unknown> }) => string;

    beforeAll(() => {
      addMessages('dev', en);
      t = get(translations) as typeof t;
    });

    const dated = (id: string, type: MemoryType, data: Record<string, unknown>, day: string) =>
      ({
        ...memory(type, data),
        id,
        // the server's show window for that day in UTC-6: midday of the window is still that day
        showAt: `${day}T06:00:00.000Z`,
        hideAt: `${dayAfter(day)}T05:59:59.999Z`,
      }) as MemoryResponseDto;
    const dayAfter = (day: string) => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    const birthday = (id: string, date: string, age: number | null = 30) =>
      ({
        ...memory(MemoryType.Birthday, {
          kind: 'birthday',
          year: Number(date.slice(0, 4)),
          date,
          subject: 'pet',
          subjectId: 'pet-1',
          name: 'Biscuit',
          age,
        }),
        id,
        showAt: `${date}T00:00:00.000Z`,
      }) as MemoryResponseDto;

    it('counts calendar days', () => {
      expect(dayDiff('2026-09-25', '2026-09-26')).toBe(1);
      expect(dayDiff('2026-09-25', '2026-09-11')).toBe(-14);
      expect(dayDiff('2026-02-28', '2026-03-01')).toBe(1);
    });

    it('takes the day of a birthday from its data and of an on this day memory from its window', () => {
      expect(memoryLocalDay(birthday('b', '2026-09-26'))).toBe('2026-09-26');
      expect(memoryLocalDay(dated('o', MemoryType.OnThisDay, { year: 2020 }, '2026-09-25'))).toBe('2026-09-25');
      expect(memoryLocalDay(eventStory)).toBeUndefined();
    });

    it('splits Today, Upcoming and Earlier from the local date', () => {
      const today = dated('today', MemoryType.OnThisDay, { year: 2020 }, '2026-09-25');
      const tomorrow = birthday('tomorrow', '2026-09-26');
      const inTen = dated('ten', MemoryType.OnThisDay, { year: 2021 }, '2026-10-05');
      const farAway = dated('far', MemoryType.OnThisDay, { year: 2021 }, '2026-11-05');
      const yesterday = dated('yesterday', MemoryType.OnThisDay, { year: 2019 }, '2026-09-24');
      const longAgo = dated('old', MemoryType.OnThisDay, { year: 2019 }, '2026-08-01');

      const sections = groupMemories([inTen, today, tomorrow, farAway, yesterday, longAgo, eventStory], {
        today: '2026-09-25',
      });

      expect(sections.today.map(({ memory }) => memory.id)).toEqual(['today']);
      expect(sections.upcoming.map(({ memory, inDays }) => [memory.id, inDays])).toEqual([
        ['tomorrow', 1],
        ['ten', 10],
      ]);
      expect(sections.earlier.map(({ memory, passedDays }) => [memory.id, passedDays])).toEqual([
        ['yesterday', 1],
        ['old', undefined],
        ['memory', undefined],
      ]);
    });

    it('leaves Upcoming empty when the owner hides upcoming memories', () => {
      const sections = groupMemories([birthday('tomorrow', '2026-09-26')], {
        today: '2026-09-25',
        showUpcoming: false,
      });
      expect(sections.upcoming).toEqual([]);
      expect(sections.earlier).toEqual([]);
    });

    it('titles each kind as the template does, and the owner title wins', () => {
      const onThisDay = dated('o', MemoryType.OnThisDay, { year: 2025 }, '2026-09-25');
      expect(memoryHeadline(onThisDay, { t, locale: 'en', today: '2026-09-25' })).toEqual({
        title: 'On this day',
        subtitle: 'One year ago · September 25, 2025',
      });
      expect(memoryHeadline(birthday('b', '2026-09-26', 4), { t, locale: 'en' })).toEqual({
        title: "Biscuit's birthday",
        subtitle: 'Turns 4 · September 26, 2026',
      });
      expect(memoryHeadline(birthday('b', '2026-09-26', null), { t, locale: 'en' }).subtitle).toBe(
        'September 26, 2026',
      );
      expect(memoryHeadline(recap, { t, locale: 'en' })).toEqual({
        title: '2025 in review',
        subtitle: 'Highlights from 12 months',
      });
      expect(memoryHeadline({ ...eventStory, title: 'Our summer' }, { t, locale: 'en-GB' })).toEqual({
        title: 'Our summer',
        subtitle: '1 Jun 2026 – 4 Jun 2026 · 4 days',
      });
    });

    it('offers show less for the subject, the day and the kind', () => {
      const options = showLessOptions(birthday('b', '2026-09-26'), { t, locale: 'en' });
      expect(options.map(({ rule }) => rule)).toEqual([
        { kind: MemoryShowLessKind.Pet, value: 'pet-1' },
        { kind: MemoryShowLessKind.Date, value: '09-26' },
        { kind: MemoryShowLessKind.Type, value: MemoryType.Birthday },
      ]);
      expect(options.map(({ label }) => label)).toEqual([
        'Show less of Biscuit',
        'Show less from September 26',
        'Show fewer birthdays',
      ]);
      expect(showLessOptions(eventStory, { t }).map(({ label }) => label)).toEqual(['Show fewer trips']);
    });

    it('reads saved show-less rules in plain words', () => {
      const rule = (kind: MemoryShowLessKind, value: string, name: string | null = null) => ({
        kind,
        value,
        name,
        createdAt: '2026-09-25T00:00:00.000Z',
      });
      expect(showLessRuleLabel(rule(MemoryShowLessKind.Person, 'p', 'Ana'), { t })).toBe('Ana');
      expect(showLessRuleLabel(rule(MemoryShowLessKind.Pet, 'p'), { t })).toBe('A pet');
      expect(showLessRuleLabel(rule(MemoryShowLessKind.Date, '12-25'), { t, locale: 'en' })).toBe(
        'Memories from December 25',
      );
      expect(showLessRuleLabel(rule(MemoryShowLessKind.Type, 'event_story'), { t })).toBe('Trips');
    });

    it('moves an item one place at a time and never off either end', () => {
      expect(moveMemoryItem(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
      expect(moveMemoryItem(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
      expect(moveMemoryItem(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
      expect(moveMemoryItem(['a', 'b', 'c'], 'missing', 1)).toEqual(['a', 'b', 'c']);
    });

    it('opens a video at the owner cover time, else at its best frame', () => {
      const frames = [
        { rank: 2, timestampMs: 9000 },
        { rank: 1, timestampMs: 4000 },
      ];
      expect(memoryEvidenceMs({ coverTimestampMs: 12_000, frames })).toBe(12_000);
      expect(memoryEvidenceMs({ coverTimestampMs: null, frames })).toBe(4000);
      expect(memoryEvidenceMs({ coverTimestampMs: null, frames: [] })).toBeNull();
      expect(memoryEvidenceMs(null)).toBeNull();
    });
  });
});
