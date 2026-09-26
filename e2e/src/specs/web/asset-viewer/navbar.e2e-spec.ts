import {
  AssetMediaResponseDto,
  deleteAssets,
  getAssetInfo,
  LoginResponseDto,
  SharedLinkType,
  updateMyPreferences,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

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
      const expected = ['Copy image'];
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
      const expected = ['Share', 'Copy image'];
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

  // FL-35 / FL-36: the September 24 viewer conformance (V-3, V-4, V-7) and removals elsewhere.
  test.describe('September 24 conformance', () => {
    test('rates from the top row', async ({ context, page }) => {
      await updateMyPreferences(
        { userPreferencesUpdateDto: { ratings: { enabled: true } } },
        { headers: asBearerAuth(admin.accessToken) },
      );
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      await page.getByTestId('viewer-rating-button').click();
      await page.getByRole('group', { name: 'Rate this item' }).getByRole('button', { name: 'Rate 4 stars' }).click();
      await expect
        .poll(async () => {
          const info = await getAssetInfo({ id: asset.id }, { headers: asBearerAuth(admin.accessToken) });
          return info.exifInfo?.rating;
        })
        .toBe(4);
      await expect(page.getByTestId('viewer-rating-button')).toHaveAccessibleName('Rating · 4 stars');
    });

    test('offers Restore and Delete permanently for a trashed item', async ({ context, page }) => {
      await deleteAssets({ assetBulkDeleteDto: { ids: [asset.id] } }, { headers: asBearerAuth(admin.accessToken) });
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/user-settings?area=trash&section=contents&assetId=${asset.id}`);
      const toolbar = page.getByTestId('asset-viewer-navbar-actions');
      await expect(toolbar.getByRole('button', { name: 'Delete permanently', exact: true })).toBeVisible();
      await expect(toolbar.getByRole('button', { name: 'Move to trash', exact: true })).toHaveCount(0);

      await toolbar.getByRole('button', { name: 'Restore', exact: true }).click();
      await expect
        .poll(async () => {
          const info = await getAssetInfo({ id: asset.id }, { headers: asBearerAuth(admin.accessToken) });
          return info.isTrashed;
        })
        .toBe(false);
    });

    test('opens the slideshow settings from the More menu', async ({ context, page }) => {
      await utils.createAsset(admin.accessToken);
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${asset.id}`);
      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Slideshow settings' }).click();
      await expect(page.getByTestId('slideshow-settings')).toBeVisible();
    });

    test('moves on when the open item is moved to the trash elsewhere during a slideshow', async ({
      context,
      page,
    }) => {
      const other = await utils.createAsset(admin.accessToken);
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto(`/photos/${other.id}`);
      await page.waitForSelector('#immich-asset-viewer');
      await page.getByTestId('viewer-footer').getByRole('button', { name: 'Play slideshow' }).click();
      await page.getByTestId('viewer-footer').getByRole('button', { name: 'Pause slideshow' }).click();
      const open = await page.locator('#immich-asset-viewer').getAttribute('data-asset-id');

      await deleteAssets({ assetBulkDeleteDto: { ids: [open!] } }, { headers: asBearerAuth(admin.accessToken) });
      await expect(page.locator('#immich-asset-viewer')).not.toHaveAttribute('data-asset-id', open!);
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
