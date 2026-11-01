import { AssetVisibility } from '@frameleaf/sdk';
import type { BrowserContext, Request, Route } from '@playwright/test';
import type { Changes, TimelineData } from 'src/ui/generators/timeline';
import { expect, it, vi } from 'vitest';
import { setupTimelineMockApiRoutes, TimelineTestContext } from './timeline-network';

const fixture = async () => {
  const assets = Array.from({ length: 501 }, (_, index) => ({
    id: String(index).padStart(4, '0'),
    ownerId: 'owner',
    ratio: 1,
    thumbhash: null,
    localDateTime: '2025-01-01T12:00:00.000Z',
    fileCreatedAt: '2025-01-01T12:00:00.000Z',
    isFavorite: false,
    isTrashed: false,
    isVideo: false,
    isImage: true,
    duration: null,
    projectionType: null,
    livePhotoVideoId: null,
    city: null,
    country: null,
    people: null,
    latitude: null,
    longitude: null,
    visibility: AssetVisibility.Timeline,
    stack: null,
    checksum: '',
    fileSizeInByte: 1,
  }));
  const data: TimelineData = {
    buckets: new Map([['2025-01-01', assets]]),
    album: {
      id: 'album',
      albumName: 'Album',
      description: '',
      assetIds: ['0500'],
      thumbnailAssetId: '0500',
      createdAt: '',
      updatedAt: '',
    },
  };
  const changes: Changes = { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: ['0500'] };
  const route = vi.fn();
  await setupTimelineMockApiRoutes({ route } as unknown as BrowserContext, data, changes, new TimelineTestContext());
  const handler = route.mock.calls.find(([pattern]) => pattern === '**/api/timeline**')![1];
  const request = async (path: string) => {
    const fulfill = vi.fn();
    await handler({ fulfill } as unknown as Route, { url: () => `http://localhost/api/timeline/${path}` } as Request);
    return fulfill.mock.calls[0][0];
  };
  return { changes, request };
};

it.each(['isFavorite=true', 'albumId=album'])(
  'uses the same %s filter for ordered lookup and retrieval',
  async (filter) => {
    const { request } = await fixture();
    const located = await request(`buckets?sort=filename&pageSize=500&locateAssetId=0500&${filter}`);
    expect(located.json).toEqual([{ timeBucket: '1970-01-01', page: 0, count: 1 }]);
    const page = await request(`ordered?sort=filename&skip=0&take=500&${filter}`);
    expect(page.json.id).toEqual(['0500']);
    expect(page.json.isFavorite).toEqual([true]);
  },
);

it('rejects changed calendar boundaries but permits a short unasserted page', async () => {
  const { changes, request } = await fixture();
  const path = 'bucket?timeBucket=2025-01-01&take=2&after=0000&isTrashed=false';
  const original = await request(`${path}&firstAssetId=0001&lastAssetId=0002`);
  expect(original.json.id).toEqual(['0001', '0002']);
  changes.assetDeletions.push('0001');
  const changed = await request(`${path}&firstAssetId=0001&lastAssetId=0002`);
  expect(changed.status).toBe(409);
  const short = await request('bucket?timeBucket=2025-01-01&take=2&after=0499');
  expect(short.json.id).toEqual(['0500']);
  const staleLength = await request(
    'bucket?timeBucket=2025-01-01&take=2&after=0499&firstAssetId=0500&lastAssetId=0500',
  );
  expect(staleLength.status).toBe(409);
});
