import { AssetVisibility } from '@frameleaf/sdk';
import type { BrowserContext, Request, Route } from '@playwright/test';
import type { Changes, TimelineData } from 'src/ui/generators/timeline';
import { expect, it, vi } from 'vitest';
import { setupTimelineMockApiRoutes, setupTrashMockApiRoutes, TimelineTestContext } from './timeline-network';

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
  const context = { route } as unknown as BrowserContext;
  const { purge } = await setupTimelineMockApiRoutes(context, data, changes, new TimelineTestContext());
  await setupTrashMockApiRoutes(context, data, changes, purge);
  const handler = route.mock.calls.find(([pattern]) => pattern === '**/api/timeline**')![1];
  const request = async (path: string) => {
    const fulfill = vi.fn();
    await handler({ fulfill } as unknown as Route, { url: () => `http://localhost/api/timeline/${path}` } as Request);
    return fulfill.mock.calls[0][0];
  };
  const deleteHandler = route.mock.calls.find(([pattern]) => pattern === '**/api/assets')![1];
  const deleteAssets = async (ids: string[], force?: boolean) => {
    const fulfill = vi.fn();
    await deleteHandler(
      { fulfill } as unknown as Route,
      { method: () => 'DELETE', postDataJSON: () => ({ ids, force }) } as unknown as Request,
    );
    expect(fulfill).toHaveBeenCalledWith({ status: 204 });
  };
  const trashHandler = route.mock.calls.find(([pattern]) => pattern === '**/api/trash/**')![1];
  const trashRequest = async (path: string, action?: string, ids?: string[]) => {
    const fulfill = vi.fn();
    await trashHandler(
      { fulfill } as unknown as Route,
      { url: () => `http://localhost/api/trash/${path}`, postDataJSON: () => ({ action, ids }) } as unknown as Request,
    );
    return fulfill.mock.calls[0][0].json;
  };
  const readAlbum = async () => {
    const fulfill = vi.fn();
    const albumHandler = route.mock.calls.find(([pattern]) => pattern === '**/api/albums/**')![1];
    await albumHandler(
      { fulfill } as unknown as Route,
      { url: () => 'http://localhost/api/albums/tree', method: () => 'GET' } as unknown as Request,
    );
    return fulfill.mock.calls[0][0].json.albums[0];
  };
  const readAsset = async (id: string) => {
    const fulfill = vi.fn();
    const assetHandler = route.mock.calls.find(([pattern]) => pattern === '**/api/assets/*')![1];
    await assetHandler(
      { fulfill } as unknown as Route,
      { url: () => `http://localhost/api/assets/${id}`, method: () => 'GET' } as unknown as Request,
    );
    return fulfill.mock.calls[0][0];
  };
  const applyTrash = (action: string, ids?: string[]) => trashRequest('apply', action, ids);
  return { changes, request, deleteAssets, data, applyTrash, trashRequest, readAlbum, readAsset };
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

it.each(['', '&isTrashed=false', '&isTrashed=true'])(
  'keeps trash filtering consistent across timeline routes with query %s',
  async (filter) => {
    const { changes, request } = await fixture();
    for (const deletedId of ['0000', '0001']) {
      changes.assetDeletions.push(deletedId);
      const expectedIds = Array.from({ length: 501 }, (_, index) => String(index).padStart(4, '0')).filter(
        (id) => changes.assetDeletions.includes(id) === (filter === '&isTrashed=true'),
      );
      const page = await request(`bucket?timeBucket=2025-01-01${filter}`);
      expect(page.json.id).toEqual(expectedIds);
      const summaries = await request(`buckets?pageSize=500${filter}`);
      expect(summaries.json).toMatchObject([
        { count: expectedIds.length, firstAssetId: expectedIds[0], lastAssetId: expectedIds.at(-1) },
      ]);
      const highlights = await request(`highlights?grouping=month&highlightCount=12${filter}`);
      expect(highlights.json).toMatchObject([
        { count: expectedIds.length, keyAssetId: expectedIds[0], highlightAssetIds: expectedIds.slice(1, 13) },
      ]);
    }
  },
);

it.each([undefined, false])('retains soft deletions through refresh when force is %s', async (force) => {
  const { changes, request, deleteAssets } = await fixture();
  await deleteAssets(['0000'], force);
  await deleteAssets(['0000', '0001'], force);
  expect(changes.assetDeletions).toEqual(['0000', '0001']);
  const page = await request('bucket?timeBucket=2025-01-01');
  expect(page.json.id).toHaveLength(499);
  expect(page.json.id).not.toContain('0000');
  expect(page.json.id).not.toContain('0001');
  const summaries = await request('buckets?pageSize=500');
  expect(summaries.json).toMatchObject([{ count: 499, firstAssetId: '0002', lastAssetId: '0500' }]);
  const highlights = await request('highlights?grouping=month&highlightCount=12');
  expect(highlights.json).toMatchObject([{ count: 499, keyAssetId: '0002' }]);
  expect(highlights.json[0].highlightAssetIds).not.toContain('0000');
  expect(highlights.json[0].highlightAssetIds).not.toContain('0001');
  const trash = await request('bucket?timeBucket=2025-01-01&isTrashed=true');
  expect(trash.json.id).toEqual(['0000', '0001']);
});

it('permanently removes forced deletions from every timeline without changing the shared baseline', async () => {
  const { changes, request, deleteAssets, data } = await fixture();
  await deleteAssets(['0000']);
  await deleteAssets(['0000', '0001'], true);
  expect(changes.assetDeletions).toEqual([]);
  for (const filter of ['', '&isTrashed=true']) {
    const page = await request(`bucket?timeBucket=2025-01-01${filter}`);
    expect(page.json.id).not.toContain('0000');
    expect(page.json.id).not.toContain('0001');
  }
  const summaries = await request('buckets?pageSize=500');
  expect(summaries.json).toMatchObject([{ count: 499, firstAssetId: '0002', lastAssetId: '0500' }]);
  const highlights = await request('highlights?grouping=month&highlightCount=12');
  expect(highlights.json).toMatchObject([{ count: 499, keyAssetId: '0002' }]);
  expect(data.buckets.get('2025-01-01')).toHaveLength(501);
});

it.each([
  ['delete', ['0000', '0001']],
  ['empty', undefined],
  ['empty', []],
] as const)('purges trash action %s with ids %j', async (action, ids) => {
  const { changes, request, deleteAssets, applyTrash, data } = await fixture();
  await deleteAssets(['0000', '0001']);
  expect(await applyTrash(action, ids ? [...ids] : undefined)).toEqual({ count: 2 });
  expect(changes.assetDeletions).toEqual([]);
  for (const filter of ['', '&isTrashed=true']) {
    const page = await request(`bucket?timeBucket=2025-01-01${filter}`);
    expect(page.json.id).not.toContain('0000');
    expect(page.json.id).not.toContain('0001');
  }
  const summaries = await request('buckets?pageSize=500');
  expect(summaries.json).toMatchObject([{ count: 499, firstAssetId: '0002', lastAssetId: '0500' }]);
  const highlights = await request('highlights?grouping=month&highlightCount=12');
  expect(highlights.json).toMatchObject([{ count: 499, keyAssetId: '0002' }]);
  expect(data.buckets.get('2025-01-01')).toHaveLength(501);
});

it('removes a purged album cover and refuses asset reads while retaining the next test baseline', async () => {
  const { deleteAssets, readAlbum, readAsset, data } = await fixture();
  await deleteAssets(['0500'], true);
  expect(await readAsset('0500')).toEqual({ status: 404 });
  expect(await readAlbum()).toMatchObject({ assetCount: 0, albumThumbnailAssetId: null });
  expect(data.album.assetIds).toEqual(['0500']);
  expect(data.album.thumbnailAssetId).toBe('0500');
  expect(data.buckets.get('2025-01-01')).toHaveLength(501);
});

it('does not resurrect a purged photo after a stale soft delete', async () => {
  const { deleteAssets, changes, trashRequest } = await fixture();
  await deleteAssets(['0000'], true);
  await deleteAssets(['0000']);
  expect(await trashRequest('items')).toEqual({ items: [], nextPage: null, total: 0 });
  expect(changes.assetDeletions).toEqual([]);
});

it.each([[undefined], [[]]])('reviews the same whole-trash set that empty applies with ids %j', async (ids) => {
  const { deleteAssets, trashRequest, applyTrash } = await fixture();
  await deleteAssets(['0000', '0001']);
  expect(await trashRequest('review', 'empty', ids)).toMatchObject({ action: 'empty', count: 2 });
  expect(await applyTrash('empty', ids)).toEqual({ count: 2 });
});

it('restores the whole trash and counts selected visible items once', async () => {
  const { deleteAssets, trashRequest, applyTrash, changes } = await fixture();
  await deleteAssets(['0000', '0001']);
  expect(await trashRequest('review', 'delete', ['0000', '0000', 'missing'])).toMatchObject({ count: 1 });
  expect(await trashRequest('review', 'restore-all')).toMatchObject({ count: 2 });
  expect(await applyTrash('restore-all')).toEqual({ count: 2 });
  expect(changes.assetDeletions).toEqual([]);
});
