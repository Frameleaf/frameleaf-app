import {
  AlbumResponseDto,
  AssetMediaResponseDto,
  LoginResponseDto,
  SharedLinkResponseDto,
  SharedLinkType,
  createAlbum,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

test.describe('Shared Links', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;
  let asset2: AssetMediaResponseDto;
  let album: AlbumResponseDto;
  let sharedLink: SharedLinkResponseDto;
  let sharedLinkPassword: SharedLinkResponseDto;
  let individualSharedLink: SharedLinkResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
    asset2 = await utils.createAsset(admin.accessToken);
    album = await createAlbum(
      {
        createAlbumDto: {
          albumName: 'Test Album',
          assetIds: [asset.id],
        },
      },
      { headers: asBearerAuth(admin.accessToken) },
    );
    sharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Album,
      albumId: album.id,
    });
    sharedLinkPassword = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Album,
      albumId: album.id,
      password: 'test-password',
    });
    individualSharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [asset.id, asset2.id],
    });
  });

  test('download from a shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await page.locator(`[data-asset-id="${asset.id}"]`).hover();
    await page.locator(`[data-asset-id="${asset.id}"]`).getByRole('checkbox').waitFor();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  });

  test('download all from shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()]);
  });

  test('enter password for a shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    await page.getByPlaceholder('Password').fill('test-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
  });

  test('show-password button visible', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    await page.getByPlaceholder('Password').fill('test-password');
    await page.getByRole('button', { name: 'Show password' }).waitFor();
  });

  test('view password for shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    const input = page.getByPlaceholder('Password');
    await input.fill('test-password');
    await page.getByRole('button', { name: 'Show password' }).click();
    // await page.getByText('test-password', { exact: true }).waitFor();
    await expect(input).toHaveAttribute('type', 'text');
  });

  test('hide-password button visible', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    const input = page.getByPlaceholder('Password');
    await input.fill('test-password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await page.getByRole('button', { name: 'Hide password' }).waitFor();
  });

  test('hide password for shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    const input = page.getByPlaceholder('Password');
    await input.fill('test-password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(input).toHaveAttribute('type', 'password');
  });

  test('show error for invalid shared link', async ({ page }) => {
    await page.goto('/share/invalid');
    await page.getByRole('heading', { name: 'This link is not available' }).waitFor();
  });

  test('auth on navigation from shared link to timeline', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();

    await page.locator('a[href="/"]').click();
    await page.waitForURL('/photos');
    await page.locator(`[data-asset-id="${asset.id}"]`).waitFor();
  });

  test('owner can remove assets from an individual shared link', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(`/share/${individualSharedLink.key}`);
    await page.locator(`[data-asset-id="${asset.id}"]`).waitFor();
    await expect(page.locator(`[data-asset-id]`)).toHaveCount(2);

    await page.locator(`[data-asset-id="${asset.id}"]`).hover();
    await page.locator(`[data-asset-id="${asset.id}"]`).getByRole('checkbox').click();

    // The floating selection bar (SelectionBar.jsx) keeps the less common actions under More.
    const selectionBar = page.getByRole('region', { name: 'Selected items' });
    await selectionBar.getByRole('button', { name: 'More' }).click();
    // Pruning a link is immediate and reported in the bar, like every other bulk action.
    await page.getByRole('menuitem', { name: 'Remove from shared link' }).click();

    await expect(page.locator(`[data-asset-id="${asset.id}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-asset-id="${asset2.id}"]`)).toHaveCount(1);
  });
});
