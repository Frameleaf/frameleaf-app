import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  SeededRandom,
  selectRandom,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';
import { setupTrashMockApiRoutes } from 'src/ui/mock-network/trash-network.js';
import { utils } from 'src/utils.js';
import { assetViewerUtils } from '../timeline/utils';

/** FL-71: the viewer over the Command Center's Trash section (the old `/trash/photos/:id` address). */
const trashViewer = (id: string) => `/user-settings?area=trash&section=contents&assetId=${id}`;

test.describe.configure({ mode: 'parallel' });
test.describe('asset-viewer', () => {
  const rng = new SeededRandom(529);
  let adminUserId: string;
  let timelineRestData: TimelineData;
  const assets: TimelineAssetConfig[] = [];
  const yearMonths: string[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = {
    albumAdditions: [],
    assetDeletions: [],
    assetArchivals: [],
    assetFavorites: [],
  };

  const trashedAssets = () => assets.filter((asset) => changes.assetDeletions.includes(asset.id));

  test.beforeAll(async () => {
    utils.initSdk();
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    // beforeAll can run more than once in a worker (parallel mode); start from empty lists so the
    // assets are not listed twice
    assets.length = 0;
    yearMonths.length = 0;
    for (const timeBucket of timelineRestData.buckets.values()) {
      assets.push(...timeBucket);
    }
    for (const yearMonth of timelineRestData.buckets.keys()) {
      const [year, month] = yearMonth.split('-', 2);
      yearMonths.push(`${year}-${Number(month)}`);
    }
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
  });

  test.afterEach(() => {
    testContext.slowBucket = false;
    changes.albumAdditions = [];
    changes.assetDeletions = [];
    changes.assetArchivals = [];
    changes.assetFavorites = [];
  });

  test.describe('/photos/:id', () => {
    test('Navigate to next asset via button', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${asset.id}`);

      await page.getByLabel('View next asset').click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 1]);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${assets[index + 1].id}`);
    });

    test('Navigate to previous asset via button', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${asset.id}`);

      await page.getByLabel('View previous asset').click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index - 1]);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${assets[index - 1].id}`);
    });

    test('Navigate to next asset via keyboard (ArrowRight)', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${asset.id}`);

      await page.keyboard.press('ArrowRight');
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 1]);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${assets[index + 1].id}`);
    });

    test('Navigate to previous asset via keyboard (ArrowLeft)', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${asset.id}`);

      await page.keyboard.press('ArrowLeft');
      await assetViewerUtils.waitForViewerLoad(page, assets[index - 1]);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${assets[index - 1].id}`);
    });

    test('Navigate forward 5 times via button', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);

      for (let i = 1; i <= 5; i++) {
        await page.getByLabel('View next asset').click();
        await assetViewerUtils.waitForViewerLoad(page, assets[index + i]);
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${assets[index + i].id}`);
      }
    });

    test('Navigate backward 5 times via button', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);

      for (let i = 1; i <= 5; i++) {
        await page.getByLabel('View previous asset').click();
        await assetViewerUtils.waitForViewerLoad(page, assets[index - i]);
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${assets[index - i].id}`);
      }
    });

    test('Navigate forward then backward via keyboard', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);

      // Navigate forward 3 times
      for (let i = 1; i <= 3; i++) {
        await page.keyboard.press('ArrowRight');
        await assetViewerUtils.waitForViewerLoad(page, assets[index + i]);
      }

      // Navigate backward 3 times to return to original
      for (let i = 2; i >= 0; i--) {
        await page.keyboard.press('ArrowLeft');
        await assetViewerUtils.waitForViewerLoad(page, assets[index + i]);
      }

      // Verify we're back at the original asset
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${asset.id}`);
    });

    test('Verify no next button on last asset', async ({ page }) => {
      const lastAsset = assets.at(-1)!;
      await page.goto(`/photos/${lastAsset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, lastAsset);

      // Verify next button doesn't exist
      await expect(page.getByLabel('View next asset')).toHaveCount(0);
    });

    test('Verify no previous button on first asset', async ({ page }) => {
      const firstAsset = assets[0];
      await page.goto(`/photos/${firstAsset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, firstAsset);

      // Verify previous button doesn't exist
      await expect(page.getByLabel('View previous asset')).toHaveCount(0);
    });

    test('Delete photo advances to next', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page.getByLabel('Move to trash', { exact: true }).click();
      const index = assets.indexOf(asset);
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 1]);
    });
    test('Delete photo advances to next (2x)', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page.getByLabel('Move to trash', { exact: true }).click();
      const index = assets.indexOf(asset);
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 1]);
      await page.getByLabel('Move to trash', { exact: true }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 2]);
    });
    test('Delete last photo advances to prev', async ({ page }) => {
      const asset = assets.at(-1)!;
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page.getByLabel('Move to trash', { exact: true }).click();
      const index = assets.indexOf(asset);
      await assetViewerUtils.waitForViewerLoad(page, assets[index - 1]);
    });
    test('Delete last photo advances to prev (2x)', async ({ page }) => {
      const asset = assets.at(-1)!;
      await page.goto(`/photos/${asset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page.getByLabel('Move to trash', { exact: true }).click();
      const index = assets.indexOf(asset);
      await assetViewerUtils.waitForViewerLoad(page, assets[index - 1]);
      await page.getByLabel('Move to trash', { exact: true }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index - 2]);
    });
  });
  test.describe('Trash viewer', () => {
    // FL-71: Trash is a Command Center section; `?assetId=` opens the viewer over it (the old
    // `/trash/photos/:id` address redirects there). The section lists its items from the trash API
    // and the viewer's next/previous item is the section's neighbour of the open one. The trash
    // holds the assets each test moved there, in timeline order.
    test.beforeEach(async ({ context }) => {
      await setupTrashMockApiRoutes(context, trashedAssets, (ids) => {
        changes.assetDeletions = changes.assetDeletions.filter((id) => !ids.includes(id));
      });
    });
    test('Delete trashed photo advances to next', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      const deletedAssets = assets.slice(index - 10, index + 10).map((asset) => asset.id);
      changes.assetDeletions.push(...deletedAssets);
      await page.goto(trashViewer(asset.id));
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page
        .getByTestId('asset-viewer-navbar-actions')
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      // the viewer always confirms a permanent delete
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 1]);
    });
    test('Delete trashed photo advances to next 2x', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      const deletedAssets = assets.slice(index - 10, index + 10).map((asset) => asset.id);
      changes.assetDeletions.push(...deletedAssets);
      await page.goto(trashViewer(asset.id));
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page
        .getByTestId('asset-viewer-navbar-actions')
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      // the viewer always confirms a permanent delete
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 1]);
      await page
        .getByTestId('asset-viewer-navbar-actions')
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      // the viewer always confirms a permanent delete
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 2]);
    });
    test('Delete trashed photo advances to prev', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      const deletedAssets = assets.slice(index - 10, index + 10).map((asset) => asset.id);
      changes.assetDeletions.push(...deletedAssets);
      await page.goto(trashViewer(assets[index + 9].id));
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 9]);
      await page
        .getByTestId('asset-viewer-navbar-actions')
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      // the viewer always confirms a permanent delete
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 8]);
    });
    test('Delete trashed photo advances to prev 2x', async ({ page }) => {
      const asset = selectRandom(assets, rng);
      const index = assets.indexOf(asset);
      const deletedAssets = assets.slice(index - 10, index + 10).map((asset) => asset.id);
      changes.assetDeletions.push(...deletedAssets);
      await page.goto(trashViewer(assets[index + 9].id));
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 9]);
      await page
        .getByTestId('asset-viewer-navbar-actions')
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      // the viewer always confirms a permanent delete
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 8]);
      await page
        .getByTestId('asset-viewer-navbar-actions')
        .getByRole('button', { name: 'Delete permanently', exact: true })
        .click();
      // the viewer always confirms a permanent delete
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently' }).click();
      await assetViewerUtils.waitForViewerLoad(page, assets[index + 7]);
    });
  });
});
