import { AssetVisibility } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { toAssetResponseDto, toColumnarFormat } from 'src/ui/generators/timeline/rest-response.js';
import { MockTimelineAsset } from 'src/ui/generators/timeline/timeline-config.js';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupSocketMock } from 'src/ui/mock-network/socket-network.js';
import { thumbnailUtils, timelineUtils } from './utils.js';

const ownerId = '10000000-0000-4000-8000-000000000000';
const idAt = (position: number) => `20000000-0000-4000-8000-${position.toString().padStart(12, '0')}`;
const positionOf = (id: string) => Number(id.slice(-12));
const timeBucket = '2025-01-01';
const assetAt = (position: number): MockTimelineAsset => ({
  id: idAt(position),
  ownerId,
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
});

for (const { count, width } of [1_000_000, 2_000_000].flatMap((count) =>
  [800, 390].map((width) => ({ count, width })),
)) {
  test(`reaches the final photo in a dense ${count}-photo library at ${width}px`, async ({ context, page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 700 });
    await context.addInitScript(() => localStorage.setItem('frameleaf-thumbnail-size', '290'));
    await setupBaseMockApiRoutes(context, ownerId);
    const socket = await setupSocketMock(context);
    let total = count;
    let summaryRequests = 0;
    let heldSummary: Promise<void> | undefined;
    const requestedPages: number[] = [];
    await context.route('**/api/timeline**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/buckets')) {
        summaryRequests++;
        await heldSummary;
        expect(url.searchParams.get('pageSize')).toBe('500');
        const locator = url.searchParams.get('locateAssetId');
        const pages = Array.from({ length: Math.ceil(total / 500) }, (_, page) => ({
          timeBucket,
          days: [{ day: 1, count: total }],
          page,
          count: Math.min(500, total - page * 500),
          after: page ? idAt(page * 500 - 1) : null,
          firstAssetId: idAt(page * 500),
          lastAssetId: idAt(Math.min(total - 1, page * 500 + 499)),
        }));
        return route.fulfill({ json: locator ? [pages[Math.floor(positionOf(locator) / 500)]] : pages });
      }
      if (url.pathname.endsWith('/bucket')) {
        const take = Number(url.searchParams.get('take'));
        expect(take).toBeGreaterThan(0);
        expect(take).toBeLessThanOrEqual(500);
        const after = url.searchParams.get('after');
        const start = after ? positionOf(after) + 1 : 0;
        requestedPages.push(start);
        const assets = Array.from({ length: take }, (_, offset) => assetAt(start + offset));
        return route.fulfill({
          json: {
            ...toColumnarFormat(assets),
            startCursor: assets[0].id,
            endCursor: assets.at(-1)!.id,
          },
        });
      }
      return route.fulfill({ json: [] });
    });
    await context.route('**/api/assets/*/thumbnail**', (route) => route.fulfill({ status: 204 }));
    await page.goto('/photos');
    await expect(timelineUtils.locator(page)).toBeVisible({ timeout: 60_000 });
    await timelineUtils.waitForTimelineLoad(page);
    const scroll = timelineUtils.locator(page);
    expect(await scroll.evaluate((element) => element.scrollHeight)).toBeLessThanOrEqual(8_001_000);
    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(thumbnailUtils.withAssetId(page, idAt(count - 1))).toBeInViewport({ timeout: 30_000 });
    expect(requestedPages).toContain(count - 500);
    expect(requestedPages.length).toBeLessThan(30);
    expect(await thumbnailUtils.locator(page).count()).toBeLessThan(2000);
    await page.goto(`/photos?at=${idAt(Math.floor(count / 2))}`);
    await expect(thumbnailUtils.withAssetId(page, idAt(Math.floor(count / 2)))).toBeInViewport({ timeout: 30_000 });
    expect(requestedPages.length).toBeLessThan(50);
    await scroll.focus();
    const beforeKey = await scroll.evaluate((element) => element.scrollTop);
    await page.keyboard.press('PageDown');
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeKey);
    expect((await scroll.evaluate((element) => element.scrollTop)) - beforeKey).toBeLessThan(350);
    const beforeSpace = await scroll.evaluate((element) => element.scrollTop);
    await page.keyboard.press('Space');
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeSpace);
    const afterSpace = await scroll.evaluate((element) => element.scrollTop);
    expect(afterSpace - beforeSpace).toBeLessThan(350);
    await page.keyboard.press('Shift+Space');
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeLessThan(afterSpace);

    await expect.poll(() => socket.connected()).toBe(1);
    const requestsBeforeUpload = summaryRequests;
    const pagesBeforeUpload = requestedPages.length;
    let releaseSummary!: () => void;
    heldSummary = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    total++;
    socket.emit('on_upload_success', toAssetResponseDto(assetAt(count)));
    await expect.poll(() => summaryRequests).toBeGreaterThan(requestsBeforeUpload);
    expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeKey * 0.9);
    expect(await scroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(1_000_000);
    heldSummary = undefined;
    releaseSummary();
    await expect.poll(() => requestedPages.length).toBeGreaterThan(pagesBeforeUpload);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(beforeKey * 0.9);
  });
}
