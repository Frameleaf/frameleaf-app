import { AssetMediaResponseDto, LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

test.describe('Asset Viewer Navbar', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test.beforeEach(async () => {
    asset = await utils.createAsset(admin.accessToken);
  });

  test.describe('shared link without metadata', () => {
    test('visible guest actions', async ({ page }) => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: false,
      });
      await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      // FL-35: the template's row has no zoom buttons (audit V-6); zoom stays on double-click, pinch and keys.
      const expected = ['Copy Image', 'Download'];
      const buttons = await page.getByTestId('asset-viewer-navbar-actions').getByRole('button').all();

      for (const [i, button] of buttons.entries()) {
        await expect(button).toHaveAccessibleName(expected[i]);
      }
    });

    test('visible owner actions', async ({ context, page }) => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: false,
      });
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      const expected = ['Share', 'Copy Image', 'Download'];
      const buttons = await page.getByTestId('asset-viewer-navbar-actions').getByRole('button').all();

      for (const [i, button] of buttons.entries()) {
        await expect(button).toHaveAccessibleName(expected[i]);
      }
    });
  });

  // FL-35 hands-on viewer: a tap hides the frosted chrome, a downward swipe at normal zoom closes.
  test.describe('hands-on viewer', () => {
    test('a tap on the photo hides and shows the chrome', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      const viewer = page.locator('#immich-asset-viewer');
      await expect(viewer).toBeVisible();
      const canvas = viewer.locator('[data-viewer-content]');
      const box = (await canvas.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(viewer).toHaveClass(/chrome-hidden/);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(viewer).not.toHaveClass(/chrome-hidden/);
    });

    test('a downward drag closes the viewer', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      const viewer = page.locator('#immich-asset-viewer');
      await expect(viewer).toBeVisible();
      const box = (await viewer.locator('[data-viewer-content]').boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 3;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 80, { steps: 4 });
      await page.mouse.move(x, y + 200, { steps: 4 });
      await page.mouse.up();
      await expect(viewer).toHaveCount(0);
      await expect(page).toHaveURL(/\/photos(\?.*)?$/);
    });
  });

  test.describe('actions', () => {
    test('favorite asset with shortcut', async ({ context, page }) => {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.keyboard.press('f');
      await expect(page.getByText('Added to favorites')).toBeVisible();
    });
  });
});
