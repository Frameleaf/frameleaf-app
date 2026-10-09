import { AssetMediaResponseDto, LoginResponseDto } from '@frameleaf/sdk';
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

  // FC-69: the Frameleaf tile host is stood in for, so no case reaches tiles.frameleaf.cloud.
  test.beforeEach(async ({ context }) => {
    await utils.mockTileHost(context);
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

  test('opens an item from the list, closes back to the same map, and returns from the area search (FL-51)', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/map');
    await expect(page.getByText('1 item in view')).toBeVisible();

    const tools = page.getByRole('toolbar', { name: 'Map tools' });
    await tools.getByRole('button', { name: 'Show list' }).click();
    const list = page.getByRole('complementary', { name: 'Items in view' });
    await list.getByRole('button', { name: /^thompson-springs\.jpg/ }).click();
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(page).toHaveURL(/\/map/);
    await expect(page.getByText('1 item in view')).toBeVisible();
    await expect(list.getByRole('button', { name: /^thompson-springs\.jpg/ })).toBeVisible();

    // Back from the Library's map area lands on the same map position (the address keeps it).
    await expect(page).toHaveURL(/\/map#[\d.-]+\/[\d.-]+\/[\d.-]+/);
    const zoomBefore = Number(new URL(page.url()).hash.slice(1).split('/', 1)[0]);
    await tools.getByRole('button', { name: 'Zoom out' }).click();
    // The hash changes on moveend; its old value is still valid during the zoom animation.
    await expect.poll(() => Number(new URL(page.url()).hash.slice(1).split('/', 1)[0])).toBe(zoomBefore - 0.5);
    const position = new URL(page.url()).hash;
    await page.getByRole('button', { name: 'Search this area' }).click();
    await page.waitForURL(/\/photos\?area=/);
    await page.goBack();
    await page.waitForURL(/\/map/);
    expect(new URL(page.url()).hash).toBe(position);
    await expect(page.getByText('1 item in view')).toBeVisible();
  });

  test('rapid panning and zooming keep the in-view count in step, and Show all items recovers (FL-51)', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/map');
    await expect(page.getByText('1 item in view')).toBeVisible();

    const canvas = page.locator('.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    const tools = page.getByRole('toolbar', { name: 'Map tools' });
    for (let index = 0; index < 4; index++) {
      await tools.getByRole('button', { name: 'Zoom in' }).click();
    }
    for (let index = 0; index < 6; index++) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + (index % 2 === 0 ? 300 : -120), y + 90, { steps: 2 });
      await page.mouse.up();
    }
    await expect(page.getByText(/\d+ items? in view/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search this area' })).toBeVisible();

    await tools.getByRole('button', { name: 'Show all items' }).click();
    // "Show all items" flies to the items, which can take a while across the map
    await expect(page.getByText('1 item in view')).toBeVisible({ timeout: 20_000 });

    // Home on the focused map fits every located item too (MapView.jsx keyboard help).
    await canvas.focus();
    for (let index = 0; index < 8; index++) {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Home');
    await expect(page.getByText('1 item in view')).toBeVisible({ timeout: 20_000 });
  });

  test('an empty part of the map lists nothing and says how to get back (FL-51)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    // A link to a position is honoured instead of fitting the located items.
    await page.goto('/map#8/-60/-150');
    await expect(page.getByText('0 items in view')).toBeVisible();
    await expect(page.getByText('· 1 located')).toBeVisible();

    await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Show list' }).click();
    const list = page.getByRole('complementary', { name: 'Items in view' });
    await expect(list.getByRole('status')).toHaveText(
      'Nothing in this part of the map. Zoom out or choose Show all items.',
    );

    await page.getByRole('toolbar', { name: 'Map tools' }).getByRole('button', { name: 'Show all items' }).click();
    // a flight across half the world
    await expect(page.getByText('1 item in view')).toBeVisible({ timeout: 20_000 });
    await expect(list.getByRole('button', { name: /^thompson-springs\.jpg/ })).toBeVisible();
  });

  test('on a phone the located items stay reachable through the list when tiles fail (FL-51)', async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await utils.setAuthCookies(context, admin.accessToken);
    await utils.mockMapStyle(context, 500);
    await page.goto('/map');

    const offline = page.getByRole('status').filter({ hasText: 'The map can’t load' });
    await expect(offline).toBeVisible();
    await offline.getByRole('button', { name: 'Show list' }).click();

    const list = page.getByRole('complementary', { name: 'Items in view' });
    const row = list.getByRole('button', { name: /^thompson-springs\.jpg/ });
    await expect(row).toBeVisible();
    await expect(row).toBeInViewport();
    const listBox = (await list.boundingBox())!;
    expect(listBox.x).toBeGreaterThanOrEqual(0);
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(375);

    await row.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();
  });

  test('the geolocation utility removes a location after review (FL-51)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/user-settings?area=utilities&section=geolocation');

    await page.getByRole('checkbox', { name: 'thompson-springs.jpg' }).check();
    await page.getByRole('button', { name: 'Remove location from 1 selected' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove location' });
    await dialog.getByRole('button', { name: /Confirm 1 item/ }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto('/map');
    await expect(page.getByText('No located items match these settings')).toBeVisible();
  });
});
