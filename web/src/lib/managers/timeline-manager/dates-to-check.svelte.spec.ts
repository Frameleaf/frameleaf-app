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
const toCheck = { count: 3, years: [1970, 2031], timeBuckets: ['2031-06-01', '1970-01-01'] };

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
      expect(sdkMock.getTimelineDatesToCheck).toHaveBeenCalledWith({ isFavorite: true });

      expect(manager.months.map((month) => month.toCheck)).toEqual([false, true]);
      const group = manager.months[1];
      expect(group.title).toBe('frameleaf_library_dates_to_check');
      expect(group.assetsCount).toBe(3);
      expect(group.startsGroup).toBe(true);
      // the notice: how many, and the years their dates claim
      expect(manager.datesToCheck).toEqual({ count: 3, years: [1970, 2031] });
      expect(manager.assetCount).toBe(4);
    } finally {
      manager.destroy();
    }
  });

  it('reads the group a claimed month at a time and keeps the order the server sent', async () => {
    seed();
    const manager = await open();
    try {
      const group = manager.months[1];
      await manager.loadTimelineMonth(group.yearMonth, { cancelable: false });
      const reads = sdkMock.getTimeBucket.mock.calls
        .map(([query]) => query)
        .filter(({ datesToCheck }) => datesToCheck === TimelineDatesToCheck.Only);
      expect(reads.map(({ timeBucket }) => timeBucket)).toEqual(['2031-06-01', '1970-01-01']);

      expect(group.getAssets().map(({ id }) => id)).toEqual([future[0].id, future[1].id, reset.id]);
      // one group, not a day in 2031 and a day in 1970
      expect(group.timelineDays).toHaveLength(1);
      expect(group.timelineDays[0].groupTitle).toBe('frameleaf_library_dates_to_check');

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

  it('gives the group its place on the scrubber and no year', async () => {
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
      expect(manager.months.map((month) => month.toCheck)).toEqual([false, true]);
      expect(manager.months[1].yearMonth.year).toBeGreaterThan(manager.months[0].yearMonth.year);
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
      const month = await manager.findTimelineMonthForAsset({ id: reset.id });
      expect(month).toBe(manager.months[1]);
    } finally {
      manager.destroy();
    }
  });

  it('shows no group and no notice when every date is right, or the server says nothing', async () => {
    seed();
    sdkMock.getTimelineDatesToCheck.mockResolvedValue({ count: 0, years: [], timeBuckets: [] });
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
});
