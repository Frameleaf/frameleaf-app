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
    // "Send a copy…" depends on the browser's share sheet; take it away so the row is the same everywhere.
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        Reflect.deleteProperty(Navigator.prototype, 'share');
        Reflect.deleteProperty(Navigator.prototype, 'canShare');
      });
    });

    test('visible guest actions', async ({ page }) => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        showMetadata: false,
      });
      await page.goto(`/share/${sharedLink.key}/photos/${asset.id}`);
      await page.waitForSelector('#immich-asset-viewer');

      // FL-35: zoom moved to the footer, as in the template (MediaViewer.jsx:1765-1790). A link that hides
      // metadata never allows downloads (the server turns allowDownload off with it), so there is no
      // Download and no "Send a copy…" (FL-54 needs downloads and metadata).
      const expected = ['Copy Image'];
      const buttons = await page.getByTestId('asset-viewer-navbar-actions').getByRole('button').all();
      expect(buttons).toHaveLength(expected.length);

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

      // The owner may share, but the item the link serves is stripped of its owner, so the owner sees the
      // link's own rules: no Download on a link without metadata.
      const expected = ['Share', 'Copy Image'];
      const buttons = await page.getByTestId('asset-viewer-navbar-actions').getByRole('button').all();
      expect(buttons).toHaveLength(expected.length);

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

  // V-13: the footer carries the zoom, the position and the playback controls.
  test('the footer zooms the photo and returns to Fit', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    const footer = page.getByTestId('viewer-footer');
    await expect(footer).toBeVisible();
    await footer.getByRole('button', { name: 'Zoom in' }).click();
    await expect(footer.getByRole('button', { name: /% of fit$/ })).toBeVisible();
    await footer.getByRole('button', { name: /% of fit$/ }).click();
    await expect(footer.getByRole('button', { name: 'Fit', exact: true })).toBeVisible();
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
