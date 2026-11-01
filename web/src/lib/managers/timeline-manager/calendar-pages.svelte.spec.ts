import { TimelineOrderedSort } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { TimelineManager } from './timeline-manager.svelte';

const date = fromISODateTimeUTCToObject('2024-01-15T12:00:00.000Z');
const assets = Array.from({ length: 2 }, () =>
  timelineAssetFactory.build({ localDateTime: date, fileCreatedAt: date }),
);
const pages = assets.map((asset, page) => ({
  timeBucket: '2024-01-01',
  count: 500,
  page,
  after: page ? assets[0].id : null,
  firstAssetId: asset.id,
  lastAssetId: asset.id,
}));

beforeEach(() => vi.resetAllMocks());

it('keeps calendar dates while loading only the requested page and combining scrubber counts', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue(pages);
  sdkMock.getTimeBucket.mockResolvedValue(toResponseDto(assets[1]));
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 500 }));
    expect(new Set(manager.months.map((month) => month.viewId)).size).toBe(2);
    expect(manager.months.map((month) => month.yearMonth)).toEqual([
      { year: 2024, month: 1, page: 0 },
      { year: 2024, month: 1, page: 1 },
    ]);
    expect(manager.scrubberMonths).toEqual([expect.objectContaining({ year: 2024, month: 1, assetCount: 1000 })]);
    await manager.loadTimelineMonth(manager.months[1].yearMonth, { cancelable: false });
    expect(sdkMock.getTimeBucket).toHaveBeenCalledOnce();
    expect(sdkMock.getTimeBucket).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 500,
        after: assets[0].id,
        firstAssetId: assets[1].id,
        lastAssetId: assets[1].id,
      }),
      expect.anything(),
    );
    expect(manager.months[0].getAssets()).toEqual([]);
    expect(manager.months[1].getAssets().map(({ id }) => id)).toEqual([assets[1].id]);
  } finally {
    manager.destroy();
  }
});

it('locates a deep-linked photo without reading earlier pages', async () => {
  sdkMock.getTimeBuckets.mockResolvedValueOnce(pages).mockResolvedValueOnce([pages[1]]);
  sdkMock.getTimeBucket.mockResolvedValue(toResponseDto(assets[1]));
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    expect(await manager.findTimelineMonthForAsset({ id: assets[1].id })).toBe(manager.months[1]);
    expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pageSize: 500,
        locateAssetId: assets[1].id,
      }),
    );
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
    expect(sdkMock.getTimeBucket).toHaveBeenCalledOnce();
  } finally {
    manager.destroy();
  }
});

it('reads album membership with the visible page rather than a second whole-month request', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue(pages);
  sdkMock.getTimeBucket.mockResolvedValue({ ...toResponseDto(assets[1]), inAlbum: [true] });
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({ timelineAlbumId: 'album' });
    await manager.loadTimelineMonth(manager.months[1].yearMonth, { cancelable: false });
    expect(sdkMock.getTimeBucket).toHaveBeenCalledOnce();
    expect(sdkMock.getTimeBucket).toHaveBeenCalledWith(
      expect.objectContaining({ membershipAlbumId: 'album' }),
      expect.anything(),
    );
    expect(manager.albumAssets.has(assets[1].id)).toBe(true);
  } finally {
    manager.destroy();
  }
});

it('releases distant page assets and album membership during a long traversal', async () => {
  const many = Array.from({ length: 20 }, () =>
    timelineAssetFactory.build({ localDateTime: date, fileCreatedAt: date }),
  );
  const summaries = many.map((asset, page) => ({
    timeBucket: '2024-01-01',
    count: 1,
    page,
    after: many[page - 1]?.id ?? null,
    firstAssetId: asset.id,
    lastAssetId: asset.id,
  }));
  sdkMock.getTimeBuckets.mockImplementation(async ({ locateAssetId }) =>
    locateAssetId ? summaries.filter((page) => page.firstAssetId === locateAssetId) : summaries,
  );
  sdkMock.getTimeBucket.mockImplementation(async ({ firstAssetId }) => ({
    ...toResponseDto(many.find(({ id }) => id === firstAssetId)!),
    inAlbum: [true],
  }));
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({ timelineAlbumId: 'album' });
    for (const month of manager.months) {
      await manager.loadTimelineMonth(month.yearMonth, { cancelable: false });
    }
    expect(manager.months.filter((month) => month.isLoaded).length).toBeLessThanOrEqual(8);
    expect(manager.albumAssets.size).toBeLessThanOrEqual(8);
    expect(manager.assetCount).toBe(20);
    expect((await manager.retrieveRange({ id: many[0].id }, { id: many[19].id })).map(({ id }) => id)).toEqual(
      many.map(({ id }) => id),
    );
    expect(manager.months.filter((month) => month.isLoaded).length).toBeLessThanOrEqual(8);
    await manager.loadTimelineMonth(manager.months[0].yearMonth, { cancelable: false });
    expect(manager.months[0].getFirstAsset()?.id).toBe(many[0].id);
    let conflict = true;
    sdkMock.getTimeBucket.mockImplementation(async ({ firstAssetId }) => {
      if (conflict && firstAssetId === many[10].id) {
        conflict = false;
        throw { status: 409 };
      }
      return { ...toResponseDto(many.find(({ id }) => id === firstAssetId)!), inAlbum: [true] };
    });
    expect(await manager.retrieveRange({ id: many[0].id }, { id: many[19].id })).toEqual([]);
  } finally {
    manager.destroy();
  }
});

it('refreshes page boundaries after a live insertion rather than inserting into an arbitrary page', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue(pages);
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    manager.upsertAssetsFromLiveEvent([assets[1]]);
    await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
    expect(manager.months.every((month) => month.getAssets().length === 0)).toBe(true);
  } finally {
    manager.destroy();
  }
});

it('refreshes summaries after a stale page response and discards the obsolete load', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue(pages);
  sdkMock.getTimeBucket.mockRejectedValueOnce({ status: 409 });
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    const obsolete = manager.months[1];
    await manager.loadTimelineMonth(obsolete.yearMonth, { cancelable: false });
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2);
    expect(manager.months).not.toContain(obsolete);
    expect(obsolete.getAssets()).toEqual([]);
  } finally {
    manager.destroy();
  }
});

it('selects the exact server order across page boundaries when timestamps and names tie', async () => {
  const tied = Array.from({ length: 3 }, () =>
    timelineAssetFactory.build({ localDateTime: date, fileCreatedAt: date, originalFileName: 'same.jpg' }),
  );
  sdkMock.getTimeBuckets.mockResolvedValue([
    { ...pages[0], count: 2, firstAssetId: tied[0].id, lastAssetId: tied[1].id },
    { ...pages[1], count: 1, after: tied[1].id, firstAssetId: tied[2].id, lastAssetId: tied[2].id },
  ]);
  sdkMock.getTimeBucket.mockImplementation(async ({ after }) =>
    after ? toResponseDto(tied[2]) : toResponseDto(tied[0], tied[1]),
  );
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    for (const month of manager.months) {
      await manager.loadTimelineMonth(month.yearMonth, { cancelable: false });
    }
    expect((await manager.retrieveRange(tied[2], tied[0])).map(({ id }) => id)).toEqual(tied.map(({ id }) => id));
  } finally {
    manager.destroy();
  }
});

it('keeps a stable logical position when a huge timeline changes height', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue(pages);
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    manager.months[0].height = 59_000_000;
    const element = Object.assign(document.createElement('div'), {
      scrollTo: ({ top }: { top: number }) => {
        element.scrollTop = top;
      },
      scrollBy: (_x: number, y: number) => {
        element.scrollTop += y;
      },
    });
    manager.scrollableElement = element;
    manager.scrollTo(30_000_000);
    expect(element.scrollTop).toBeLessThan(8_000_000);
    expect(manager.scrollTop).toBeCloseTo(30_000_000, 5);
    manager.months[0].height += 1_000_000;
    manager.updateSlidingWindow();
    expect(manager.scrollTop).toBeCloseTo(30_000_000, 5);
    manager.scrollBy(235);
    expect(manager.scrollTop).toBeCloseTo(30_000_235, 5);
    manager.scrollTo(manager.maxScroll);
    expect(manager.scrollTop).toBeCloseTo(manager.maxScroll, 5);
  } finally {
    manager.destroy();
  }
});

it('discards an asset locator overtaken by a different filter', async () => {
  let resolve!: (value: typeof pages) => void;
  sdkMock.getTimeBuckets
    .mockResolvedValueOnce(pages)
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValueOnce(pages);
  sdkMock.getTimeBucket.mockResolvedValue(toResponseDto(assets[1]));
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    const locating = manager.findTimelineMonthForAsset({ id: assets[1].id });
    await manager.updateOptions({ isFavorite: true });
    resolve([pages[1]]);
    expect(await locating).toBeUndefined();
    expect(sdkMock.getTimeBucket).not.toHaveBeenCalled();
  } finally {
    manager.destroy();
  }
});

it('keeps paging mode while live updates replace an in-flight refresh', async () => {
  sdkMock.getTimeBuckets.mockResolvedValueOnce(pages);
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({});
    let resolve!: (value: typeof pages) => void;
    sdkMock.getTimeBuckets.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sdkMock.getTimeBuckets.mockResolvedValue(pages);
    manager.upsertAssetsFromLiveEvent([assets[0]]);
    await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
    expect(manager.calendarPaged).toBe(true);
    manager.upsertAssetsFromLiveEvent([assets[1]]);
    resolve(pages);
    await vi.waitFor(() => expect(manager.months).toHaveLength(2));
    expect(manager.months.every((month) => month.calendarPage !== undefined)).toBe(true);
  } finally {
    manager.destroy();
  }
});

it('retains the scroll surface and connection while coalescing live refreshes', async () => {
  sdkMock.getTimeBuckets.mockResolvedValueOnce(pages);
  const manager = new TimelineManager();
  const connect = vi.spyOn(manager, 'connect');
  try {
    await manager.updateOptions({});
    const previous = manager.months;
    previous[0].height = 1000;
    let resolve!: (value: typeof pages) => void;
    sdkMock.getTimeBuckets.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sdkMock.getTimeBuckets.mockResolvedValue(pages);
    const inserted = timelineAssetFactory.build({ localDateTime: date, fileCreatedAt: date });
    manager.upsertAssetsFromLiveEvent([inserted]);
    await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
    expect(manager.months).toBe(previous);
    expect(manager.bodySectionHeight).toBeGreaterThanOrEqual(1000);
    for (let n = 0; n < 20; n++) {
      manager.upsertAssetsFromLiveEvent([inserted]);
    }
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2);
    resolve(pages);
    await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(manager.months).not.toBe(previous));
    expect(manager.initTask.executed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  } finally {
    manager.destroy();
  }
});

it.each([TimelineOrderedSort.Filename, TimelineOrderedSort.Rating, TimelineOrderedSort.Quality])(
  'locates a deep link directly in %s order',
  async (orderedBy) => {
    sdkMock.getTimeBuckets
      .mockResolvedValueOnce([{ timeBucket: '2024-01-01', count: 1_000_001 }])
      .mockResolvedValueOnce([{ timeBucket: '1970-01-01', count: 1, page: 2000 }]);
    sdkMock.getTimelineOrdered.mockResolvedValue(toResponseDto(assets[1]));
    const manager = new TimelineManager();
    try {
      await manager.updateOptions({ orderedBy });
      expect(await manager.findTimelineMonthForAsset({ id: assets[1].id })).toBe(manager.months[2000]);
      expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
      expect(sdkMock.getTimelineOrdered).toHaveBeenCalledOnce();
      expect(sdkMock.getTimeBuckets).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pageSize: 500,
          locateAssetId: assets[1].id,
          sort: orderedBy,
        }),
      );
    } finally {
      manager.destroy();
    }
  },
);

it('refreshes a cached ordered page when the located photo moved into it', async () => {
  const summaries = [{ timeBucket: '2024-01-01', count: 1000 }];
  const located = [{ timeBucket: '1970-01-01', count: 500, page: 1 }];
  sdkMock.getTimeBuckets
    .mockResolvedValueOnce(summaries)
    .mockResolvedValueOnce(located)
    .mockResolvedValueOnce(summaries)
    .mockResolvedValueOnce(located);
  sdkMock.getTimelineOrdered
    .mockResolvedValueOnce(toResponseDto(assets[0]))
    .mockResolvedValueOnce(toResponseDto(assets[1]));
  const manager = new TimelineManager();
  try {
    await manager.updateOptions({ orderedBy: TimelineOrderedSort.Rating });
    const previous = manager.months;
    await manager.loadTimelineMonth(previous[1].yearMonth, { cancelable: false });
    const found = await manager.findTimelineMonthForAsset({ id: assets[1].id });
    expect(found?.yearMonth).toEqual(previous[1].yearMonth);
    expect(manager.months).not.toBe(previous);
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(4);
    expect(sdkMock.getTimelineOrdered).toHaveBeenCalledTimes(2);
  } finally {
    manager.destroy();
  }
});
