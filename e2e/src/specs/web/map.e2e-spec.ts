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

  test('shows the offline state when the map style fails at startup, and recovers once it loads (FL-193)', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await utils.mockMapStyle(context, 500);
    await page.goto('/map');

    // The style request fails before the map ever finishes loading, so this only shows up if the
    // error handling is attached before that first load rather than inside its callback.
    await expect(page.getByRole('status').filter({ hasText: 'The map can’t load' })).toBeVisible();
    await expect(page.getByText('Your located items are still listed under In view.')).toBeVisible();
    // The located items stay reachable through the list; the failed tiles do not hide them.
    await expect(page.getByText('1 item in view')).toBeVisible();

    await context.unroute(/\/v1\/style\/(light|dark)\.json(\?.*)?$/);
    await utils.mockMapStyle(context);
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'The map can’t load' })).toHaveCount(0);
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

  test('names each item, counts photos and videos and shows the settings counts (FL-51)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/map');
    await expect(page.getByText('1 item in view')).toBeVisible();

    // MapView.jsx legend: photo and video counts for what is in view
    await expect(page.getByRole('group', { name: 'Legend' })).toContainText('1 photo · 0 videos');

    const tools = page.getByRole('toolbar', { name: 'Map tools' });
    await tools.getByRole('button', { name: 'Map settings' }).click();
    const sheet = page.getByRole('dialog', { name: 'Map settings' });
    await expect(sheet.getByText('No location')).toBeVisible();
    await page.keyboard.press('Escape');

    // "In view" rows carry the file name and the recorded day, and centre on the item by name
    await tools.getByRole('button', { name: 'Show list' }).click();
    const list = page.getByRole('complementary', { name: 'Items in view' });
    await expect(list.getByText('thompson-springs.jpg')).toBeVisible();
    await expect(list.getByRole('button', { name: 'Centre map on thompson-springs.jpg' })).toBeVisible();
  });

  test('Places groups by country and state with counts and opens the place search (FL-51)', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/places');

    await expect(page.getByRole('heading', { name: 'Places', level: 1 })).toBeVisible();
    await expect(page.getByText(/1 place · 1 item with a location/)).toBeVisible();
    const card = page.getByRole('link', { name: /, 1 item$/ }).first();
    await expect(card).toBeVisible();
    await expect(page.getByRole('link', { name: /^Show .+ on the map$/ }).first()).toHaveAttribute('href', /\/map#/);

    await page.getByRole('searchbox', { name: 'Find a place' }).fill('nowhere');
    await expect(page.getByText('No places match “nowhere”')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Find a place' }).fill('');

    await card.click();
    await page.waitForURL(/\/search\?query=/);
    await expect(page.locator(`[data-asset-id="${located.id}"]`)).toBeVisible();
  });

  test('the geolocation utility removes a location after review (FL-51)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/user-settings?area=utilities&section=geolocation');

    await page.getByRole('checkbox', { name: 'thompson-springs.jpg' }).check();
    await page.getByRole('button', { name: 'Remove location from 1 selected' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove location' });
    await dialog.getByRole('button', { name: /Apply/ }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto('/map');
    await expect(page.getByText('No located items match these settings')).toBeVisible();
  });
});
