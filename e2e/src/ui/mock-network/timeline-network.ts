import { AssetResponseDto, AssetVisibility } from '@immich/sdk';
import { BrowserContext, Page, Request, Route } from '@playwright/test';
import { basename } from 'node:path';
import {
  Changes,
  getAlbum,
  getAsset,
  getTimeBucket,
  getTimeBuckets,
  getTimelineHighlights,
  randomPreview,
  randomThumbnail,
  TimelineData,
} from 'src/ui/generators/timeline';
import { toColumnarFormat } from 'src/ui/generators/timeline/rest-response.js';
import { sleep } from 'src/ui/specs/timeline/utils.js';
import { MINIMAL_MP4_BUFFER } from './face-editor-network';

export class TimelineTestContext {
  slowBucket = false;
  adminId = '';
}

export const setupTimelineMockApiRoutes = async (
  context: BrowserContext,
  timelineRestData: TimelineData,
  changes: Changes,
  testContext: TimelineTestContext,
) => {
  await context.route('**/api/timeline**', async (route, request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (pathname === '/api/timeline/buckets') {
      const albumId = url.searchParams.get('albumId') || undefined;
      const isTrashed = url.searchParams.get('isTrashed') ? url.searchParams.get('isTrashed') === 'true' : undefined;
      const isFavorite = url.searchParams.get('isFavorite') ? url.searchParams.get('isFavorite') === 'true' : undefined;
      const isArchived = url.searchParams.get('visibility')
        ? url.searchParams.get('visibility') === 'archive'
        : undefined;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: getTimeBuckets(timelineRestData, isTrashed, isArchived, isFavorite, albumId, changes),
      });
    }
    if (pathname === '/api/timeline/highlights') {
      const param = (name: string) => url.searchParams.get(name);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: getTimelineHighlights(
          timelineRestData,
          param('grouping') === 'month' ? 'month' : 'year',
          Number(param('highlightCount') ?? 0),
          param('isTrashed') ? param('isTrashed') === 'true' : undefined,
          param('visibility') ? param('visibility') === 'archive' : undefined,
          param('isFavorite') ? param('isFavorite') === 'true' : undefined,
          param('albumId') || undefined,
          changes,
        ),
      });
    }
    if (pathname === '/api/timeline/ordered') {
      // FL-30 (S-15): the library's own assets in a flat order; the mock names each file by its id.
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const take = Number(url.searchParams.get('take') ?? 500);
      const sort = url.searchParams.get('sort');
      const assets = timelineRestData.buckets
        .values()
        .toArray()
        .flat()
        .filter(
          (asset) =>
            !asset.isTrashed &&
            asset.visibility === AssetVisibility.Timeline &&
            !changes.assetDeletions.includes(asset.id) &&
            !changes.assetArchivals.includes(asset.id),
        )
        .toSorted((a, b) => (sort === 'filename' ? a.id.localeCompare(b.id) : 0))
        .slice(skip, skip + take);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { ...toColumnarFormat(assets), originalFileName: assets.map((asset) => `${asset.id}.jpg`) },
      });
    }
    if (pathname === '/api/timeline/bucket') {
      const timeBucket = url.searchParams.get('timeBucket');
      if (!timeBucket) {
        return route.continue();
      }
      const isTrashed = url.searchParams.get('isTrashed') ? url.searchParams.get('isTrashed') === 'true' : undefined;
      const isArchived = url.searchParams.get('visibility')
        ? url.searchParams.get('visibility') === 'archive'
        : undefined;
      const isFavorite = url.searchParams.get('isFavorite') ? url.searchParams.get('isFavorite') === 'true' : undefined;
      const albumId = url.searchParams.get('albumId') || undefined;
      const assets = getTimeBucket(timelineRestData, timeBucket, isTrashed, isArchived, isFavorite, albumId, changes);
      if (testContext.slowBucket) {
        await sleep(5000);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: assets,
      });
    }
    return route.continue();
  });

  await context.route('**/api/assets/*', async (route, request) => {
    if (request.method() === 'GET') {
      const url = new URL(request.url());
      const pathname = url.pathname;
      const assetId = basename(pathname);
      let asset = getAsset(timelineRestData, assetId);
      if (changes.assetDeletions.includes(asset!.id)) {
        asset = {
          ...asset,
          isTrashed: true,
        } as AssetResponseDto;
      }
      // The asset endpoint reports the same changes the buckets do.
      if (changes.assetFavorites.includes(asset!.id)) {
        asset = { ...asset, isFavorite: true } as AssetResponseDto;
      }
      if (changes.assetArchivals.includes(asset!.id)) {
        asset = { ...asset, visibility: AssetVisibility.Archive } as AssetResponseDto;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: asset,
      });
    }
    await route.fallback();
  });

  await context.route('**/api/assets', async (route, request) => {
    if (request.method() === 'DELETE') {
      return route.fulfill({
        status: 204,
      });
    }
    await route.fallback();
  });

  await context.route('**/api/assets/*/ocr', async (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', json: [] });
  });

  await context.route('**/api/assets/*/thumbnail?size=*', async (route, request) => {
    const pattern = /\/api\/assets\/(?<assetId>[^/]+)\/thumbnail\?size=(?<size>preview|thumbnail)/;
    const match = request.url().match(pattern);
    if (!match?.groups) {
      throw new Error(`Invalid URL for thumbnail endpoint: ${request.url()}`);
    }

    if (match.groups.size === 'preview') {
      if (!route.request().serviceWorker()) {
        return route.continue();
      }
      const asset = getAsset(timelineRestData, match.groups.assetId);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/jpeg', ETag: 'abc123', 'Cache-Control': 'public, max-age=3600' },
        body: await randomPreview(
          match.groups.assetId,
          (asset?.exifInfo?.exifImageWidth ?? 0) / (asset?.exifInfo?.exifImageHeight ?? 1),
        ),
      });
    }
    if (match.groups.size === 'thumbnail') {
      if (!route.request().serviceWorker()) {
        return route.continue();
      }
      const asset = getAsset(timelineRestData, match.groups.assetId);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: await randomThumbnail(
          match.groups.assetId,
          (asset?.exifInfo?.exifImageWidth ?? 0) / (asset?.exifInfo?.exifImageHeight ?? 1),
        ),
      });
    }
    return route.continue();
  });

  await context.route('**/api/assets/*/video/playback*', async (route) => {
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'video/mp4' },
      body: MINIMAL_MP4_BUFFER,
    });
  });

  // The album page offers Activity on every album, shared or not (CollectionHeader.jsx), so it
  // reads the album's likes and comments on open; the mock album has none.
  await context.route('**/api/activities**', async (route, request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      return route.fallback();
    }
    return route.fulfill({ json: pathname.endsWith('/statistics') ? { comments: 0, likes: 0 } : [] });
  });

  await context.route('**/api/albums/**', async (route, request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/albums/tree') {
      // The library rail reads the album tree; the mock album stands on its own.
      const album = getAlbum(timelineRestData, testContext.adminId, timelineRestData.album.id, changes);
      return route.fulfill({ json: { albums: [album], collections: [], spaces: [] } });
    }
    // Only the album itself: sub-resources (descendant counts, members, ...) are not mocked.
    const albumsMatch = pathname.match(/^\/api\/albums\/(?<albumId>[0-9a-f-]{36})$/);
    if (albumsMatch && request.method() === 'GET') {
      const album = getAlbum(timelineRestData, testContext.adminId, albumsMatch.groups?.albumId, changes);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: album,
      });
    }
    return route.fallback();
  });

  await context.route('**/api/albums**', async (route, request) => {
    const allAlbums = request.url().match(/\/api\/albums\?assetId=(?<assetId>[^&]+)/);
    if (allAlbums) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: [],
      });
    }
    return route.fallback();
  });
};

/**
 * The Frameleaf trash (FL-47) reads its own list and changes it through a review and an apply. Opt
 * in per spec: a page that shows the trash under the viewer would otherwise gain its rows.
 */
export const setupTrashMockApiRoutes = async (
  context: BrowserContext,
  timelineRestData: TimelineData,
  changes: Changes,
) => {
  const trashItems = () =>
    changes.assetDeletions
      .map((id) => getAsset(timelineRestData, id))
      .filter((asset): asset is AssetResponseDto => !!asset)
      .map((asset) => ({
        id: asset.id,
        originalFileName: asset.originalFileName,
        fileSizeInByte: null,
        isLocked: false,
        isOffline: false,
        trashedAt: new Date().toISOString(),
        type: asset.type,
      }));

  await context.route('**/api/trash/**', async (route, request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/trash/summary') {
      return route.fulfill({ json: { bytes: 0, count: trashItems().length, offline: 0, pendingDeletion: 0 } });
    }
    if (pathname === '/api/trash/items') {
      const items = trashItems();
      return route.fulfill({ json: { items, nextPage: null, total: items.length } });
    }
    if (pathname === '/api/trash/review') {
      const { action, ids = [] } = request.postDataJSON();
      return route.fulfill({
        json: {
          action,
          bytes: 0,
          count: ids.length,
          names: [],
          retainedBytes: 0,
          retainedOriginals: 0,
          token: 'review',
        },
      });
    }
    if (pathname === '/api/trash/apply') {
      const { action, ids = [] } = request.postDataJSON();
      if (action === 'restore') {
        changes.assetDeletions = changes.assetDeletions.filter((id) => !ids.includes(id));
      }
      return route.fulfill({ json: { count: ids.length } });
    }
    return route.fallback();
  });
};

export const pageRoutePromise = async (
  page: Page,
  route: string,
  callback: (route: Route, request: Request) => Promise<void>,
) => {
  let resolveRequest: ((value: unknown | PromiseLike<unknown>) => void) | undefined;
  const deleteRequest = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  await page.route(route, async (route, request) => {
    await callback(route, request);
    const requestJson = request.postDataJSON();
    resolveRequest?.(requestJson);
  });
  return deleteRequest;
};
