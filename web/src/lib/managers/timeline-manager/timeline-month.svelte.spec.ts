import { TimeBucketDateType, type TimeBucketAssetResponseDto } from '@frameleaf/sdk';
import { SvelteSet } from 'svelte/reactivity';
import { getOrderingDate } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import type { TimelineDay } from './timeline-day.svelte';
import type { TimelineManager } from './timeline-manager.svelte';
import { bucketTimelineAssets, TimelineMonth } from './timeline-month.svelte';

it('collects assets in day order without copying asset objects or mutating day arrays', () => {
  const month = new TimelineMonth({} as TimelineManager, { year: 2026, month: 10 }, 0, true);
  expect(month.getAssets()).toEqual([]);
  const first = { id: 'first' };
  const second = { id: 'second' };
  const firstDay = [first];
  const secondDay = [second];
  month.timelineDays = [
    { getAssets: () => firstDay },
    { getAssets: () => [] },
    { getAssets: () => secondDay },
  ] as unknown as TimelineDay[];
  const assets = month.getAssets();
  expect(assets).toEqual([first, second]);
  expect(assets[0]).toBe(first);
  expect(assets[1]).toBe(second);
  assets.pop();
  expect(firstDay).toEqual([first]);
  expect(secondDay).toEqual([second]);
});

describe('month asset callbacks', () => {
  it('collects processed IDs, preserves missing IDs and removes empty groups', () => {
    const month = new TimelineMonth({} as TimelineManager, { year: 2026, month: 10 }, 0, true);
    const first = {
      viewerAssets: [{}],
      runAssetCallback: vi.fn(() => ({ moveAssets: [], processedIds: new SvelteSet(['a']), changedGeometry: false })),
    };
    const second = {
      viewerAssets: [],
      runAssetCallback: vi.fn(() => ({ moveAssets: [], processedIds: new SvelteSet(['b']), changedGeometry: true })),
    };
    month.timelineDays = [first, second] as unknown as TimelineDay[];
    const ids = new Set(['a', 'b', 'missing']);
    const result = month.runAssetCallback(ids, vi.fn());
    expect([...result.processedIds]).toEqual(['b', 'a']);
    expect([...result.unprocessedIds]).toEqual(['missing']);
    expect(result.changedGeometry).toBe(true);
    expect(month.timelineDays).toHaveLength(1);
    expect([...ids]).toEqual(['a', 'b', 'missing']);
  });
});

it.each([
  [0, 15],
  [15, 0],
  [0, 0],
  [-12, 45],
])('retains geographic coordinates (%s, %s)', (latitude, longitude) => {
  const response = toResponseDto(timelineAssetFactory.build());
  response.latitude = [latitude];
  response.longitude = [longitude];
  expect([...bucketTimelineAssets(response)][0]).toMatchObject({ latitude, longitude });
});

it('keeps coordinates absent when either axis is unknown', () => {
  const response = toResponseDto(timelineAssetFactory.build());
  response.latitude = [null];
  response.longitude = [0];
  const [asset] = bucketTimelineAssets(response as TimeBucketAssetResponseDto);
  expect(asset.latitude).toBeUndefined();
  expect(asset.longitude).toBeUndefined();
});

it('does not move the current months when a month a refresh replaced changes height', () => {
  const manager = { months: [] as TimelineMonth[], topSectionHeight: 0 } as unknown as TimelineManager;
  const current = [0, 1].map((index) => new TimelineMonth(manager, { year: 2026, month: 10 - index }, 0, true));
  manager.months = current;
  current[0].height = 100;
  current[1].height = 50;
  expect(current.map((month) => month.top)).toEqual([0, 100]);
  const detached = new TimelineMonth(manager, { year: 2020, month: 1 }, 0, true);
  detached.height = 300;
  expect(current.map((month) => month.top)).toEqual([0, 100]);
});

it('keeps upload and capture dates distinct when loading a bucket', () => {
  const response = toResponseDto(timelineAssetFactory.build());
  response.createdAt = ['2026-01-15T21:20:00.000Z'];
  response.fileCreatedAt = ['2019-06-01T12:00:00.000Z'];
  response.localOffsetHours = [-5];
  const [asset] = bucketTimelineAssets(response);
  expect(getOrderingDate(asset, TimeBucketDateType.Added)).toMatchObject({
    year: 2026,
    month: 1,
    day: 15,
    hour: 21,
    minute: 20,
  });
  expect(asset.fileCreatedAt).toMatchObject({ year: 2019, month: 6, day: 1, hour: 12 });
  expect(getOrderingDate(asset, TimeBucketDateType.Taken)).toMatchObject({ year: 2019, month: 6, day: 1, hour: 7 });
});
