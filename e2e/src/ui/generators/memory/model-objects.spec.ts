import { expect, it } from 'vitest';
import type { MockTimelineAsset } from '../timeline/timeline-config';
import { generateMemoriesFromTimeline } from './model-objects';

const asset = (id: string, fileCreatedAt: string) =>
  ({ id, ownerId: 'owner', fileCreatedAt, ratio: 1, latitude: null, longitude: null }) as unknown as MockTimelineAsset;

it('orders generated memories newest first whatever order the years are configured in', () => {
  const assets = [
    asset('a-2022', '2022-06-01T10:00:00.000Z'),
    asset('a-2023', '2023-06-01T10:00:00.000Z'),
    asset('a-2024', '2024-06-01T10:00:00.000Z'),
  ];
  const memories = generateMemoriesFromTimeline(assets, 'owner', [
    { year: 2022, assetCount: 1 },
    { year: 2024, assetCount: 1 },
    { year: 2023, assetCount: 1 },
  ]);
  expect(memories.map(({ data }) => (data as { year: number }).year)).toEqual([2024, 2023, 2022]);
});
