import { TimeBucketDateType } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import type { TimelineManager } from '../timeline-manager.svelte';
import type { TimelineMonth } from '../timeline-month.svelte';
import type { Direction, TimelineAsset } from '../types';
import { getAssetWithOffset } from './search-support.svelte';

function createMockTimelineMonth(year: number, month: number): TimelineMonth {
  return { yearMonth: { year, month } } as TimelineMonth;
}

describe('calendar offset navigation', () => {
  const asset = (id: string, taken: string, added = taken) =>
    ({
      id,
      localDateTime: fromISODateTimeUTCToObject(taken),
      createdAt: fromISODateTimeUTCToObject(added),
    }) as TimelineAsset;

  function managerFor(assets: TimelineAsset[], dateType = TimeBucketDateType.Taken) {
    const start = assets[0];
    const month = {
      yearMonth: { year: start.localDateTime.year, month: start.localDateTime.month },
      findAssetById: () => start,
      findTimelineDayForAsset: () => ({}),
    } as unknown as TimelineMonth;
    return {
      findTimelineMonthForAsset: async () => month,
      getDateType: () => dateType,
      async *assetsIterator() {
        yield* assets;
      },
    } as unknown as TimelineManager;
  }

  it.each<Direction>(['earlier', 'later'])(
    'finds a different day when the day number repeats across months (%s)',
    async (direction) => {
      const assets = [
        asset('start', '2024-05-10'),
        asset('next', direction === 'earlier' ? '2024-04-10' : '2024-06-10'),
      ];
      await expect(getAssetWithOffset(managerFor(assets), assets[0], 'day', direction)).resolves.toBe(assets[1]);
    },
  );

  it('uses the added date when navigating an added-date timeline', async () => {
    const assets = [
      asset('start', '2020-01-01', '2024-05-10'),
      asset('same-day', '2021-02-02', '2024-05-10'),
      asset('next-day', '2021-02-02', '2024-05-09'),
    ];
    await expect(
      getAssetWithOffset(managerFor(assets, TimeBucketDateType.Added), assets[0], 'day', 'earlier'),
    ).resolves.toBe(assets[2]);
  });

  it('skips same-day assets and returns undefined at the end', async () => {
    const assets = [asset('start', '2024-05-10'), asset('same', '2024-05-10')];
    await expect(getAssetWithOffset(managerFor(assets), assets[0], 'day', 'later')).resolves.toBeUndefined();
  });

  it.each<Direction>(['earlier', 'later'])(
    'finds a different month when the month number repeats across years (%s)',
    async (direction) => {
      const assets = [
        asset('start', '2024-05-10'),
        asset('next', direction === 'earlier' ? '2023-05-10' : '2025-05-10'),
      ];
      const manager = managerFor(assets);
      const startMonth = await manager.findTimelineMonthForAsset(assets[0]);
      const nextMonth = createMockTimelineMonth(direction === 'earlier' ? 2023 : 2025, 5);
      manager.timelineMonthIterator = function* () {
        yield startMonth!;
        yield nextMonth;
      };
      let closed = false;
      manager.assetsIterator = async function* ({ startTimelineMonth } = {}) {
        try {
          yield startTimelineMonth === nextMonth ? assets[1] : assets[0];
        } finally {
          closed = true;
        }
      };
      await expect(getAssetWithOffset(manager, assets[0], 'month', direction)).resolves.toBe(assets[1]);
      expect(closed).toBe(true);
    },
  );
});
