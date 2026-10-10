import { LoginResponseDto, createAlbum, getAlbumInfo, getAssetStatistics } from '@frameleaf/sdk';
import { expect, test, type Page } from '@playwright/test';
import { makeRandomImage } from 'src/generators.js';
import { asBearerAuth, utils } from 'src/utils.js';

const png = (name: string) => ({ name, mimeType: 'image/png', buffer: makeRandomImage() });

/** The top bar's Upload menu, then a file chooser answered with `files`. */
const uploadFromTopBar = async (page: Page, files: ReturnType<typeof png>[], album?: string) => {
  await page.locator('button[aria-haspopup="menu"][aria-label="Upload"]').click();
  if (album) {
    await page.getByLabel('Add to').selectOption({ label: album });
  }
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: /Upload files/ }).click(),
  ]);
  await chooser.setFiles(files);
};

const albumCount = async (accessToken: string, id: string) => {
  const album = await getAlbumInfo({ id }, { headers: asBearerAuth(accessToken) });
  return album.assetCount;
};

const assetCount = async (accessToken: string) => {
  const { total } = await getAssetStatistics({}, { headers: asBearerAuth(accessToken) });
  return total;
};

/**
 * FL-45: uploads and downloads in the Frameleaf shell, against the real server. The panels read the
 * production upload and download managers, so these drive the real requests end to end.
 */
test.describe('Transfers', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('uploads from the top bar into the chosen album and marks a repeat as a duplicate', async ({
    context,
    page,
  }) => {
    const album = await createAlbum(
      { createAlbumDto: { albumName: 'Upload target' } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    const file = png('first.png');

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await uploadFromTopBar(page, [file], 'Upload target');

    const panel = page.getByRole('region', { name: 'Uploads' });
    await expect(panel.getByText('Upload complete')).toBeVisible();
    await expect.poll(() => albumCount(admin.accessToken, album.id)).toBe(1);

    const before = await assetCount(admin.accessToken);
    await uploadFromTopBar(page, [file]);
    await expect(panel.getByText('Already in your library', { exact: true })).toBeAttached();
    await expect(panel.getByText(/1 duplicate/)).toBeVisible();
    expect(await assetCount(admin.accessToken)).toBe(before);
  });

  test('keeps uploading across pages, cancels what remains and retries it', async ({ context, page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === '/api/assets',
      async (route) => {
        if (route.request().method() !== 'POST') {
          return route.fallback();
        }
        await held;
        try {
          await route.continue();
        } catch {
          // The browser already aborted this request (Cancel remaining).
        }
      },
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    const before = await assetCount(admin.accessToken);
    // A full page load would drop this marker; a client-side navigation keeps it.
    await page.evaluate(() => (document.documentElement.dataset.flMarker = 'kept'));

    await uploadFromTopBar(page, [png('one.png'), png('two.png'), png('three.png')]);
    const panel = page.getByRole('region', { name: 'Uploads' });
    await expect(panel.getByText('Uploading 1 of 3')).toBeVisible();

    await page.getByRole('link', { name: 'Favorites', exact: true }).first().click();
    await expect(page).toHaveURL(/\/favorites/);
    await expect(page.locator('html')).toHaveAttribute('data-fl-marker', 'kept');
    await expect(panel.getByText('Uploading 1 of 3')).toBeVisible();

    await panel.getByRole('button', { name: 'Cancel remaining' }).click();
    await expect(panel.getByText('3 uploads need attention')).toBeVisible();
    await expect(panel.getByText('Cancelled')).toHaveCount(3);
    expect(await assetCount(admin.accessToken)).toBe(before);

    await page.unroute((url) => url.pathname === '/api/assets');
    release();
    await panel.getByRole('button', { name: 'Retry failed' }).click();
    await expect(panel.getByText('Upload complete')).toBeVisible();
    await expect.poll(() => assetCount(admin.accessToken)).toBe(before + 3);
  });

  test('uploads files dropped on an album page into that album', async ({ context, page }) => {
    const album = await createAlbum(
      { createAlbumDto: { albumName: 'Drop target' } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    const file = png('dropped.png');

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/albums/${album.id}`);
    await expect(page.getByText('No photos or videos in this view.')).toBeVisible();

    const dataTransfer = await page.evaluateHandle(
      ({ name, bytes }) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'image/png' }));
        return transfer;
      },
      { name: file.name, bytes: [...file.buffer] },
    );

    await page.dispatchEvent('body', 'dragenter', { dataTransfer });
    const dropOverlay = page.getByRole('status').filter({ hasText: 'Drop to add to Drop target' });
    await expect(dropOverlay).toBeVisible();
    await expect(dropOverlay).toContainText('They are added to your library and to this album');
    const uploaded = page.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assets',
    );
    await page.dispatchEvent('body', 'drop', { dataTransfer });
    await expect(dropOverlay).toBeHidden();
    const uploadResponse = await uploaded;
    expect(uploadResponse.ok()).toBe(true);
    const { id: uploadedId } = await uploadResponse.json();
    expect(uploadedId).toEqual(expect.any(String));

    await expect(page.getByRole('region', { name: 'Uploads' }).getByText('Upload complete')).toBeVisible();
    await expect.poll(() => albumCount(admin.accessToken, album.id)).toBe(1);
    await expect
      .poll(async () => {
        const result = await utils.searchAssets(admin.accessToken, { albumIds: [album.id], id: uploadedId });
        return result.assets.items.map((asset) => asset.id);
      })
      .toEqual([uploadedId]);
  });

  test('downloads a selection as one archive per part of the size limit', async ({ context, page }) => {
    const [first, second] = await Promise.all([
      utils.createAsset(admin.accessToken),
      utils.createAsset(admin.accessToken),
    ]);
    await utils.updateMyPreferences(admin.accessToken, { download: { archiveSize: 1 } });

    try {
      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/photos');
      for (const id of [first.id, second.id]) {
        const tile = page.locator(`[data-asset-id="${id}"]`);
        await tile.hover();
        await tile.getByRole('checkbox').click();
      }
      await page
        .getByRole('region', { name: 'Selected items' })
        .getByRole('button', { name: 'Download', exact: true })
        .click();

      const panel = page.getByRole('region', { name: 'Downloads' });
      await expect(panel.getByText('2 downloads ready')).toBeVisible();
      const saves = panel.getByRole('button', { name: 'Save' });
      await expect(saves).toHaveCount(2);

      const names: string[] = [];
      for (let part = 0; part < 2; part++) {
        const [download] = await Promise.all([page.waitForEvent('download'), saves.first().click()]);
        names.push(download.suggestedFilename());
      }
      expect(names.toSorted((a, b) => a.localeCompare(b))).toEqual([
        expect.stringMatching(/\+1-\d{8}_\d{6}\.zip$/),
        expect.stringMatching(/\+2-\d{8}_\d{6}\.zip$/),
      ]);
    } finally {
      await utils.updateMyPreferences(admin.accessToken, { download: { archiveSize: 4 * 1024 ** 3 } });
    }
  });
});
