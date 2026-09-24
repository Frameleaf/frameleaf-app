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

    // Albums page -> Create album opens the create dialog; creating stays on the directory with a
    // status line (Collections.jsx onSubmit), and the new album opens from its card.
    await page.goto('/albums');
    await page.getByRole('button', { name: 'Create album' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Weekend trip');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/albums(?:\?|$)/);
    await page
      .getByRole('link', { name: /Weekend trip/ })
      .first()
      .click();
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

    // MapView.jsx in album scope keeps the settings sheet, whose switches narrow the album's items.
    const tools = page.getByRole('toolbar', { name: 'Map tools' });
    await tools.getByRole('button', { name: 'Map settings' }).click();
    const sheet = page.getByRole('dialog', { name: 'Map settings' });
    await expect(sheet.getByRole('switch', { name: 'Partner items' })).toHaveAttribute('aria-checked', 'true');
    await sheet.getByRole('switch', { name: 'Only favorites' }).click();
    await expect(page.getByText('No located items match these settings')).toBeVisible();
    await sheet.getByRole('switch', { name: 'Only favorites' }).click();
    await expect(mapMarker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // "Search this area" is offered in album scope too, once the view has moved.
    await tools.getByRole('button', { name: 'Zoom out' }).click();
    await expect(page.getByRole('button', { name: 'Search this area' })).toBeVisible();
    await tools.getByRole('button', { name: 'Show all items' }).click();

    await mapMarker.click();

    const viewer = page.locator('#immich-asset-viewer');
    await expect(viewer).toHaveAttribute('data-asset-id', mapAsset.id);
    await page.keyboard.press('Escape');

    await expect(viewer).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(String.raw`/map\?albumId=${mapAlbum.id}`));
    await expect(mapMarker).toBeVisible();
  });

  test('edits, links and deletes an album with the Frameleaf dialogs', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await utils.createAlbum(admin.accessToken, { albumName: 'Dialogs album' });

    await page.goto('/albums');
    const openActions = async (name: string) => {
      await page
        .getByRole('button', { name: `Actions for ${name}` })
        .first()
        .click();
      return page.getByRole('menu', { name: `Actions for ${name}` });
    };

    // CollectionFormDialog (CollectionHeader.jsx:330-455) edits as well as creates (AL-2).
    let menu = await openActions('Dialogs album');
    await menu.getByRole('menuitem', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit album' });
    await expect(edit.getByLabel('Name')).toHaveValue('Dialogs album');
    await edit.getByLabel('Name').fill('Dialogs album, renamed');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved “Dialogs album, renamed”')).toBeVisible();

    // Collections.jsx:349 "Create link" opens the shared-link form, which ends on "Link ready" (AL-7, AL-24).
    menu = await openActions('Dialogs album, renamed');
    await menu.getByRole('menuitem', { name: 'Create link' }).click();
    const link = page.getByRole('dialog', { name: 'Create shared link' });
    await expect(link.getByRole('switch', { name: /^Show metadata/ })).not.toBeChecked();
    // Originals carry their EXIF and GPS, so download follows metadata (off and disabled until it is on).
    const download = link.getByRole('switch', { name: /^Allow download/ });
    await expect(download).not.toBeChecked();
    await expect(download).toBeDisabled();
    await link.getByRole('switch', { name: /^Show metadata/ }).check();
    await expect(download).toBeEnabled();
    await link.getByRole('button', { name: 'Create link', exact: true }).click();
    const ready = page.getByRole('dialog', { name: 'Link ready' });
    await expect(ready.getByLabel('Link address')).toHaveValue(/\/share\//);
    await ready.getByRole('button', { name: 'Done' }).click();
    await expect(ready).toHaveCount(0);

    // DeleteDialog (CollectionHeader.jsx:747-786) in place of the legacy prompt (AL-4).
    menu = await openActions('Dialogs album, renamed');
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    const remove = page.getByRole('dialog', { name: 'Delete “Dialogs album, renamed”?' });
    await expect(remove).toContainText('It has no items, so nothing else changes.');
    await remove.getByRole('button', { name: 'Delete album' }).click();
    await expect(page.getByRole('article', { name: 'Dialogs album, renamed' })).toHaveCount(0);
  });

  test('opens the album inside the Frameleaf shell, without the legacy app bar', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const album = await utils.createAlbum(admin.accessToken, { albumName: 'Shell album' });

    await page.goto(`/albums/${album.id}`);
    // AL-17: the breadcrumb leads back; the header offers Activity even before anyone else joins (AL-14).
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.getByRole('link', { name: 'Albums' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Activity, 0 entries' })).toBeVisible();
    await crumbs.getByRole('link', { name: 'Albums' }).click();
    await page.waitForURL(/\/albums(?:\?|$)/);
  });
});
