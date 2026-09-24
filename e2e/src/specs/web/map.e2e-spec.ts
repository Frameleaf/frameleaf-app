import { AssetMediaResponseDto, LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { testAssetDir, utils } from 'src/utils.js';

test.describe('Map', () => {
  let admin: LoginResponseDto;
  let located: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    located = await utils.createAsset(admin.accessToken, {
      assetData: {
        bytes: readFileSync(`${testAssetDir}/metadata/gps-position/thompson-springs.jpg`),
        filename: 'thompson-springs.jpg',
      },
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
  });

  test('counts located items and applies the settings sheet', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/map');

    // MapView.jsx: the in-view chip, the tools column and the settings sheet.
    await expect(page.getByText('1 item in view')).toBeVisible();
    const tools = page.getByRole('toolbar', { name: 'Map tools' });
    await expect(tools.getByRole('button', { name: 'Zoom in' })).toBeVisible();

    await tools.getByRole('button', { name: 'Map settings' }).click();
    const sheet = page.getByRole('dialog', { name: 'Map settings' });
    await expect(sheet.getByRole('radio', { name: 'All time' })).toHaveAttribute('aria-checked', 'true');
    await sheet.getByRole('switch', { name: 'Only favorites' }).click();
    await expect(page.getByText('No located items match these settings')).toBeVisible();
    await sheet.getByRole('switch', { name: 'Only favorites' }).click();
    await expect(page.getByText('1 item in view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await tools.getByRole('button', { name: 'Show list' }).click();
    const list = page.getByRole('complementary', { name: 'Items in view' });
    await expect(list.getByRole('button', { name: /^Centre map on/ })).toHaveCount(1);
  });

  test('searches the visible area in the Library', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/map');
    await expect(page.getByText('1 item in view')).toBeVisible();

    // "Search this area" appears once the view has been moved.
    await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Search this area' }).click();

    await page.waitForURL(/\/photos\?area=/);
    await expect(page.getByRole('heading', { name: 'Map area' })).toBeVisible();
    await expect(page.locator(`[data-asset-id="${located.id}"]`)).toBeVisible();
    await page.getByRole('button', { name: 'Clear map area' }).click();
    await page.waitForURL(/\/photos$/);
  });
});
