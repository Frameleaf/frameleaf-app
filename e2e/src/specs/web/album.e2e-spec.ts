import { LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { testAssetDir, utils } from 'src/utils.js';

test.describe('Album', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('sends Select from library to the Library and keeps the new album', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    // Albums page -> Create album opens the create dialog (Collections.jsx), then the new album.
    await page.goto('/albums');
    await page.getByRole('button', { name: 'Create album' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Weekend trip');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/albums\/[\da-f-]{36}/);

    // CollectionHeader.jsx: Add photos -> Select from library / Upload from computer.
    await page.getByRole('button', { name: 'Add photos' }).click();
    await expect(page.getByRole('menuitem', { name: 'Upload from computer' })).toBeVisible();
    const albumUrl = page.url();
    await page.getByRole('menuitem', { name: 'Select from library' }).click();

    // App.jsx onAddPhotos: the Library is where photos are picked, with a hint toast pointing at the
    // selection bar's "Add to album".
    await page.waitForURL(/\/photos/);
    await expect(page.getByText('Select photos, then choose Add to album in the selection bar.')).toBeVisible();

    await page.goto(albumUrl);
    await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
  });

  test('opens the Map screen scoped to the album and returns to it from the viewer', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    const imagePath = `${testAssetDir}/metadata/gps-position/thompson-springs.jpg`;
    const mapAsset = await utils.createAsset(admin.accessToken, {
      assetData: {
        bytes: readFileSync(imagePath),
        filename: 'thompson-springs.jpg',
      },
    });

    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

    const mapAlbum = await utils.createAlbum(admin.accessToken, {
      albumName: 'Map Test Album',
      assetIds: [mapAsset.id],
    });

    // App.jsx onOpenMap: the album's Map action opens the Map screen with the album's scope.
    await page.goto(`/albums/${mapAlbum.id}`);
    const mapButton = page.getByRole('button', { name: 'Map' });
    await expect(mapButton).toBeEnabled();
    await mapButton.click();
    await page.waitForURL(`/map?albumId=${mapAlbum.id}`);

    const mapMarker = page.getByRole('img', { name: /^Open item/ }).first();
    await expect(mapMarker).toBeVisible();
    await mapMarker.click();

    const viewer = page.locator('#immich-asset-viewer');
    await expect(viewer).toHaveAttribute('data-asset-id', mapAsset.id);
    await page.keyboard.press('Escape');

    await expect(viewer).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(String.raw`/map\?albumId=${mapAlbum.id}`));
    await expect(mapMarker).toBeVisible();
  });
});
