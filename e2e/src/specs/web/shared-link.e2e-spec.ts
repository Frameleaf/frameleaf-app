import {
  AlbumResponseDto,
  AssetMediaResponseDto,
  LoginResponseDto,
  SharedLinkResponseDto,
  SharedLinkType,
  createAlbum,
  removeSharedLink,
} from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/** A fresh album link and a way to revoke it from the owner's side while a viewer has it open. */
const revokeLater = async (accessToken: string, albumId: string) => {
  const link = await utils.createSharedLink(accessToken, { type: SharedLinkType.Album, albumId });
  const revoke = () => removeSharedLink({ id: link.id }, { headers: asBearerAuth(accessToken) });
  return { link, revoke };
};

const unlock = async (page: Page) => {
  await page.getByPlaceholder('Password').fill('test-password');
  await page.getByRole('button', { name: 'Continue' }).click();
};

test.describe('Shared Links', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;
  let asset2: AssetMediaResponseDto;
  let album: AlbumResponseDto;
  let sharedLink: SharedLinkResponseDto;
  let sharedLinkPassword: SharedLinkResponseDto;
  let individualSharedLink: SharedLinkResponseDto;
  let viewOnlySharedLink: SharedLinkResponseDto;

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
    viewOnlySharedLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Album,
      albumId: album.id,
      allowDownload: false,
      allowUpload: true,
    });
  });

  test('download from a shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await page.locator(`[data-asset-id="${asset.id}"]`).hover();
    await page.locator(`[data-asset-id="${asset.id}"]`).getByRole('checkbox').click();
    // PublicViewer.jsx: a selection turns the header's download into "Download selected (n)".
    await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download selected (1)' }).click(),
    ]);
  });

  test('download all from shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download all' }).click()]);
  });

  test('select mode picks items with a plain click', async ({ page }) => {
    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await expect(page.getByText('1 item', { exact: false }).first()).toBeVisible();

    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const selection = page.getByRole('toolbar', { name: 'Selection' });
    await expect(selection).toContainText('0 of 1 selected');
    await expect(page.getByRole('button', { name: 'Download selected (0)' })).toBeDisabled();

    await page.locator(`[data-asset-id="${asset.id}"]`).click();
    await expect(selection).toContainText('1 of 1 selected');
    await expect(page.getByRole('button', { name: 'Download selected (1)' })).toBeEnabled();
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(selection).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Download all' })).toBeVisible();
  });

  test('a plain click opens an item in the viewer', async ({ page }) => {
    // PublicViewer.jsx: outside Select mode a tile opens the viewer.
    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();

    await page.locator(`[data-asset-id="${asset.id}"]`).click();

    await expect(page.locator('#immich-asset-viewer')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/share/${sharedLink.key}/photos/${asset.id}`);
  });

  test('offers only what the link allows', async ({ page }) => {
    await page.goto(`/share/${viewOnlySharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Download/ })).toHaveCount(0);

    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
    await expect(page.getByRole('button', { name: 'Download all' })).toBeVisible();
  });

  test('enter password for a shared link', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    await page.getByPlaceholder('Password').fill('test-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();
  });

  test('a wrong password is reported inline, not as a toast', async ({ page }) => {
    await page.goto(`/share/${sharedLinkPassword.key}`);
    const input = page.getByPlaceholder('Password');
    await input.fill('wrong-password');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'That password does not match. Check with the person who shared the link.',
    );
    await expect(input).toHaveAttribute('aria-invalid', 'true');
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

  test('an expired link says it expired, without naming anyone', async ({ page }) => {
    const expiredLink = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Album,
      albumId: album.id,
    });
    const client = await utils.connectDatabase();
    await client.query(`UPDATE shared_link SET "expiresAt" = now() - interval '1 day' WHERE id = $1`, [expiredLink.id]);

    await page.goto(`/share/${expiredLink.key}`);
    await page.getByRole('heading', { name: 'This link has expired' }).waitFor();
    await expect(
      page.getByText('Ask the person who shared it for a new link if you still need these photos.'),
    ).toBeVisible();
    await expect(page.getByText('Immich Admin')).toHaveCount(0);
  });

  // FL-56: revoking a link takes effect on the viewer's next action, not only on a reload.
  test.describe('a link revoked while its viewer is open', () => {
    test('opening an item shows the unavailable state', async ({ page }) => {
      const { link, revoke } = await revokeLater(admin.accessToken, album.id);
      await page.goto(`/share/${link.key}`);
      await page.getByRole('heading', { name: 'Test Album' }).waitFor();
      // Revoke once the grid has loaded: a request still in flight would find the revocation first.
      await page.locator(`[data-asset-id="${asset.id}"] img`).waitFor();

      await revoke();
      await page.locator(`[data-asset-id="${asset.id}"]`).click();

      await page.getByRole('heading', { name: 'This link is not available' }).waitFor();
      await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    });

    test('downloading shows the unavailable state instead of a server error', async ({ page }) => {
      const { link, revoke } = await revokeLater(admin.accessToken, album.id);
      await page.goto(`/share/${link.key}`);
      await page.getByRole('heading', { name: 'Test Album' }).waitFor();
      // Revoke once the grid has loaded: a request still in flight would find the revocation first.
      await page.locator(`[data-asset-id="${asset.id}"] img`).waitFor();

      await revoke();
      await page.getByRole('button', { name: 'Download all' }).click();

      await page.getByRole('heading', { name: 'This link is not available' }).waitFor();
      await expect(page.getByText('(Frameleaf Server Error)')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Test Album' })).toHaveCount(0);
    });
  });

  // FL-56: the password gate only ever continues to the share it guards.
  test.describe('crafted continuation URLs on the password gate', () => {
    let privateAsset: AssetMediaResponseDto;
    let slugLink: SharedLinkResponseDto;

    test.beforeAll(async () => {
      // An item of the same owner that no link shares.
      privateAsset = await utils.createAsset(admin.accessToken);
      slugLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Album,
        albumId: album.id,
        password: 'test-password',
        slug: 'fl56-guarded',
      });
    });

    for (const [name, gate] of [
      ['/share/{key}', () => `/share/${sharedLinkPassword.key}`],
      ['/s/{slug}', () => `/s/${slugLink.slug}`],
    ] as const) {
      test(`${name}: continuation parameters never leave the share`, async ({ page }) => {
        await page.goto(`${gate()}?continue=%2Fadmin%2Fusers&redirect=%2Fphotos&returnTo=%2F%2Fexample.com`);
        await unlock(page);

        await page.getByRole('heading', { name: 'Test Album' }).waitFor();
        expect(new URL(page.url()).pathname).toBe(gate());
        // Still the public frame, with no private navigation.
        await expect(page.getByRole('link', { name: 'Go to Frameleaf' })).toBeVisible();
      });

      test(`${name}: an item path outside the share never opens it`, async ({ page }) => {
        await page.goto(`${gate()}/photos/${privateAsset.id}`);
        // Either the gate is asked first or the item is refused outright; the private item never shows.
        const password = page.getByPlaceholder('Password');
        await password
          .or(page.getByRole('heading', { name: 'This link is not available' }))
          .first()
          .waitFor();
        if (await password.isVisible()) {
          await unlock(page);
        }

        await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
        await expect(page.locator(`[data-asset-id="${privateAsset.id}"]`)).toHaveCount(0);
        expect(new URL(page.url()).pathname.startsWith(gate())).toBe(true);
      });

      test(`${name}: an encoded path cannot climb out of the share`, async ({ page }) => {
        await page.goto(`${gate()}%2F..%2F..%2Fadmin`);

        await expect(page.getByRole('heading', { name: 'This link is not available' })).toBeVisible();
        expect(new URL(page.url()).pathname.startsWith('/admin')).toBe(false);
      });
    }
  });

  test('show error for invalid shared link', async ({ page }) => {
    await page.goto('/share/invalid');
    await page.getByRole('heading', { name: 'This link is not available' }).waitFor();
    await expect(page.getByText('It may have been removed, or the address is incomplete.')).toBeVisible();
  });

  test('auth on navigation from shared link to timeline', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(`/share/${sharedLink.key}`);
    await page.getByRole('heading', { name: 'Test Album' }).waitFor();

    await page.getByRole('link', { name: 'Go to Frameleaf' }).click();
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

  test('the old edit address opens the list with the Frameleaf edit form (AL-23)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(`/shared-links/${sharedLink.id}/edit`);
    await page.waitForURL(/\/shared-links(?:\?|$)/);
    await expect(page.getByRole('dialog', { name: 'Edit shared link' })).toBeVisible();
    expect(new URL(page.url()).searchParams.has('edit')).toBe(false);
  });
});
