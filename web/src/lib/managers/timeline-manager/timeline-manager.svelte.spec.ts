import {
  AssetLockReason,
  AssetVisibility,
  TimeBucketDateType,
  type AssetResponseDto,
  type TimeBucketAssetResponseDto,
} from '@immich/sdk';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { justifiedRows } from '$lib/frameleaf/justified-rows';
import { cellGrid, cellGridOptions } from '$lib/frameleaf/library-grid';
import {
  markSessionLockSucceeded,
  sessionAccess,
  setSessionLockPending,
  waitForSessionLockRefreshes,
} from '$lib/frameleaf/session-access.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { getTimelineMonthByDate } from '$lib/managers/timeline-manager/internal/search-support.svelte';
import { AbortError } from '$lib/utils';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { assetFactory, timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { FLOW_SETTLE_MS } from './internal/flow-support.svelte';
import { TimelineManager } from './timeline-manager.svelte';
import type { TimelineMonth } from './timeline-month.svelte';
import type { TimelineAsset } from './types';

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { nsfwHiding: true } },
}));

async function getAssets(timelineManager: TimelineManager) {
  const assets = [];
  for await (const asset of timelineManager.assetsIterator()) {
    assets.push(asset);
  }
  return assets;
}

function deriveLocalDateTimeFromFileCreatedAt(arg: TimelineAsset): TimelineAsset {
  return {
    ...arg,
    localDateTime: arg.fileCreatedAt,
  };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every tile of a run of months, in the order the flow lays them out, with the month that owns it. */
const flowTiles = (run: TimelineMonth[]) =>
  run.flatMap((month) =>
    month.timelineDays.flatMap((day) => day.viewerAssets.map((viewerAsset) => ({ month, viewerAsset }))),
  );

/**
 * FL-143: the prototype justifies a whole group as one flow (`TimelineLibrary.jsx` justifiedRows over
 * `group.assets`). Every tile of `run` must sit exactly where that one flow puts it, whichever month
 * lays it out. Returns the months each row draws from.
 */
const expectOneFlow = (timelineManager: TimelineManager, run: TimelineMonth[]) => {
  const { rowWidth, rowHeight, spacing, heightTolerance } = timelineManager.justifiedLayoutOptions;
  const tiles = flowTiles(run);
  const rows = justifiedRows(
    tiles.map(({ viewerAsset }) => viewerAsset.asset.ratio),
    {
      containerWidth: rowWidth,
      targetRowHeight: rowHeight,
      gap: spacing,
      maxRowHeight: Math.round(rowHeight * (1 + heightTolerance)),
    },
  );
  const groupTop = run[0].top + run[0].groupHeaderHeight;
  for (const row of rows) {
    let left = 0;
    for (const tile of row.tiles) {
      const { month, viewerAsset } = tiles[tile.index];
      expect(month.findAssetAbsolutePosition(viewerAsset.id)?.top).toBe(groupTop + row.top);
      expect(viewerAsset.position).toMatchObject({ left, width: tile.width, height: tile.height });
      left += tile.width + spacing;
    }
  }
  const lastRow = rows.at(-1)!;
  const lastMonth = run.at(-1)!;
  expect(lastMonth.top + lastMonth.height).toBe(groupTop + lastRow.top + lastRow.height);
  return rows.map((row) => new Set(row.tiles.map((tile) => tiles[tile.index].month)));
};

describe('TimelineManager', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('discards an elevated bucket response that arrives after the session locks', async () => {
    const oldBuckets = deferred<Array<{ count: number; timeBucket: string }>>();
    sdkMock.getTimeBuckets
      .mockReturnValueOnce(oldBuckets.promise)
      .mockResolvedValueOnce([{ count: 1, timeBucket: '2024-02-01' }]);
    const timelineManager = new TimelineManager();
    const initial = timelineManager.updateOptions({ visibility: AssetVisibility.Locked });
    await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce());

    setSessionLockPending(true);
    markSessionLockSucceeded();
    eventManager.emit('SessionLocked');
    eventManager.emit('SessionAccessChanged', { isElevated: false });
    await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
    oldBuckets.resolve([{ count: 3, timeBucket: '2024-01-01' }]);
    await initial;
    await waitForSessionLockRefreshes();

    expect(timelineManager.months.map((month) => month.yearMonth.month)).toEqual([2]);
    timelineManager.destroy();
    setSessionLockPending(false);
  });

  describe('partner revocation (FL-54)', () => {
    const signedInAs = (id: string) => {
      vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true);
      vi.spyOn(authManager, 'user', 'get').mockReturnValue({ id } as never);
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('drops and reloads a timeline that includes partners when one stops sharing with me', async () => {
      signedInAs('me');
      sdkMock.getTimeBuckets.mockResolvedValue([{ count: 1, timeBucket: '2024-01-01' }]);
      const timelineManager = new TimelineManager();
      await timelineManager.updateOptions({ visibility: AssetVisibility.Timeline, withPartners: true });
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(1);

      eventManager.emit('PartnerRevoke', { sharedById: 'partner', sharedWithId: 'me' });

      await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
      timelineManager.destroy();
    });

    it('drops the partner’s own library page timeline too', async () => {
      signedInAs('me');
      sdkMock.getTimeBuckets.mockResolvedValue([{ count: 1, timeBucket: '2024-01-01' }]);
      const timelineManager = new TimelineManager();
      await timelineManager.updateOptions({ visibility: AssetVisibility.Timeline, userId: 'partner' });

      eventManager.emit('PartnerRevoke', { sharedById: 'partner', sharedWithId: 'me' });

      await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
      timelineManager.destroy();
    });

    it('leaves a timeline alone when the revocation is not mine or it holds no partner photos', async () => {
      signedInAs('me');
      sdkMock.getTimeBuckets.mockResolvedValue([{ count: 1, timeBucket: '2024-01-01' }]);
      const withPartners = new TimelineManager();
      await withPartners.updateOptions({ visibility: AssetVisibility.Timeline, withPartners: true });
      const ownOnly = new TimelineManager();
      await ownOnly.updateOptions({ visibility: AssetVisibility.Timeline });
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2);

      // I stopped sharing with somebody: my own timeline shows nothing of theirs to drop.
      eventManager.emit('PartnerRevoke', { sharedById: 'me', sharedWithId: 'partner' });
      await tick();

      expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2);
      withPartners.destroy();
      ownOnly.destroy();
    });
  });

  describe('init', () => {
    let timelineManager: TimelineManager;
    const bucketAssets: Record<string, TimelineAsset[]> = {
      '2024-03-01T00:00:00.000Z': timelineAssetFactory.buildList(1).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-03-01T00:00:00.000Z'),
        }),
      ),
      '2024-02-01T00:00:00.000Z': timelineAssetFactory.buildList(100).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-02-01T00:00:00.000Z'),
        }),
      ),
      '2024-01-01T00:00:00.000Z': timelineAssetFactory.buildList(3).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-01T00:00:00.000Z'),
        }),
      ),
    };

    const bucketAssetsResponse: Record<string, TimeBucketAssetResponseDto> = Object.fromEntries(
      Object.entries(bucketAssets).map(([key, assets]) => [key, toResponseDto(...assets)]),
    );

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([
        { count: 1, timeBucket: '2024-03-01' },
        { count: 100, timeBucket: '2024-02-01' },
        { count: 3, timeBucket: '2024-01-01' },
      ]);

      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) => Promise.resolve(bucketAssetsResponse[timeBucket]));
      await timelineManager.updateViewport({ width: 1588, height: 1000 });
      await tick();
    });

    it('should load months in viewport', () => {
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce();
      expect(sdkMock.getTimeBucket).toHaveBeenCalledTimes(2);
    });

    it('calculates month height', () => {
      const plainMonths = timelineManager.months.map((month) => ({
        year: month.yearMonth.year,
        month: month.yearMonth.month,
        height: month.height,
      }));

      expect(plainMonths).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ year: 2024, month: 3, height: 283 }),
          expect.objectContaining({ year: 2024, month: 2, height: 7711 }),
          expect.objectContaining({ year: 2024, month: 1, height: 283 }),
        ]),
      );
    });

    it('calculates timeline height', () => {
      expect(timelineManager.totalViewerHeight).toBe(8337);
    });
  });

  describe('loadTimelineMonth', () => {
    let timelineManager: TimelineManager;
    const bucketAssets: Record<string, TimelineAsset[]> = {
      '2024-01-03T00:00:00.000Z': timelineAssetFactory.buildList(1).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-03-01T00:00:00.000Z'),
        }),
      ),
      '2024-01-01T00:00:00.000Z': timelineAssetFactory.buildList(3).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-01T00:00:00.000Z'),
        }),
      ),
    };
    const bucketAssetsResponse: Record<string, TimeBucketAssetResponseDto> = Object.fromEntries(
      Object.entries(bucketAssets).map(([key, assets]) => [key, toResponseDto(...assets)]),
    );
    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([
        { count: 1, timeBucket: '2024-03-01T00:00:00.000Z' },
        { count: 3, timeBucket: '2024-01-01T00:00:00.000Z' },
      ]);
      sdkMock.getTimeBucket.mockImplementation(async ({ timeBucket }, { signal } = {}) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) {
          throw new AbortError();
        }
        return bucketAssetsResponse[timeBucket];
      });
      await timelineManager.updateViewport({ width: 1588, height: 0 });
    });

    it('loads a month', async () => {
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })?.getAssets().length).toEqual(0);
      await timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      expect(sdkMock.getTimeBucket).toHaveBeenCalledOnce();
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })?.getAssets().length).toEqual(3);
    });

    it('ignores invalid months', async () => {
      await timelineManager.loadTimelineMonth({ year: 2023, month: 1 });
      expect(sdkMock.getTimeBucket).not.toHaveBeenCalled();
    });

    it('cancels month loading', async () => {
      const month = getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })!;
      void timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      const abortSpy = vi.spyOn(month!.loader!.cancelToken!, 'abort');
      month?.cancel();
      expect(abortSpy).toHaveBeenCalledOnce();
      await timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })?.getAssets().length).toEqual(3);
    });

    it('prevents loading months multiple times', async () => {
      await Promise.all([
        timelineManager.loadTimelineMonth({ year: 2024, month: 1 }),
        timelineManager.loadTimelineMonth({ year: 2024, month: 1 }),
      ]);
      expect(sdkMock.getTimeBucket).toHaveBeenCalledOnce();

      await timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      expect(sdkMock.getTimeBucket).toHaveBeenCalledOnce();
    });

    it('allows loading a canceled month', async () => {
      const month = getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })!;
      const loadPromise = timelineManager.loadTimelineMonth({ year: 2024, month: 1 });

      month.cancel();
      await loadPromise;
      expect(month?.getAssets().length).toEqual(0);

      await timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      expect(month!.getAssets().length).toEqual(3);
    });
  });

  describe('a flat order (FL-30, S-15)', () => {
    const at = (iso: string) => fromISODateTimeUTCToObject(iso);
    // Server order: a (oldest) first, then c, then b. Nothing may re-sort them by date.
    const [a, b, c] = ['2020-01-01T00:00:00.000Z', '2024-06-01T00:00:00.000Z', '2022-03-01T00:00:00.000Z'].map(
      (iso, index) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...timelineAssetFactory.build({ rating: index }),
          fileCreatedAt: at(iso),
        }),
    );
    const setup = async (orderedBy: 'filename' | 'rating' = 'filename') => {
      const timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([
        { count: 2, timeBucket: '2024-06-01T00:00:00.000Z' },
        { count: 1, timeBucket: '2020-01-01T00:00:00.000Z' },
      ]);
      sdkMock.getTimelineOrdered.mockResolvedValue(toResponseDto(a, c, b));
      await timelineManager.updateOptions({ orderedBy: orderedBy as never });
      await timelineManager.updateViewport({ width: 1588, height: 0 });
      return timelineManager;
    };

    it('pages the ordered endpoint in synthetic pages, keeps the server order and has no scrubber', async () => {
      const timelineManager = await setup();
      expect(timelineManager.ordered).toBe('filename');
      expect(timelineManager.months).toHaveLength(1);
      expect(timelineManager.months[0].title).toBe('');
      expect(timelineManager.scrubberMonths).toEqual([]);

      const assets = await getAssets(timelineManager);
      expect(sdkMock.getTimelineOrdered).toHaveBeenCalledWith(
        expect.objectContaining({ sort: 'filename', skip: 0, take: 500 }),
        expect.anything(),
      );
      expect(sdkMock.getTimeBucket).not.toHaveBeenCalled();
      expect(assets.map(({ id }) => id)).toEqual([a.id, c.id, b.id]);
      timelineManager.destroy();
    });

    it('selects a range by position in the order, not by date', async () => {
      const timelineManager = await setup();
      await getAssets(timelineManager);
      const range = await timelineManager.retrieveRange({ id: b.id }, { id: a.id });
      expect(range.map(({ id }) => id)).toEqual([a.id, c.id, b.id]);
      const single = await timelineManager.retrieveRange({ id: c.id }, { id: b.id });
      expect(single.map(({ id }) => id)).toEqual([c.id, b.id]);
      timelineManager.destroy();
    });

    it('keeps an item in place when its date changes, and reads the pages again when a rating changes', async () => {
      const timelineManager = await setup('rating');
      await getAssets(timelineManager);
      timelineManager.update([c.id], (asset) => void (asset.fileCreatedAt = at('1999-01-01T00:00:00.000Z')));
      expect((await getAssets(timelineManager)).map(({ id }) => id)).toEqual([a.id, c.id, b.id]);
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(1);

      const scroller = document.createElement('div');
      Object.defineProperty(scroller, 'scrollTop', { value: 420, configurable: true });
      const scrollTo = vi.fn();
      scroller.scrollTo = scrollTo as never;
      timelineManager.scrollableElement = scroller;
      timelineManager.update([b.id], (asset) => void (asset.rating = 5));
      await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2));
      // The reload keeps the place in the list rather than jumping to the top.
      await vi.waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 420 }));
      timelineManager.destroy();
    });

    it('finds an item on a page that is not loaded yet', async () => {
      const timelineManager = await setup();
      sdkMock.getAssetInfo.mockResolvedValue(assetFactory.build({ id: c.id }));
      const month = await timelineManager.findTimelineMonthForAsset({ id: c.id });
      expect(month).toBe(timelineManager.months[0]);
      timelineManager.destroy();
    });
  });

  describe('upsertAssets', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);

      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    it('is empty initially', () => {
      expect(timelineManager.months.length).toEqual(0);
      expect(timelineManager.assetCount).toEqual(0);
    });

    it('adds assets to new month', () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([asset]);

      expect(timelineManager.months.length).toEqual(1);
      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months[0].getAssets().length).toEqual(1);
      expect(timelineManager.months[0].yearMonth.year).toEqual(2024);
      expect(timelineManager.months[0].yearMonth.month).toEqual(1);
      expect(timelineManager.months[0].getFirstAsset().id).toEqual(asset.id);
    });

    it('adds assets to existing month', () => {
      const [assetOne, assetTwo] = timelineAssetFactory
        .buildList(2, {
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        })
        .map((asset) => deriveLocalDateTimeFromFileCreatedAt(asset));
      timelineManager.upsertAssets([assetOne]);
      timelineManager.upsertAssets([assetTwo]);

      expect(timelineManager.months.length).toEqual(1);
      expect(timelineManager.assetCount).toEqual(2);
      expect(timelineManager.months[0].getAssets().length).toEqual(2);
      expect(timelineManager.months[0].yearMonth.year).toEqual(2024);
      expect(timelineManager.months[0].yearMonth.month).toEqual(1);
    });

    it('orders assets in months by descending date', () => {
      const assetOne = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      const assetTwo = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-15T12:00:00.000Z'),
        }),
      );
      const assetThree = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-16T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([assetOne, assetTwo, assetThree]);

      const month = getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 });
      expect(month).not.toBeNull();
      expect(month?.getAssets().length).toEqual(3);
      expect(month?.getAssets()[0].id).toEqual(assetOne.id);
      expect(month?.getAssets()[1].id).toEqual(assetThree.id);
      expect(month?.getAssets()[2].id).toEqual(assetTwo.id);
    });

    it('orders months by descending date', () => {
      const assetOne = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      const assetTwo = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-04-20T12:00:00.000Z'),
        }),
      );
      const assetThree = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2023-01-20T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([assetOne, assetTwo, assetThree]);

      expect(timelineManager.months.length).toEqual(3);
      expect(timelineManager.months[0].yearMonth.year).toEqual(2024);
      expect(timelineManager.months[0].yearMonth.month).toEqual(4);

      expect(timelineManager.months[1].yearMonth.year).toEqual(2024);
      expect(timelineManager.months[1].yearMonth.month).toEqual(1);

      expect(timelineManager.months[2].yearMonth.year).toEqual(2023);
      expect(timelineManager.months[2].yearMonth.month).toEqual(1);
    });

    it('updates existing asset', () => {
      const updateAssetsSpy = vi.spyOn(timelineManager, 'upsertAssets');
      const asset = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build());
      timelineManager.upsertAssets([asset]);

      expect(updateAssetsSpy).toHaveBeenCalledWith([asset]);
      expect(timelineManager.assetCount).toEqual(1);
    });

    it('ignores new assets that do not match the tag filter', async () => {
      await timelineManager.updateOptions({ tagId: 'tag-1' });

      const matching = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build({ tags: ['tag-1'] }));
      const unrelated = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build({ tags: ['tag-2'] }));

      timelineManager.upsertAssets([matching, unrelated]);

      expect(await getAssets(timelineManager)).toEqual([matching]);
    });

    // disabled due to the wasm Justified Layout import
    it('ignores trashed assets when isTrashed is true', async () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build({ isTrashed: false }));
      const trashedAsset = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build({ isTrashed: true }));

      const timelineManager = new TimelineManager();
      await timelineManager.updateOptions({ isTrashed: true });
      timelineManager.upsertAssets([asset, trashedAsset]);
      expect(await getAssets(timelineManager)).toEqual([trashedAsset]);
    });
  });

  describe('upsertAssets - updating existing', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);

      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    it('updates an asset', () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build({ isFavorite: false }));
      const updatedAsset = { ...asset, isFavorite: true };

      timelineManager.upsertAssets([asset]);
      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months[0].getFirstAsset().isFavorite).toEqual(false);

      timelineManager.upsertAssets([updatedAsset]);
      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months[0].getFirstAsset().isFavorite).toEqual(true);
    });

    it('asset moves months when asset date changes', () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      const updatedAsset = deriveLocalDateTimeFromFileCreatedAt({
        ...asset,
        fileCreatedAt: fromISODateTimeUTCToObject('2024-03-20T12:00:00.000Z'),
      });

      timelineManager.upsertAssets([asset]);
      expect(timelineManager.months.length).toEqual(1);
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })).not.toBeUndefined();
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })?.getAssets().length).toEqual(1);

      timelineManager.upsertAssets([updatedAsset]);
      expect(timelineManager.months.length).toEqual(2);
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })).not.toBeUndefined();
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })?.getAssets().length).toEqual(0);
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 3 })).not.toBeUndefined();
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 3 })?.getAssets().length).toEqual(1);
    });

    it('yearMonth is not a shared reference with asset.localDateTime (reference bug)', () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );

      timelineManager.upsertAssets([asset]);
      const januaryMonth = getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 })!;
      const monthYearMonth = januaryMonth.yearMonth;

      const originalMonth = monthYearMonth.month;
      expect(originalMonth).toEqual(1);

      // Simulating updateObject
      asset.localDateTime.month = 3;
      asset.localDateTime.day = 20;

      expect(monthYearMonth.month).toEqual(originalMonth);
      expect(monthYearMonth.month).toEqual(1);
    });

    it('asset is removed during upsert when TimelineManager if visibility changes', async () => {
      await timelineManager.updateOptions({
        visibility: AssetVisibility.Archive,
      });
      const fixture = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          visibility: AssetVisibility.Archive,
        }),
      );

      timelineManager.upsertAssets([fixture]);
      expect(timelineManager.assetCount).toEqual(1);

      const updated = Object.freeze({ ...fixture, visibility: AssetVisibility.Timeline });
      timelineManager.upsertAssets([updated]);
      expect(timelineManager.assetCount).toEqual(0);

      timelineManager.upsertAssets([{ ...fixture, visibility: AssetVisibility.Archive }]);
      expect(timelineManager.assetCount).toEqual(1);
    });

    it('asset is removed during upsert when TimelineManager if isFavorite changes', async () => {
      await timelineManager.updateOptions({
        isFavorite: true,
      });
      const fixture = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          isFavorite: true,
        }),
      );

      timelineManager.upsertAssets([fixture]);
      expect(timelineManager.assetCount).toEqual(1);

      const updated = Object.freeze({ ...fixture, isFavorite: false });
      timelineManager.upsertAssets([updated]);
      expect(timelineManager.assetCount).toEqual(0);

      timelineManager.upsertAssets([{ ...fixture, isFavorite: true }]);
      expect(timelineManager.assetCount).toEqual(1);
    });

    it('asset is removed during upsert when TimelineManager if isTrashed changes', async () => {
      await timelineManager.updateOptions({
        isTrashed: true,
      });
      const fixture = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          isTrashed: true,
        }),
      );

      timelineManager.upsertAssets([fixture]);
      expect(timelineManager.assetCount).toEqual(1);

      const updated = Object.freeze({ ...fixture, isTrashed: false });
      timelineManager.upsertAssets([updated]);
      expect(timelineManager.assetCount).toEqual(0);

      timelineManager.upsertAssets([{ ...fixture, isTrashed: true }]);
      expect(timelineManager.assetCount).toEqual(1);
    });
  });

  describe('AssetUpdate events', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);

      await timelineManager.updateViewport({ width: 1588, height: 1000 });
      await timelineManager.updateOptions({ albumId: 'album-id' });
    });

    afterEach(() => {
      timelineManager.destroy();
    });

    it('ignores unknown assets for album timelines', () => {
      eventManager.emit('AssetUpdate', assetFactory.build());

      expect(timelineManager.assetCount).toEqual(0);
      expect(timelineManager.months).toHaveLength(0);
    });

    it('updates existing assets in the timeline', () => {
      const existing = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build({ isFavorite: false }));

      timelineManager.upsertAssets([existing]);
      eventManager.emit(
        'AssetUpdate',
        assetFactory.build({
          id: existing.id,
          ownerId: existing.ownerId,
          isFavorite: true,
          isTrashed: existing.isTrashed,
          visibility: existing.visibility,
        }),
      );

      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months[0].getFirstAsset().isFavorite).toEqual(true);
    });
  });

  describe('live event asset insertion', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);

      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    afterEach(() => {
      timelineManager.destroy();
    });

    it('does not insert live event assets with a different owner into a user-scoped timeline', async () => {
      await timelineManager.updateOptions({ userId: 'partner-id', visibility: AssetVisibility.Timeline });

      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          ownerId: 'current-user-id',
          visibility: AssetVisibility.Timeline,
        }),
      );

      timelineManager.upsertAssetsFromLiveEvent([asset]);

      expect(timelineManager.assetCount).toEqual(0);
    });

    it('inserts live event assets for the matching owner into a user-scoped timeline', async () => {
      await timelineManager.updateOptions({ userId: 'partner-id', visibility: AssetVisibility.Timeline });

      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          ownerId: 'partner-id',
          visibility: AssetVisibility.Timeline,
        }),
      );

      timelineManager.upsertAssetsFromLiveEvent([asset]);

      expect(timelineManager.assetCount).toEqual(1);
    });

    it('does not insert unknown live event assets into album timelines', async () => {
      await timelineManager.updateOptions({ albumId: 'album-id' });

      const asset = deriveLocalDateTimeFromFileCreatedAt(timelineAssetFactory.build());

      timelineManager.upsertAssetsFromLiveEvent([asset]);

      expect(timelineManager.assetCount).toEqual(0);
    });

    it('updates existing live event assets in scoped timelines', async () => {
      await timelineManager.updateOptions({ albumId: 'album-id' });

      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          isFavorite: false,
        }),
      );

      timelineManager.upsertAssets([asset]);
      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months[0].getFirstAsset().isFavorite).toEqual(false);

      timelineManager.upsertAssetsFromLiveEvent([
        {
          ...asset,
          isFavorite: true,
        },
      ]);

      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months[0].getFirstAsset().isFavorite).toEqual(true);
    });
  });

  describe('removeAssets', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);

      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    it('ignores invalid IDs', () => {
      timelineManager.upsertAssets(
        timelineAssetFactory
          .buildList(2, {
            fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
          })
          .map((asset) => deriveLocalDateTimeFromFileCreatedAt(asset)),
      );
      timelineManager.removeAssets(['', 'invalid', '4c7d9acc']);

      expect(timelineManager.assetCount).toEqual(2);
      expect(timelineManager.months.length).toEqual(1);
      expect(timelineManager.months[0].getAssets().length).toEqual(2);
    });

    it('removes asset from month', () => {
      const [assetOne, assetTwo] = timelineAssetFactory
        .buildList(2, {
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        })
        .map((asset) => deriveLocalDateTimeFromFileCreatedAt(asset));
      timelineManager.upsertAssets([assetOne, assetTwo]);
      timelineManager.removeAssets([assetOne.id]);

      expect(timelineManager.assetCount).toEqual(1);
      expect(timelineManager.months.length).toEqual(1);
      expect(timelineManager.months[0].getAssets().length).toEqual(1);
    });

    it('does not remove month when empty', () => {
      const assets = timelineAssetFactory
        .buildList(2, {
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        })
        .map((asset) => deriveLocalDateTimeFromFileCreatedAt(asset));
      timelineManager.upsertAssets(assets);
      timelineManager.removeAssets(assets.map((asset) => asset.id));

      expect(timelineManager.assetCount).toEqual(0);
      expect(timelineManager.months.length).toEqual(1);
    });
  });

  describe('AssetsMarkNsfw events', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);
      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    afterEach(() => {
      timelineManager.destroy();
    });

    it('removes the asset locally when marked NSFW', () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([asset]);
      expect(timelineManager.assetCount).toEqual(1);

      eventManager.emit('AssetsMarkNsfw', [asset.id]);
      expect(timelineManager.assetCount).toEqual(0);
    });

    it('does not re-add a marked-NSFW asset on a later websocket update', () => {
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([asset]);
      eventManager.emit('AssetsMarkNsfw', [asset.id]);
      expect(timelineManager.assetCount).toEqual(0);

      // Server emits on_asset_update after persisting the enrichment, which the
      // websocket layer turns into an upsert. The asset is still NSFW, so it
      // must stay hidden rather than flashing back into the timeline.
      timelineManager.upsertAssets([asset]);
      expect(timelineManager.assetCount).toEqual(0);
    });

    it("keeps an unlocked session's revealed sensitive marks in the timeline, and nothing else locked (FL-34)", async () => {
      await timelineManager.updateOptions({ visibility: AssetVisibility.Timeline });
      const at = fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z');
      const revealed = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: at,
          visibility: AssetVisibility.Locked,
          lockReason: AssetLockReason.Marked,
        }),
      );
      const fromOldFolder = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: at,
          visibility: AssetVisibility.Locked,
          lockReason: AssetLockReason.ImmichLockedFolder,
        }),
      );

      expect(timelineManager.isExcluded(revealed)).toBe(false);
      expect(timelineManager.isExcluded(fromOldFolder)).toBe(true);
    });

    it("keeps a newly marked asset in an unlocked session's timeline, which reveals it (FL-34)", async () => {
      await timelineManager.updateOptions({ visibility: AssetVisibility.Timeline });
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
          visibility: AssetVisibility.Timeline,
        }),
      );
      timelineManager.upsertAssets([asset]);
      sessionAccess.isElevated = true;

      try {
        eventManager.emit('AssetsMarkNsfw', [asset.id]);
        expect(timelineManager.assetCount).toEqual(1);

        // the server's update after the lock carries visibility locked and keeps it in view
        timelineManager.upsertAssets([{ ...asset, visibility: AssetVisibility.Locked }]);
        expect(timelineManager.assetCount).toEqual(1);
      } finally {
        sessionAccess.isElevated = false;
      }
    });

    it('keeps a newly locked asset in the Locked view, where it now lives (FL-34)', async () => {
      await timelineManager.updateOptions({ visibility: AssetVisibility.Locked });
      const asset = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
          visibility: AssetVisibility.Locked,
        }),
      );
      timelineManager.upsertAssets([asset]);
      expect(timelineManager.assetCount).toEqual(1);

      eventManager.emit('AssetsMarkNsfw', [asset.id]);
      expect(timelineManager.assetCount).toEqual(1);
    });
  });

  describe('firstAsset', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);
      await timelineManager.updateViewport({ width: 0, height: 0 });
    });

    it('empty store returns null', () => {
      expect(timelineManager.getFirstAsset()).toBeUndefined();
    });

    it('populated store returns first asset', () => {
      const assetOne = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      const assetTwo = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-15T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([assetOne, assetTwo]);
      expect(timelineManager.getFirstAsset()).toEqual(assetOne);
    });
  });

  describe('getLaterAsset', () => {
    let timelineManager: TimelineManager;
    const bucketAssets: Record<string, TimelineAsset[]> = {
      '2024-03-01T00:00:00.000Z': timelineAssetFactory.buildList(1).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-03-01T00:00:00.000Z'),
        }),
      ),
      '2024-02-01T00:00:00.000Z': timelineAssetFactory.buildList(6).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-02-01T00:00:00.000Z'),
        }),
      ),
      '2024-01-01T00:00:00.000Z': timelineAssetFactory.buildList(3).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-01T00:00:00.000Z'),
        }),
      ),
    };
    const bucketAssetsResponse: Record<string, TimeBucketAssetResponseDto> = Object.fromEntries(
      Object.entries(bucketAssets).map(([key, assets]) => [key, toResponseDto(...assets)]),
    );

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([
        { count: 1, timeBucket: '2024-03-01T00:00:00.000Z' },
        { count: 6, timeBucket: '2024-02-01T00:00:00.000Z' },
        { count: 3, timeBucket: '2024-01-01T00:00:00.000Z' },
      ]);
      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) => Promise.resolve(bucketAssetsResponse[timeBucket]));
      sdkMock.getAssetInfo.mockRejectedValue(new Error('Asset not found'));
      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    it('returns null for invalid assetId', async () => {
      expect(() => timelineManager.getLaterAsset({ id: 'invalid' } as AssetResponseDto)).not.toThrow();
      expect(await timelineManager.getLaterAsset({ id: 'invalid' } as AssetResponseDto)).toBeUndefined();
    });

    it('returns previous assetId', async () => {
      await timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      const month = getTimelineMonthByDate(timelineManager, { year: 2024, month: 1 });

      const a = month!.getAssets()[0];
      const b = month!.getAssets()[1];
      const previous = await timelineManager.getLaterAsset(b);
      expect(previous).toEqual(a);
    });

    it('returns previous assetId spanning multiple months', async () => {
      await timelineManager.loadTimelineMonth({ year: 2024, month: 2 });
      await timelineManager.loadTimelineMonth({ year: 2024, month: 3 });

      const month = getTimelineMonthByDate(timelineManager, { year: 2024, month: 2 });
      const previousMonth = getTimelineMonthByDate(timelineManager, { year: 2024, month: 3 });
      const a = month!.getAssets()[0];
      const b = previousMonth!.getAssets()[0];
      const previous = await timelineManager.getLaterAsset(a);
      expect(previous).toEqual(b);
    });

    it('loads previous month', async () => {
      await timelineManager.loadTimelineMonth({ year: 2024, month: 2 });
      const month = getTimelineMonthByDate(timelineManager, { year: 2024, month: 2 });
      const previousMonth = getTimelineMonthByDate(timelineManager, { year: 2024, month: 3 });
      const a = month!.getFirstAsset();
      const b = previousMonth!.getFirstAsset();
      const loadTimelineMonthSpy = vi.spyOn(month!.loader!, 'execute');
      const previousMonthSpy = vi.spyOn(previousMonth!.loader!, 'execute');
      const previous = await timelineManager.getLaterAsset(a);
      expect(previous).toEqual(b);
      expect(loadTimelineMonthSpy).not.toHaveBeenCalled();
      expect(previousMonthSpy).not.toHaveBeenCalled();
    });

    it('skips removed assets', async () => {
      await timelineManager.loadTimelineMonth({ year: 2024, month: 1 });
      await timelineManager.loadTimelineMonth({ year: 2024, month: 2 });
      await timelineManager.loadTimelineMonth({ year: 2024, month: 3 });

      const [assetOne, assetTwo, assetThree] = await getAssets(timelineManager);
      timelineManager.removeAssets([assetTwo.id]);
      expect(await timelineManager.getLaterAsset(assetThree)).toEqual(assetOne);
    });

    it('returns null when no more assets', async () => {
      await timelineManager.loadTimelineMonth({ year: 2024, month: 3 });
      expect(await timelineManager.getLaterAsset(timelineManager.months[0].getFirstAsset())).toBeUndefined();
    });
  });

  describe('retrieveRange', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);
      sdkMock.getAssetInfo.mockRejectedValue(new Error('Asset not found'));
      await timelineManager.updateViewport({ width: 1588, height: 1000 });
    });

    const build = (id: string, localIso: string, fileIso: string) =>
      timelineAssetFactory.build({
        id,
        localDateTime: fromISODateTimeUTCToObject(localIso),
        fileCreatedAt: fromISODateTimeUTCToObject(fileIso),
      });

    it('selects only the range between two same-day assets when local time and file time disagree', async () => {
      // A and B fall on the same local day, but their fileCreatedAt order is the
      // reverse of their localDateTime order (e.g. photos taken across timezones).
      // The timeline groups days by localDateTime but sorts within a day by
      // fileCreatedAt, so the on-screen order is [B, A].
      const b = build('B', '2024-06-15T17:00:00.000Z', '2024-06-15T05:00:00.000Z');
      const a = build('A', '2024-06-15T18:00:00.000Z', '2024-06-15T02:00:00.000Z');

      // Older assets that must NOT be pulled in when ranging within 2024-06-15.
      const older = [
        build('older-1', '2024-05-10T12:00:00.000Z', '2024-05-10T12:00:00.000Z'),
        build('older-2', '2024-04-10T12:00:00.000Z', '2024-04-10T12:00:00.000Z'),
        build('older-3', '2024-03-10T12:00:00.000Z', '2024-03-10T12:00:00.000Z'),
      ];

      // Insertion order mirrors the backend's within-day order (fileCreatedAt
      // descending), which is how the real timeline lays a day group out: [B, A].
      timelineManager.upsertAssets([b, a, ...older]);

      // Anchor on the top asset (B), shift-select down to A — expect just {B, A}.
      const range = await timelineManager.retrieveRange({ id: 'B' }, { id: 'A' });
      expect(range.map((asset) => asset.id)).toEqual(['B', 'A']);
    });

    it('returns the same range regardless of which endpoint is the anchor', async () => {
      const b = build('B', '2024-06-15T17:00:00.000Z', '2024-06-15T05:00:00.000Z');
      const a = build('A', '2024-06-15T18:00:00.000Z', '2024-06-15T02:00:00.000Z');
      const older = build('older-1', '2024-05-10T12:00:00.000Z', '2024-05-10T12:00:00.000Z');
      timelineManager.upsertAssets([b, a, older]);

      const range = await timelineManager.retrieveRange({ id: 'A' }, { id: 'B' });
      expect(range.map((asset) => asset.id)).toEqual(['B', 'A']);
    });

    it('selects the inclusive range across days for single-timezone assets', async () => {
      const assets = [
        build('d20', '2024-06-20T12:00:00.000Z', '2024-06-20T12:00:00.000Z'),
        build('d18', '2024-06-18T12:00:00.000Z', '2024-06-18T12:00:00.000Z'),
        build('d15', '2024-06-15T12:00:00.000Z', '2024-06-15T12:00:00.000Z'),
        build('d10', '2024-06-10T12:00:00.000Z', '2024-06-10T12:00:00.000Z'),
      ];
      timelineManager.upsertAssets(assets);

      const range = await timelineManager.retrieveRange({ id: 'd18' }, { id: 'd15' });
      expect(range.map((asset) => asset.id)).toEqual(['d18', 'd15']);
    });

    it('includes intermediate months when ranging across several months', async () => {
      const assets = [
        build('jun', '2024-06-15T12:00:00.000Z', '2024-06-15T12:00:00.000Z'),
        build('may', '2024-05-15T12:00:00.000Z', '2024-05-15T12:00:00.000Z'),
        build('apr', '2024-04-15T12:00:00.000Z', '2024-04-15T12:00:00.000Z'),
        build('mar', '2024-03-15T12:00:00.000Z', '2024-03-15T12:00:00.000Z'),
      ];
      timelineManager.upsertAssets(assets);

      const range = await timelineManager.retrieveRange({ id: 'jun' }, { id: 'apr' });
      expect(range.map((asset) => asset.id)).toEqual(['jun', 'may', 'apr']);
    });
  });

  describe('getTimelineMonthIndexByAssetId', () => {
    let timelineManager: TimelineManager;

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);

      await timelineManager.updateViewport({ width: 0, height: 0 });
    });

    it('returns null for invalid months', () => {
      expect(getTimelineMonthByDate(timelineManager, { year: -1, month: -1 })).toBeUndefined();
      expect(getTimelineMonthByDate(timelineManager, { year: 2024, month: 3 })).toBeUndefined();
    });

    it('returns the month index', () => {
      const assetOne = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      const assetTwo = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-02-15T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([assetOne, assetTwo]);

      expect(timelineManager.getTimelineMonthByAssetId(assetTwo.id)?.yearMonth.year).toEqual(2024);
      expect(timelineManager.getTimelineMonthByAssetId(assetTwo.id)?.yearMonth.month).toEqual(2);
      expect(timelineManager.getTimelineMonthByAssetId(assetOne.id)?.yearMonth.year).toEqual(2024);
      expect(timelineManager.getTimelineMonthByAssetId(assetOne.id)?.yearMonth.month).toEqual(1);
    });

    it('ignores removed months', () => {
      const assetOne = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-20T12:00:00.000Z'),
        }),
      );
      const assetTwo = deriveLocalDateTimeFromFileCreatedAt(
        timelineAssetFactory.build({
          fileCreatedAt: fromISODateTimeUTCToObject('2024-02-15T12:00:00.000Z'),
        }),
      );
      timelineManager.upsertAssets([assetOne, assetTwo]);

      timelineManager.removeAssets([assetTwo.id]);
      expect(timelineManager.getTimelineMonthByAssetId(assetOne.id)?.yearMonth.year).toEqual(2024);
      expect(timelineManager.getTimelineMonthByAssetId(assetOne.id)?.yearMonth.month).toEqual(1);
    });
  });

  describe('getRandomAsset', () => {
    let timelineManager: TimelineManager;
    const bucketAssets: Record<string, TimelineAsset[]> = {
      '2024-03-01T00:00:00.000Z': timelineAssetFactory.buildList(1).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-03-01T00:00:00.000Z'),
        }),
      ),
      '2024-02-01T00:00:00.000Z': timelineAssetFactory.buildList(10).map((asset, idx) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          // here we make sure that not all assets are on the first day of the month
          fileCreatedAt: fromISODateTimeUTCToObject(`2024-02-0${idx < 7 ? 1 : 2}T00:00:00.000Z`),
        }),
      ),
      '2024-01-01T00:00:00.000Z': timelineAssetFactory.buildList(3).map((asset) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject('2024-01-01T00:00:00.000Z'),
        }),
      ),
    };

    const bucketAssetsResponse: Record<string, TimeBucketAssetResponseDto> = Object.fromEntries(
      Object.entries(bucketAssets).map(([key, assets]) => [key, toResponseDto(...assets)]),
    );

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([
        { count: 1, timeBucket: '2024-03-01' },
        { count: 10, timeBucket: '2024-02-01' },
        { count: 3, timeBucket: '2024-01-01' },
      ]);

      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) => Promise.resolve(bucketAssetsResponse[timeBucket]));
      await timelineManager.updateViewport({ width: 1588, height: 0 });
    });

    it('gets all assets once', async () => {
      const assetCount = timelineManager.assetCount;
      expect(assetCount).toBe(14);
      const discoveredAssets: Set<string> = new Set();
      for (let idx = 0; idx < assetCount; idx++) {
        const asset = await timelineManager.getRandomAsset(idx);
        expect(asset).toBeDefined();
        const id = asset!.id;
        expect(discoveredAssets.has(id)).toBeFalsy();
        discoveredAssets.add(id);
      }

      expect(discoveredAssets.size).toBe(assetCount);
    });
  });

  describe('showAssetOwners', () => {
    const LS_KEY = 'album-show-asset-owners';

    beforeEach(() => {
      // ensure clean state
      globalThis.localStorage?.removeItem(LS_KEY);
    });

    it('defaults to false', () => {
      const timelineManager = new TimelineManager();
      expect(timelineManager.showAssetOwners).toBe(false);
    });

    it('setShowAssetOwners updates value', () => {
      const timelineManager = new TimelineManager();
      timelineManager.setShowAssetOwners(true);
      expect(timelineManager.showAssetOwners).toBe(true);
      timelineManager.setShowAssetOwners(false);
      expect(timelineManager.showAssetOwners).toBe(false);
    });

    it('toggleShowAssetOwners flips value', () => {
      const timelineManager = new TimelineManager();
      expect(timelineManager.showAssetOwners).toBe(false);
      timelineManager.toggleShowAssetOwners();
      expect(timelineManager.showAssetOwners).toBe(true);
      timelineManager.toggleShowAssetOwners();
      expect(timelineManager.showAssetOwners).toBe(false);
    });

    it('persists across instances via localStorage', () => {
      const a = new TimelineManager();
      a.setShowAssetOwners(true);
      const b = new TimelineManager();
      expect(b.showAssetOwners).toBe(true);
    });
  });

  describe('retrieveRange', () => {
    it('uses createdAt ordering in the Recently Added view (dateType=Added)', async () => {
      // Simulate the "Recently Added" bug: two assets whose localDateTime order is
      // the reverse of their createdAt (upload) order. Before the fix, retrieveRange
      // compared localDateTime and selected the wrong range direction.
      const timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue([]);
      await timelineManager.updateOptions({ dateType: TimeBucketDateType.Added });

      // assetA was taken recently (2024) but uploaded first (2025-01)
      const assetA = timelineAssetFactory.build({
        localDateTime: fromISODateTimeUTCToObject('2024-06-01T00:00:00.000Z'),
        createdAt: fromISODateTimeUTCToObject('2025-01-20T00:00:00.000Z'),
        fileCreatedAt: fromISODateTimeUTCToObject('2025-01-20T00:00:00.000Z'),
      });
      // assetB was taken long ago (2018) but uploaded second (2025-02)
      const assetB = timelineAssetFactory.build({
        localDateTime: fromISODateTimeUTCToObject('2018-03-15T00:00:00.000Z'),
        createdAt: fromISODateTimeUTCToObject('2025-02-10T00:00:00.000Z'),
        fileCreatedAt: fromISODateTimeUTCToObject('2025-02-10T00:00:00.000Z'),
      });
      // assetC is an unrelated asset that should not appear in the selection
      const assetC = timelineAssetFactory.build({
        localDateTime: fromISODateTimeUTCToObject('2022-01-01T00:00:00.000Z'),
        createdAt: fromISODateTimeUTCToObject('2025-03-01T00:00:00.000Z'),
        fileCreatedAt: fromISODateTimeUTCToObject('2025-03-01T00:00:00.000Z'),
      });

      timelineManager.upsertAssets([assetA, assetB, assetC]);

      // Shift-click from assetB (uploaded most recently) to assetA — the range
      // between them in the "Recently Added" timeline should contain only those two.
      const range = await timelineManager.retrieveRange({ id: assetB.id }, { id: assetA.id });
      const ids = range.map((a) => a.id);
      expect(ids).toContain(assetA.id);
      expect(ids).toContain(assetB.id);
      expect(ids).not.toContain(assetC.id);
    });
  });
  describe('grouping', () => {
    let timelineManager: TimelineManager;
    // Three months over two years, each spread over several days.
    const onDays = (month: string, days: number[]) =>
      days.flatMap((day) =>
        timelineAssetFactory.buildList(3).map((asset) =>
          deriveLocalDateTimeFromFileCreatedAt({
            ...asset,
            fileCreatedAt: fromISODateTimeUTCToObject(`${month}-${String(day).padStart(2, '0')}T12:00:00.000Z`),
          }),
        ),
      );
    const buckets: Record<string, TimelineAsset[]> = {
      '2024-03-01': onDays('2024-03', [20, 10, 2]),
      '2024-02-01': onDays('2024-02', [14, 3]),
      '2023-12-01': onDays('2023-12', [25, 24, 1]),
    };

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue(
        Object.entries(buckets).map(([timeBucket, assets]) => ({ timeBucket, count: assets.length })),
      );
      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
        Promise.resolve(toResponseDto(...buckets[timeBucket.slice(0, 10)])),
      );
      await timelineManager.updateViewport({ width: 1200, height: 5000 });
      await tick();
    });

    const starts = () => timelineManager.months.map((month) => month.startsGroup);

    it('draws a header per day by default', () => {
      expect(timelineManager.grouping).toBe('days');
      for (const month of timelineManager.months) {
        expect(month.groupHeaderHeight).toBe(timelineManager.headerHeight);
        expect(month.timelineDays.length).toBeGreaterThan(1);
        expect(new Set(month.timelineDays.map((day) => day.top)).size).toBeGreaterThan(1);
      }
    });

    it('lays each month out as one flow under one header when grouping by month', () => {
      timelineManager.grouping = 'months';
      expect(starts()).toEqual([true, true, true]);
      for (const month of timelineManager.months) {
        expect(month.isLoaded).toBe(true);
        // Every day of the month shares the month's one flow, measured from its first row.
        expect(month.timelineDays.every((day) => day.top === 0 && day.start === 0)).toBe(true);
        const flowHeight = month.timelineDays[0].height;
        expect(month.height).toBe(month.groupHeaderHeight + flowHeight);
        const positions = month.timelineDays.flatMap((day) =>
          day.viewerAssets.map((viewerAsset) => viewerAsset.position!),
        );
        const tops = positions.map((position) => `${position.top}:${position.left}`);
        expect(new Set(tops).size).toBe(positions.length);
      }
    });

    it('opens a year group on the newest month of each year', () => {
      timelineManager.grouping = 'years';
      expect(starts()).toEqual([true, false, true]);
      const [march, february] = timelineManager.months;
      expect(march.groupHeaderHeight).toBe(timelineManager.headerHeight);
      expect(february.groupHeaderHeight).toBe(timelineManager.gap);
    });

    it('draws one header over everything for "all"', () => {
      timelineManager.grouping = 'all';
      expect(starts()).toEqual([true, false, false]);
    });

    it('places an asset under its month header when grouped', () => {
      timelineManager.grouping = 'months';
      const month = timelineManager.months[1];
      const first = month.timelineDays[0].viewerAssets[0];
      expect(month.findAssetAbsolutePosition(first.id)?.top).toBe(
        month.top + month.groupHeaderHeight + first.position!.top,
      );
    });

    it('goes back to day groups', () => {
      const dayHeights = timelineManager.months.map((month) => month.height);
      timelineManager.grouping = 'months';
      timelineManager.grouping = 'days';
      expect(timelineManager.months.map((month) => month.height)).toEqual(dayHeights);
    });
  });

  describe('cell grids (FL-33 Browse and Work)', () => {
    let timelineManager: TimelineManager;
    const inMonth = (month: string, count: number) =>
      timelineAssetFactory.buildList(count).map((asset, index) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...asset,
          fileCreatedAt: fromISODateTimeUTCToObject(
            `${month}-${String(1 + (index % 20)).padStart(2, '0')}T12:00:00.000Z`,
          ),
        }),
      );
    const buckets: Record<string, TimelineAsset[]> = {
      '2024-03-01': inMonth('2024-03', 200),
      '2024-02-01': inMonth('2024-02', 40),
      '2023-12-01': inMonth('2023-12', 7),
    };
    const browse = cellGridOptions('browse', 200, false);

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue(
        Object.entries(buckets).map(([timeBucket, assets]) => ({ timeBucket, count: assets.length })),
      );
      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
        Promise.resolve(toResponseDto(...buckets[timeBucket.slice(0, 10)])),
      );
      timelineManager.setLayoutOptions({
        headerHeight: browse.gap,
        gap: browse.gap,
        fillRowWidth: true,
        cells: browse,
      });
      // A short viewport: only the newest month is loaded, the others stay placeholders.
      await timelineManager.updateViewport({ width: 1000, height: 200 });
      await tick();
    });

    it('gives every month its exact grid height, loaded or not', () => {
      const [march, february, december] = timelineManager.months;
      expect(march.isLoaded).toBe(true);
      expect(december.isLoaded).toBe(false);
      for (const [month, count] of [
        [march, 200],
        [february, 40],
        [december, 7],
      ] as const) {
        expect(month.height).toBe(browse.gap + cellGrid(count, 1000, browse).height);
      }
    });

    it('lays a loaded month out as one grid of square cells, row by row', () => {
      const [march] = timelineManager.months;
      const grid = cellGrid(200, 1000, browse);
      const positions = march.timelineDays.flatMap((day) =>
        day.viewerAssets.map((viewerAsset) => viewerAsset.position!),
      );
      expect(positions).toHaveLength(200);
      for (const [index, position] of positions.entries()) {
        expect(position).toEqual(grid.position(index));
        expect(position.width).toBeGreaterThan(0);
      }
      // Square cells: the image height matches the cell width.
      expect(grid.imageHeight).toBe(Math.round(grid.cellWidth));
    });

    it('mounts only the cells near the viewport, not the whole month', () => {
      const [march] = timelineManager.months;
      const active = march.timelineDays.reduce((total, day) => total + day.activeViewerAssets.length, 0);
      expect(active).toBeGreaterThan(0);
      expect(active).toBeLessThan(200);
    });

    it('reflows every month when the Thumbnail size changes', () => {
      const before = timelineManager.months.map((month) => month.height);
      const larger = cellGridOptions('browse', 290, false);
      timelineManager.setLayoutOptions({
        headerHeight: larger.gap,
        gap: larger.gap,
        fillRowWidth: true,
        cells: larger,
      });
      const after = timelineManager.months.map((month) => month.height);
      expect(after.every((height, index) => height > before[index])).toBe(true);
    });

    it('goes back to justified rows without cells', () => {
      timelineManager.setLayoutOptions({ fillRowWidth: true });
      expect(timelineManager.cells).toBeNull();
      const [march] = timelineManager.months;
      expect(new Set(march.timelineDays.map((day) => day.top)).size).toBeGreaterThan(1);
    });
  });

  /**
   * FL-143: Years and All justify a whole group as one flow, as the prototype does, although the
   * library loads a month bucket at a time. Months and Days stay one flow per month or day.
   */
  describe('one flow across months for Years and All (FL-143)', () => {
    let timelineManager: TimelineManager;
    const onDays = (month: string, ratios: number[], days: number[]) =>
      ratios.map((ratio, index) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...timelineAssetFactory.build(),
          ratio,
          fileCreatedAt: fromISODateTimeUTCToObject(`${month}-${String(days[index]).padStart(2, '0')}T12:00:00.000Z`),
        }),
      );
    // At 1200 wide the flow over all three months is [a1 a2 a3] [a4 b1 b2 b3] [b4 b5 b6 c1] [c2 c3]:
    // two of its rows cross a month boundary.
    const buckets: Record<string, TimelineAsset[]> = {
      '2024-03-01': onDays('2024-03', [1.5, 1.5, 1.5, 1.5], [20, 20, 10, 10]),
      '2024-02-01': onDays('2024-02', [0.75, 1.5, 2, 1.5, 1, 1.5], [14, 14, 14, 3, 3, 3]),
      '2023-12-01': onDays('2023-12', [1.5, 1.5, 1.5], [25, 25, 25]),
    };

    beforeEach(async () => {
      timelineManager = new TimelineManager();
      sdkMock.getTimeBuckets.mockResolvedValue(
        Object.entries(buckets).map(([timeBucket, assets]) => ({ timeBucket, count: assets.length })),
      );
      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
        Promise.resolve(toResponseDto(...buckets[timeBucket.slice(0, 10)])),
      );
      // The Timeline's filling rows, as LibraryTimeline sets them.
      timelineManager.setLayoutOptions({ fillRowWidth: true });
      await timelineManager.updateViewport({ width: 1200, height: 5000 });
      await vi.waitFor(() => expect(timelineManager.months.every((month) => month.isLoaded)).toBe(true));
      await settle();
    });

    const lastTile = (month: TimelineMonth) => month.timelineDays.at(-1)!.viewerAssets.at(-1)!;

    it('lays an All group out as the prototype does: rows run on across month boundaries', () => {
      timelineManager.grouping = 'all';
      const [march, february, december] = timelineManager.months;
      const rowMonths = expectOneFlow(timelineManager, [march, february, december]);
      expect(rowMonths.filter((months) => months.size > 1)).toHaveLength(2);
      // A month boundary inside the group is a row gap, not a month gap.
      expect(february.groupHeaderHeight).toBe(timelineManager.justifiedLayoutOptions.spacing);
      expect(december.groupHeaderHeight).toBe(timelineManager.justifiedLayoutOptions.spacing);
      // A row that crosses the boundary is laid out and drawn by the later month.
      expect(february.flowCarried.map(({ viewerAsset }) => viewerAsset.id)).toEqual([lastTile(march).id]);
      expect(lastTile(march).flowHost).toBe(february);
      expect(december.flowCarried).toHaveLength(3);
      // The carried tiles are drawn inside the later month's full-width rows.
      expect(february.flowContentWidth).toBe(timelineManager.justifiedLayoutOptions.rowWidth);
      expect(february.flowContentHeight).toBe(february.height - february.groupHeaderHeight);
    });

    it('runs a Years group on across its months, and starts each year on a row of its own', () => {
      timelineManager.grouping = 'years';
      const [march, february, december] = timelineManager.months;
      const rowMonths = expectOneFlow(timelineManager, [march, february]);
      expect(rowMonths.filter((months) => months.size > 1)).toHaveLength(1);
      // 2023 opens a new group: nothing runs on into it and it keeps its header.
      expect(december.flowLinkedTo).toBeUndefined();
      expect(december.flowCarried).toEqual([]);
      expect(december.groupHeaderHeight).toBe(timelineManager.headerHeight);
      expect(february.flowClosed).toBe(true);
      expectOneFlow(timelineManager, [december]);
    });

    it('keeps Months to one flow per month, and Days to the day groups, after All', () => {
      const dayHeights = timelineManager.months.map((month) => month.height);
      timelineManager.grouping = 'all';
      timelineManager.grouping = 'months';
      for (const month of timelineManager.months) {
        expect(month.flowCarried).toEqual([]);
        expect(month.groupHeaderHeight).toBe(timelineManager.headerHeight);
        expect(flowTiles([month]).every(({ viewerAsset }) => viewerAsset.flowHost === undefined)).toBe(true);
        expectOneFlow(timelineManager, [month]);
      }
      timelineManager.grouping = 'days';
      expect(timelineManager.months.map((month) => month.height)).toEqual(dayHeights);
    });

    it('lays the flow out again across the boundary when a photo is removed', () => {
      timelineManager.grouping = 'all';
      const [march, february, december] = timelineManager.months;
      timelineManager.removeAssets([february.timelineDays[0].viewerAssets[1].id]);
      expectOneFlow(timelineManager, [march, february, december]);
    });
  });

  describe('an earlier month of an All group loading above what is on screen (FL-143)', () => {
    let timelineManager: TimelineManager;
    let scrollTop: number;
    let releaseMarch: () => void;
    let clock: number;
    const inMonth = (month: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        deriveLocalDateTimeFromFileCreatedAt({
          ...timelineAssetFactory.build(),
          ratio: 1.5,
          fileCreatedAt: fromISODateTimeUTCToObject(`${month}-${String(28 - index).padStart(2, '0')}T12:00:00.000Z`),
        }),
      );
    const march = inMonth('2024-03', 8);
    const february = inMonth('2024-02', 20);
    const january = inMonth('2024-01', 20);

    beforeEach(async () => {
      clock = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const pendingMarch = deferred<TimeBucketAssetResponseDto>();
      releaseMarch = () => pendingMarch.resolve(toResponseDto(...march));
      sdkMock.getTimeBuckets.mockResolvedValue([
        { timeBucket: '2024-03-01', count: march.length },
        { timeBucket: '2024-02-01', count: february.length },
        { timeBucket: '2024-01-01', count: january.length },
      ]);
      sdkMock.getTimeBucket.mockImplementation(({ timeBucket }) =>
        timeBucket.startsWith('2024-03')
          ? pendingMarch.promise
          : Promise.resolve(toResponseDto(...(timeBucket.startsWith('2024-02') ? february : january))),
      );
      timelineManager = new TimelineManager();
      scrollTop = 0;
      timelineManager.scrollableElement = {
        get scrollTop() {
          return scrollTop;
        },
        scrollTo({ top }: { top: number }) {
          scrollTop = Math.max(0, top);
        },
        scrollBy(_x: number, y: number) {
          scrollTop = Math.max(0, scrollTop + y);
        },
      } as unknown as HTMLElement;
      timelineManager.setLayoutOptions({ fillRowWidth: true });
      timelineManager.grouping = 'all';
      // March is on screen and requested, but its bucket has not arrived; February, just below, has.
      await timelineManager.updateViewport({ width: 1200, height: 400 });
      await vi.waitFor(() => expect(timelineManager.months[1].isLoaded).toBe(true));
      await settle();
    });

    afterEach(() => {
      vi.mocked(Date.now).mockRestore();
    });

    it('leaves February where it is when March loads above it, and runs the rows on once they are off screen', async () => {
      const [marchMonth, februaryMonth, januaryMonth] = timelineManager.months;
      expect(marchMonth.isLoaded).toBe(false);
      expect(januaryMonth.isLoaded).toBe(false);

      // February has been on screen for a while.
      clock += FLOW_SETTLE_MS + 1;
      timelineManager.scrollTo(februaryMonth.top + 20);
      const onScreen = () =>
        flowTiles([februaryMonth]).map(({ viewerAsset }) => ({
          id: viewerAsset.id,
          top: februaryMonth.findAssetAbsolutePosition(viewerAsset.id)!.top - timelineManager.scrollTop,
          left: viewerAsset.position!.left,
          width: viewerAsset.position!.width,
        }));
      const before = onScreen();
      const scrolledTo = timelineManager.scrollTop;

      releaseMarch();
      await vi.waitFor(() => expect(marchMonth.isLoaded).toBe(true));
      await settle();

      // March grew from its estimate above the viewport; the scroll position absorbed that and
      // February's rows were left exactly as they were.
      expect(timelineManager.scrollTop).not.toBe(scrolledTo);
      expect(onScreen()).toEqual(before);
      expect(februaryMonth.flowLinkedTo).toBeUndefined();
      expect(februaryMonth.flowCarried).toEqual([]);
      expect(marchMonth.flowClosed).toBe(true);

      // Back at the top, March's last row and February are off screen: the rows run on.
      timelineManager.scrollTo(0);
      expect(timelineManager.scrollTop).toBe(0);
      expect(februaryMonth.flowLinkedTo).toBe(marchMonth);
      expect(marchMonth.flowClosed).toBe(false);
      expect(februaryMonth.flowCarried.length).toBeGreaterThan(0);
      expectOneFlow(timelineManager, [marchMonth, februaryMonth]);
    });

    it('runs the rows on straight away while the months are still settling in', async () => {
      const [marchMonth, februaryMonth] = timelineManager.months;
      timelineManager.scrollTo(februaryMonth.top + 20);
      releaseMarch();
      await vi.waitFor(() => expect(marchMonth.isLoaded).toBe(true));
      await settle();
      expect(februaryMonth.flowLinkedTo).toBe(marchMonth);
      expectOneFlow(timelineManager, [marchMonth, februaryMonth]);
    });
  });
});
