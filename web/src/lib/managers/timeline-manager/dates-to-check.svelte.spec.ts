import { AssetOrder, TimeBucketDateType, TimelineDatesToCheck, TimelineOrderedSort } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { TimelineManager } from './timeline-manager.svelte';

/**
 * FL-1410: photos whose date cannot be right never lead the timeline. The server says which they are
 * (`GET /timeline/dates-to-check`); the manager asks its buckets without them and keeps them in one
 * group after every dated month.
 */
const taken = (iso: string) => {
  const date = fromISODateTimeUTCToObject(iso);
  return timelineAssetFactory.build({ localDateTime: date, fileCreatedAt: date });
};
const august = taken('2026-08-14T10:00:00.000Z');
const future = [taken('2031-06-02T09:00:00.000Z'), taken('2031-06-02T08:00:00.000Z')];
const reset = taken('1970-01-01T00:00:00.000Z');

const dated = [
  { timeBucket: '2026-08-01', count: 1, page: 0, after: null, firstAssetId: august.id, lastAssetId: august.id },
];
// FL-1452: the summary gives the group's pages, as the buckets page the dated months
const toCheckPages = [
  { timeBucket: '2031-06-01', count: 2, page: 0, after: null, firstAssetId: future[0].id, lastAssetId: future[1].id },
  { timeBucket: '1970-01-01', count: 1, page: 0, after: null, firstAssetId: reset.id, lastAssetId: reset.id },
];
const toCheck = { count: 3, years: [1970, 2031], timeBuckets: ['2031-06-01', '1970-01-01'], pages: toCheckPages };

const seed = () => {
  sdkMock.getTimeBuckets.mockResolvedValue(dated);
  sdkMock.getTimelineDatesToCheck.mockResolvedValue(toCheck);
  sdkMock.getTimeBucket.mockImplementation(({ timeBucket, datesToCheck }) =>
    Promise.resolve(
      datesToCheck === TimelineDatesToCheck.Only
        ? timeBucket === '2031-06-01'
          ? toResponseDto(...future)
          : toResponseDto(reset)
        : toResponseDto(august),
    ),
  );
};

const open = async (options: Parameters<TimelineManager['updateOptions']>[0] = {}) => {
  const manager = new TimelineManager();
  manager.setLayoutOptions({ rowHeight: 200, headerHeight: 48, gap: 8, fillRowWidth: true });
  manager.viewportWidth = 1200;
  manager.viewportHeight = 800;
  await manager.updateOptions(options);
  return manager;
};

beforeEach(() => vi.resetAllMocks());

describe('dates to check (FL-1410)', () => {
  it('asks the dated months without them and keeps them in one group at the end', async () => {
    seed();
    const manager = await open({ isFavorite: true });
    try {
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(
        expect.objectContaining({ isFavorite: true, pageSize: 500, datesToCheck: TimelineDatesToCheck.Exclude }),
      );
      // the summary is asked with the view's filters alone
      expect(sdkMock.getTimelineDatesToCheck).toHaveBeenCalledWith({ isFavorite: true, pageSize: 500 });

      // one group, held as its pages
      expect(manager.months.map((month) => month.toCheck)).toEqual([false, true, true]);
      const [first, second] = manager.months.slice(1);
      expect(first.title).toBe('frameleaf_library_dates_to_check');
      expect(first.assetsCount + second.assetsCount).toBe(3);
      expect(first.startsGroup).toBe(true);
      expect(second.startsGroup).toBe(false);
      // the notice: how many, and the years their dates claim
      expect(manager.datesToCheck).toEqual({ count: 3, years: [1970, 2031] });
      expect(manager.assetCount).toBe(4);
    } finally {
      manager.destroy();
    }
  });

  it('reads the group a page at a time and keeps the order the server sent', async () => {
    seed();
    const manager = await open();
    try {
      const [first, second] = manager.months.slice(1);
      await manager.loadTimelineMonth(first.yearMonth, { cancelable: false });
      const reads = () =>
        sdkMock.getTimeBucket.mock.calls
          .map(([query]) => query)
          .filter(({ datesToCheck }) => datesToCheck === TimelineDatesToCheck.Only);
      await manager.loadTimelineMonth(second.yearMonth, { cancelable: false });
      // each page from the month its photos claim, with the page's own bounds
      expect(reads()).toEqual([
        expect.objectContaining({ timeBucket: '2031-06-01', take: 2, firstAssetId: future[0].id }),
        expect.objectContaining({ timeBucket: '1970-01-01', take: 1, firstAssetId: reset.id }),
      ]);

      expect([...first.getAssets(), ...second.getAssets()].map(({ id }) => id)).toEqual([
        future[0].id,
        future[1].id,
        reset.id,
      ]);
      // each page is one run under the group's title, not a day in 2031 and a day in 1970
      expect(first.timelineDays).toHaveLength(1);
      expect(first.timelineDays[0].groupTitle).toBe('frameleaf_library_dates_to_check');

      // the dated month is read without them
      await manager.loadTimelineMonth(manager.months[0].yearMonth, { cancelable: false });
      expect(sdkMock.getTimeBucket).toHaveBeenCalledWith(
        expect.objectContaining({ timeBucket: '2026-08-01T00:00:00.000Z', datesToCheck: TimelineDatesToCheck.Exclude }),
        expect.anything(),
      );
      expect(manager.months[0].getAssets().map(({ id }) => id)).toEqual([august.id]);
    } finally {
      manager.destroy();
    }
  });

  it('selects a range from a dated photo into the group in the order shown, not by the dates they claim', async () => {
    seed();
    const manager = await open();
    try {
      await manager.loadTimelineMonth(manager.months[0].yearMonth, { cancelable: false });
      await manager.loadTimelineMonth(manager.months[1].yearMonth, { cancelable: false });
      await manager.loadTimelineMonth(manager.months[2].yearMonth, { cancelable: false });
      // 2031 claims to be newer than August 2026, and is shown after it
      const range = await manager.retrieveRange({ id: august.id }, { id: future[1].id });
      expect(range.map(({ id }) => id)).toEqual([august.id, future[0].id, future[1].id]);
      const back = await manager.retrieveRange({ id: reset.id }, { id: august.id });
      expect(back.map(({ id }) => id)).toEqual([august.id, future[0].id, future[1].id, reset.id]);
    } finally {
      manager.destroy();
    }
  });

  it('gives the group one place on the scrubber and no year', async () => {
    seed();
    const manager = await open();
    try {
      expect(manager.scrubberMonths.map(({ year, toCheck: flagged }) => ({ year, flagged: !!flagged }))).toEqual([
        { year: 2026, flagged: false },
        { year: 1, flagged: true },
      ]);
    } finally {
      manager.destroy();
    }
  });

  it('stays last when the timeline runs oldest first', async () => {
    seed();
    const manager = await open({ order: AssetOrder.Asc });
    try {
      expect(manager.months.map((month) => month.toCheck)).toEqual([false, true, true]);
      expect(manager.months[1].yearMonth.year).toBeGreaterThan(manager.months[0].yearMonth.year);
      expect(manager.months[2].yearMonth).toEqual({ ...manager.months[1].yearMonth, page: 1 });
    } finally {
      manager.destroy();
    }
  });

  it('counts the cards without them: the Years and Months cards ask as the buckets do', async () => {
    seed();
    const manager = await open({ isFavorite: true });
    try {
      expect(manager.bucketQuery).toEqual({ isFavorite: true, datesToCheck: TimelineDatesToCheck.Exclude });
    } finally {
      manager.destroy();
    }
  });

  it('finds a linked photo that waits among them', async () => {
    seed();
    const manager = await open();
    try {
      // not in the dated order: the lookup comes back empty
      sdkMock.getTimeBuckets.mockResolvedValueOnce([]);
      // on the group's second page: the pages are read until it is found
      const month = await manager.findTimelineMonthForAsset({ id: reset.id });
      expect(month).toBe(manager.months[2]);
    } finally {
      manager.destroy();
    }
  });

  it('shows no group and no notice when every date is right, or the server says nothing', async () => {
    seed();
    sdkMock.getTimelineDatesToCheck.mockResolvedValue({ count: 0, years: [], timeBuckets: [], pages: [] });
    const manager = await open();
    try {
      expect(manager.months.map((month) => month.toCheck)).toEqual([false]);
      expect(manager.datesToCheck).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  it('keeps every photo in the dated order when the server cannot say which dates are wrong', async () => {
    seed();
    sdkMock.getTimelineDatesToCheck.mockRejectedValue(new Error('not found'));
    const manager = await open();
    try {
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2);
      expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ datesToCheck: expect.anything() }),
      );
      expect(manager.months.map((month) => month.toCheck)).toEqual([false]);
      expect(manager.datesToCheck).toBeUndefined();
      expect(manager.bucketQuery).toEqual({});
    } finally {
      manager.destroy();
    }
  });

  it.each([
    { name: 'the date added', options: { dateType: TimeBucketDateType.Added } },
    { name: 'the file name', options: { orderedBy: TimelineOrderedSort.Filename } },
  ])('leaves a timeline ordered by $name as it was', async ({ options }) => {
    seed();
    const manager = await open(options);
    try {
      expect(sdkMock.getTimelineDatesToCheck).not.toHaveBeenCalled();
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(
        expect.not.objectContaining({ datesToCheck: expect.anything() }),
      );
      expect(manager.months.some((month) => month.toCheck)).toBe(false);
      expect(manager.datesToCheck).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  // FL-1452 (from the review of PR 1089): between a new filter and the timeline taking it, the old group
  // is still held. Fix dates asks whether the months are for the options last asked for.
  it('is not settled while newer options wait to be taken', async () => {
    seed();
    const manager = await open();
    try {
      expect(manager.settled).toBe(true);
      const pending = manager.updateOptions({ isFavorite: true });
      expect(manager.settled).toBe(false);
      expect(manager.months.some((month) => month.toCheck)).toBe(true);
      await pending;
      expect(manager.settled).toBe(true);
    } finally {
      manager.destroy();
    }
  });

  // FL-1452: a bad import puts thousands of photos on 1 January 2000. The group is read a page at a time,
  // and a page far from view is let go, as a calendar month's pages are.
  it('pages a group of several thousand, and releases the pages it no longer needs', async () => {
    seed();
    const PAGES = 12;
    const pageAssets = new Map<string, ReturnType<typeof taken>[]>();
    const pages = Array.from({ length: PAGES }, (_, page) => {
      const assets = Array.from({ length: 500 }, (_, index) =>
        taken(new Date(Date.UTC(2000, 0, 1, 0, 0, 0, 0) + (PAGES * 500 - page * 500 - index) * 1000).toISOString()),
      );
      pageAssets.set(assets[0].id, assets);
      return {
        timeBucket: '2000-01-01',
        count: 500,
        page,
        after: page === 0 ? null : `after-${page}`,
        firstAssetId: assets[0].id,
        lastAssetId: assets.at(-1)!.id,
      };
    });
    sdkMock.getTimelineDatesToCheck.mockResolvedValue({
      count: PAGES * 500,
      years: [2000],
      timeBuckets: ['2000-01-01'],
      pages,
    });
    sdkMock.getTimeBucket.mockImplementation(({ datesToCheck, firstAssetId }) =>
      Promise.resolve(
        datesToCheck === TimelineDatesToCheck.Only
          ? toResponseDto(...pageAssets.get(firstAssetId!)!)
          : toResponseDto(august),
      ),
    );
    const manager = await open();
    try {
      const group = manager.months.filter((month) => month.toCheck);
      expect(group).toHaveLength(PAGES);
      expect(manager.datesToCheck).toEqual({ count: 6000, years: [2000] });
      // nothing of the group is read until a page is wanted
      expect(group.some((month) => month.isLoaded)).toBe(false);

      await manager.loadTimelineMonth(group[0].yearMonth, { cancelable: false });
      expect(group[0].getAssets()).toHaveLength(500);
      expect(group[1].isLoaded).toBe(false);
      await manager.loadTimelineMonth(group[1].yearMonth, { cancelable: false });
      expect(sdkMock.getTimeBucket).toHaveBeenLastCalledWith(
        expect.objectContaining({
          timeBucket: '2000-01-01',
          datesToCheck: TimelineDatesToCheck.Only,
          take: 500,
          after: 'after-1',
          firstAssetId: pages[1].firstAssetId,
        }),
        expect.anything(),
      );

      for (const month of group.slice(2)) {
        await manager.loadTimelineMonth(month.yearMonth, { cancelable: false });
      }
      // at most eight pages are held; pages out of view were let go
      expect(group.filter((month) => month.isLoaded).length).toBeLessThanOrEqual(8);
      expect(group.at(-1)!.getAssets()).toHaveLength(500);
      const released = group.find((month) => !month.isLoaded)!;
      expect(released.getAssets()).toHaveLength(0);
      // and one read brings a page back
      await manager.loadTimelineMonth(released.yearMonth, { cancelable: false });
      expect(released.getAssets()).toHaveLength(500);
    } finally {
      manager.destroy();
    }
  });
});
