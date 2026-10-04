import { faker } from '@faker-js/faker';
import { expect, Page, test } from '@playwright/test';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  getAsset,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupSocketMock } from 'src/ui/mock-network/socket-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';
import { setupTrashMockApiRoutes } from 'src/ui/mock-network/trash-network.js';
import { utils } from 'src/utils.js';
import { assetViewerUtils, thumbnailUtils } from '../timeline/utils';

/**
 * FL-47: the trash and the large-files review stay right across tabs. What one tab moves to the
 * trash, restores or deletes reaches the others through the server's live events, which the socket
 * mock sends here as the server would.
 */
const trashSection = '/user-settings?area=trash&section=contents';

test.describe.configure({ mode: 'parallel' });
test.describe('Trash across tabs', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  const assets: TimelineAssetConfig[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = {
    albumAdditions: [],
    assetDeletions: [],
    assetArchivals: [],
    assetFavorites: [],
  };
  const trashedAssets = () => assets.filter((asset) => changes.assetDeletions.includes(asset.id));

  test.beforeAll(() => {
    utils.initSdk();
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    assets.length = 0;
    for (const timeBucket of timelineRestData.buckets.values()) {
      assets.push(...timeBucket);
    }
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
    await setupTrashMockApiRoutes(context, trashedAssets, (ids) => {
      changes.assetDeletions = changes.assetDeletions.filter((id) => !ids.includes(id));
    });
  });

  test.afterEach(() => {
    changes.assetDeletions = [];
  });

  /** Move the open item to the trash from the viewer, recording it as the server would. */
  const trashFromViewer = async (page: Page) => {
    await page.route('**/api/assets', async (route, request) => {
      if (request.method() !== 'DELETE') {
        return route.fallback();
      }
      changes.assetDeletions.push(...(request.postDataJSON() as { ids: string[] }).ids);
      await route.fulfill({ status: 204 });
    });
    await page.getByLabel('Move to trash', { exact: true }).click();
  };

  test('an item trashed in one tab is listed, restored and back in the timeline of the other', async ({ context }) => {
    const socket = await setupSocketMock(context);
    const asset = assets[5];
    const viewerTab = await context.newPage();
    const trashTab = await context.newPage();

    await trashTab.goto(trashSection);
    await viewerTab.goto(`/photos/${asset.id}`);
    await assetViewerUtils.waitForViewerLoad(viewerTab, asset);
    await expect.poll(() => socket.connected()).toBe(2);

    await trashFromViewer(viewerTab);
    await assetViewerUtils.waitForViewerLoad(viewerTab, assets[6]);
    socket.emit('on_asset_trash', [asset.id]);

    // the Trash section of the other tab lists it
    const row = trashTab.locator('article', { has: trashTab.locator(`img[src*="${asset.id}"]`) });
    await expect(row).toBeVisible();

    // restoring it there puts it back in the first tab's timeline
    await viewerTab.keyboard.press('Escape');
    await expect(thumbnailUtils.withAssetId(viewerTab, asset.id)).toHaveCount(0);
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(row).toHaveCount(0);
    socket.emit('on_asset_restore', [asset.id]);
    await expect(thumbnailUtils.withAssetId(viewerTab, asset.id)).toBeVisible();
  });

  test('the trash viewer moves on when its item is restored in another tab', async ({ context }) => {
    const socket = await setupSocketMock(context);
    changes.assetDeletions.push(...assets.slice(10, 13).map(({ id }) => id));
    const [, open, next] = assets.slice(10, 13);
    const page = await context.newPage();

    await page.goto(`${trashSection}&assetId=${open.id}`);
    await assetViewerUtils.waitForViewerLoad(page, open);
    await expect.poll(() => socket.connected()).toBe(1);

    changes.assetDeletions = changes.assetDeletions.filter((id) => id !== open.id);
    socket.emit('on_asset_restore', [open.id]);
    await assetViewerUtils.waitForViewerLoad(page, next);
  });

  test('the large-files viewer moves on when its item is trashed in another tab', async ({ context }) => {
    const socket = await setupSocketMock(context);
    const largest = assets.slice(20, 23);
    await context.route('**/api/search/large-assets*', (route) =>
      route.fulfill({
        json: largest.map((asset, index) => {
          const response = getAsset(timelineRestData, asset.id)!;
          return { ...response, exifInfo: { ...response.exifInfo, fileSizeInByte: (3 - index) * 1024 ** 3 } };
        }),
      }),
    );
    const [first, second] = largest;
    const reviewTab = await context.newPage();
    const otherTab = await context.newPage();

    await reviewTab.goto(`/utilities/large-files/photos/${first.id}`);
    await assetViewerUtils.waitForViewerLoad(reviewTab, first);
    await otherTab.goto(`/photos/${first.id}`);
    await assetViewerUtils.waitForViewerLoad(otherTab, first);
    await expect.poll(() => socket.connected()).toBe(2);

    await trashFromViewer(otherTab);
    socket.emit('on_asset_trash', [first.id]);
    await assetViewerUtils.waitForViewerLoad(reviewTab, second);
  });
});
