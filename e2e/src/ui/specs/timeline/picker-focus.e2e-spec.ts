import { faker } from '@faker-js/faker';
import { expect, Page, test } from '@playwright/test';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network';
import { utils } from 'src/utils.js';
import { assetViewerUtils, pageUtils, selectionBarUtils, thumbnailUtils } from './utils';

const albumSearch = (page: Page) => page.getByRole('dialog').getByRole('searchbox');

/**
 * FL-1823: a picker opens with the cursor in its field, in a real browser, where opening a modal
 * dialog moves focus on its own and a closing menu hands focus back to its button.
 */
test.describe('Pickers open with the cursor in their field', () => {
  let adminUserId: string;
  let data: TimelineData;
  let first: TimelineAssetConfig;
  const testContext = new TimelineTestContext();
  const changes: Changes = { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] };

  test.beforeAll(() => {
    utils.initSdk();
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    data = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    const [newest] = data.buckets.values();
    first = newest[0];
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, data, changes, testContext);
  });

  const select = async (page: Page) => {
    await pageUtils.openPhotosPage(page);
    await thumbnailUtils.ensureSelected(page, first.id);
  };
  const openViewer = async (page: Page) => {
    await pageUtils.openPhotosPage(page);
    await thumbnailUtils.clickAssetId(page, first.id);
    await assetViewerUtils.waitForViewerLoad(page, first);
  };

  test('Add to album from the selection bar', async ({ page }) => {
    await select(page);
    await selectionBarUtils.action(page, 'Add to album').click();
    await expect(albumSearch(page)).toBeFocused();
  });

  test('Add to album from the viewer with L', async ({ page }) => {
    await openViewer(page);
    await page.keyboard.press('l');
    await expect(albumSearch(page)).toBeFocused();
    // The key that opened the picker is not typed into it.
    await expect(albumSearch(page)).toHaveValue('');
  });

  test('Add to album from the viewer menu', async ({ page }) => {
    await openViewer(page);
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Add to album' }).click();
    await expect(albumSearch(page)).toBeFocused();
  });

  test('Tag from the selection bar', async ({ page }) => {
    await select(page);
    await selectionBarUtils.menuAction(page, 'Tag');
    await expect(page.getByRole('dialog').getByRole('combobox')).toBeFocused();
  });

  test('Change description from the selection bar', async ({ page }) => {
    await select(page);
    await selectionBarUtils.menuAction(page, 'Change description');
    await expect(page.getByRole('dialog').getByRole('textbox')).toBeFocused();
  });
});
