import { expect, test } from '@playwright/test';
import { toAssetResponseDto } from 'src/ui/generators/timeline.js';
import {
  createMockStack,
  createMockStackAsset,
  MockStack,
  setupBrokenAssetMockApiRoutes,
} from 'src/ui/mock-network/broken-asset-network';
import { assetViewerUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

test.describe.configure({ mode: 'parallel' });
test.describe('broken-asset responsiveness', () => {
  const fixture = setupAssetViewerFixture(889);
  let mockStack: MockStack;

  test.beforeAll(async () => {
    const primaryAssetDto = toAssetResponseDto(fixture.primaryAsset);

    const brokenAssets = [
      createMockStackAsset(fixture.adminUserId),
      createMockStackAsset(fixture.adminUserId),
      createMockStackAsset(fixture.adminUserId),
    ];

    mockStack = createMockStack(primaryAssetDto, brokenAssets);
  });

  test.beforeEach(async ({ context }) => {
    await setupBrokenAssetMockApiRoutes(context, mockStack);
  });

  test('broken asset in stack strip hides icon at small size', async ({ page }) => {
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);

    const stackSlideshow = page.locator('#stack-slideshow');
    await expect(stackSlideshow).toBeVisible();

    const brokenAssets = stackSlideshow.locator('[data-broken-asset]');
    await expect(brokenAssets.first()).toBeVisible();
    await expect(brokenAssets).toHaveCount(mockStack.brokenAssetIds.size);

    for (const brokenAsset of await brokenAssets.all()) {
      await expect(brokenAsset.locator('svg')).not.toBeVisible();
    }
  });

  test('broken asset in stack strip hides its message', async ({ page }) => {
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);

    const stackSlideshow = page.locator('#stack-slideshow');
    await expect(stackSlideshow).toBeVisible();

    const brokenAssets = stackSlideshow.locator('[data-broken-asset]');
    await expect(brokenAssets.first()).toBeVisible();

    for (const brokenAsset of await brokenAssets.all()) {
      // The words show only where the whole line fits (160px and up); a strip thumbnail keeps the fill.
      await expect(brokenAsset.locator('span')).toBeHidden();
    }
  });

  test('broken asset in main viewer shows icon and message', async ({ context, page }) => {
    await context.route(
      (url) =>
        url.pathname.includes(`/api/assets/${fixture.primaryAsset.id}/thumbnail`) ||
        url.pathname.includes(`/api/assets/${fixture.primaryAsset.id}/original`),
      async (route) => {
        return route.fulfill({ status: 404 });
      },
    );

    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await page.waitForSelector('#immich-asset-viewer');

    const viewerBrokenAsset = page.locator('[data-viewer-content] [data-broken-asset]').first();
    await expect(viewerBrokenAsset).toBeVisible();

    await expect(viewerBrokenAsset.locator('svg')).toBeVisible();

    await expect(viewerBrokenAsset.locator('span')).toBeVisible();
  });
});
