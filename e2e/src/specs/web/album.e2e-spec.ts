import {
  AlbumKind,
  AlbumUserRole,
  AssetOrder,
  getAlbumInfo,
  getAlbumTree,
  getAllAlbums,
  getAssetDevelop,
  getFaces,
  getFaceSource,
  login,
  LoginResponseDto,
  moveAlbumToCollection,
  setUserOnboarding,
  updateAlbumInfo,
} from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { asBearerAuth, testAssetDir, utils } from 'src/utils.js';

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

  test('keeps a shared photo and video through viewer back and refresh (FL-40)', async ({ browser, context, page }) => {
    const member = await utils.userSetup(admin.accessToken, {
      name: 'Album Member',
      email: 'fl40-album-member@example.com',
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(member.accessToken) });
    const photo = await utils.createAsset(admin.accessToken);
    const video = await utils.createAsset(admin.accessToken, {
      assetData: {
        bytes: readFileSync(new URL('../../fixtures/frameleaf-media/kayak-demo.mp4', import.meta.url)),
        filename: 'kayak-demo.mp4',
      },
    });
    const album = await utils.createAlbum(admin.accessToken, {
      albumName: 'Photo and video trip',
      assetIds: [photo.id, video.id],
      albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }],
    });

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/albums/${album.id}`);
    const photoTile = page.locator(`[data-asset-id="${photo.id}"]`);
    const videoTile = page.locator(`[data-asset-id="${video.id}"]`);
    await expect(photoTile).toBeVisible();
    await expect(videoTile).toBeVisible();

    await photoTile.hover();
    await photoTile.getByRole('checkbox').click();
    await expect(page.getByRole('region', { name: 'Selected items' })).toContainText('1 selected');
    // A shared display-order update from another device preserves this tab's selection.
    await updateAlbumInfo(
      { id: album.id, updateAlbumDto: { order: AssetOrder.Asc } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('captured-asc');
    await expect(photoTile.getByRole('checkbox')).toBeChecked();
    await expect(page.getByRole('region', { name: 'Selected items' })).toContainText('1 selected');
    await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Work' }).click();
    await expect(page.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'work');
    await expect(photoTile.getByRole('checkbox')).toBeChecked();
    await photoTile.getByRole('checkbox').click();

    await videoTile.locator('button').first().click();
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', video.id);
    await page.goBack();
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await page.reload();
    await expect(photoTile).toBeVisible();
    await expect(videoTile).toBeVisible();

    // Personal sort belongs to this signed-in viewer, even when another member uses the same device.
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('filename');
    await utils.setAuthCookies(context, member.accessToken);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('captured-asc');
    await utils.setAuthCookies(context, admin.accessToken);
    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('filename');

    const memberContext = await browser.newContext();
    try {
      await utils.setAuthCookies(memberContext, member.accessToken);
      const memberPage = await memberContext.newPage();
      await memberPage.goto(`/albums/${album.id}`);
      await expect(memberPage.locator(`[data-asset-id="${photo.id}"]`)).toBeVisible();
      await expect(memberPage.locator(`[data-asset-id="${video.id}"]`)).toBeVisible();
      await memberPage.reload();
      await expect(memberPage.locator(`[data-asset-id="${photo.id}"]`)).toBeVisible();
      await expect(memberPage.locator(`[data-asset-id="${video.id}"]`)).toBeVisible();
      await memberPage.locator(`[data-asset-id="${photo.id}"] button`).first().click();
      await expect(memberPage.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', photo.id);
      await memberPage.goBack();
      await expect(memberPage.locator('#immich-asset-viewer')).toHaveCount(0);
      await expect(memberPage.locator(`[data-asset-id="${video.id}"]`)).toBeVisible();
    } finally {
      await memberContext.close();
    }

    const saved = await getAlbumInfo({ id: album.id }, { headers: asBearerAuth(admin.accessToken) });
    expect(saved.assetCount).toBe(2);
    expect(saved.albumUsers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: AlbumUserRole.Viewer,
          user: expect.objectContaining({ id: member.userId }),
        }),
      ]),
    );
  });

  test('restores the album journey through filters, layouts, quick edit and reconnect (FL-40)', async ({
    browser,
    context,
    page,
    request,
  }) => {
    test.slow();
    const owner = await utils.userSetup(admin.accessToken, {
      name: 'Album Journey Owner',
      email: 'fl40-album-journey@example.com',
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(owner.accessToken) });
    const member = await utils.userSetup(admin.accessToken, {
      name: 'Journey Viewer',
      email: 'fl40-journey-viewer@example.com',
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(member.accessToken) });
    const memberPerson = await utils.createPerson(member.accessToken, { name: 'Viewer-owned person' });
    await utils.setAuthCookies(context, owner.accessToken);
    const photo = await utils.createAsset(owner.accessToken, {
      assetData: {
        bytes: readFileSync(new URL('../../fixtures/frameleaf-media/hiking.png', import.meta.url)),
        filename: 'alpha.png',
      },
    });
    const otherPhoto = await utils.createAsset(owner.accessToken, { assetData: { filename: 'zulu.png' } });
    const video = await utils.createAsset(owner.accessToken, {
      assetData: {
        bytes: readFileSync(new URL('../../fixtures/frameleaf-media/kayak-demo.mp4', import.meta.url)),
        filename: 'journey.mp4',
      },
    });
    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'Album continuity',
      assetIds: [photo.id, otherPhoto.id, video.id],
      albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }],
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
    const membershipBefore = await getAlbumInfo({ id: album.id }, { headers: asBearerAuth(owner.accessToken) });
    const originalMemberships = await Promise.all(
      [photo, otherPhoto, video].map(async ({ id }) => {
        const albums = await getAllAlbums({ assetId: id }, { headers: asBearerAuth(owner.accessToken) });
        return albums.map((album) => album.id).toSorted((a, b) => a.localeCompare(b));
      }),
    );

    await page.goto(`/albums/${album.id}`);
    const photoTile = page.locator(`[data-asset-id="${photo.id}"]`);
    const tiles = page.getByTestId('frameleaf-library').locator('[data-asset-id]');
    await expect(page.locator(`[data-asset-id="${video.id}"]`)).toBeVisible();
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    const filters = page.getByRole('dialog', { name: 'Search your library' });
    await filters
      .getByRole('group', { name: 'Media type' })
      .getByRole('button', { name: /^Photos/ })
      .click();
    await filters.getByRole('button', { name: /^Show .*results?$/ }).click();
    await expect(filters).toBeHidden();
    await expect(page).toHaveURL(new RegExp(String.raw`/albums/${album.id}(?:\?|$)`));
    await expect(page.locator(`[data-asset-id="${video.id}"]`)).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('filename');
    await expect(tiles).toHaveCount(2);
    await expect(tiles.first()).toHaveAttribute('data-asset-id', photo.id);
    await expect(tiles.last()).toHaveAttribute('data-asset-id', otherPhoto.id);

    await photoTile.hover();
    await photoTile.getByRole('checkbox').click();
    const selection = page.getByRole('region', { name: 'Selected items' });
    // App.jsx: layout changes keep the one selection and query. Filename sort resumes in flat layouts.
    for (const layout of ['Timeline', 'Browse', 'Work']) {
      await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: layout, exact: true }).click();
      await expect(page.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', layout.toLowerCase());
      await expect(photoTile.getByRole('checkbox')).toBeChecked();
      await expect(selection).toContainText('1 selected');
    }
    await page.reload();
    await expect(page.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'work');
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('filename');
    await expect(photoTile.getByRole('checkbox')).toBeChecked();
    await expect(tiles).toHaveCount(2);

    // The Work inspector opens the selected item without toggling its selection.
    const inspector = page.getByTestId('frameleaf-work-inspector');
    await expect(inspector.getByRole('heading', { name: 'alpha.png', exact: true })).toBeVisible();
    await inspector.getByRole('button', { name: 'Open in the viewer', exact: true }).click();
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', photo.id);
    await page.keyboard.press('i');
    const info = page.locator('#detail-panel');
    await expect(info).toBeVisible();
    await info.getByRole('button', { name: 'Add person' }).click();
    const faceDialog = page.getByRole('dialog', { name: 'Tag people' });
    await expect(faceDialog.getByRole('button', { name: 'Add face' })).toBeEnabled();
    // Draw a real region through the measured image rather than adding the default box.
    await expect(faceDialog.getByRole('button', { name: 'Draw face', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Measure the drawing target after the sheet's scale/translation animation has settled.
    await faceDialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
    });
    const image = faceDialog.locator('.ft-stage img');
    const bounds = await image.evaluate((element: HTMLImageElement) => {
      const rect = element.getBoundingClientRect();
      const scale = Math.min(rect.width / element.naturalWidth, rect.height / element.naturalHeight);
      const width = element.naturalWidth * scale;
      const height = element.naturalHeight * scale;
      return { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height };
    });
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.45, { steps: 5 });
    await page.mouse.up();
    await expect(faceDialog.getByRole('group', { name: 'Faces in this image' }).getByRole('button')).toHaveCount(1);
    await faceDialog.getByRole('button', { name: 'Create person' }).click();
    await faceDialog.getByRole('textbox', { name: "New person's name" }).fill('Journey face');
    await faceDialog.getByRole('button', { name: 'Create and assign' }).click();
    await faceDialog.getByRole('button', { name: 'Save face tags' }).click();
    await expect(faceDialog).toBeHidden();
    await expect
      .poll(async () => {
        const faces = await getFaces({ id: photo.id }, { headers: asBearerAuth(owner.accessToken) });
        return faces[0]?.person?.name;
      })
      .toBe('Journey face');
    await expect(info).toContainText('Journey face');
    await page.goBack();
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(photoTile.getByRole('checkbox')).toBeChecked();
    await expect(selection).toContainText('1 selected');

    // The real selection action opens the selected photo in the viewer and editor without clearing it.
    const developLoaded = page.waitForResponse(
      (response) => response.url().endsWith(`/api/assets/${photo.id}/develop`) && response.ok(),
    );
    await selection.getByRole('button', { name: 'Quick edit', exact: true }).click();
    const initialDevelop = await developLoaded;
    await initialDevelop.finished();
    const developData = await initialDevelop.json();
    expect(developData.revisions).toEqual([]);
    const editor = page.getByRole('dialog', { name: /Edit/ });
    const exposure = editor.getByRole('slider', { name: 'Exposure' });
    // This message renders only after the editor has consumed its initial server state.
    await editor.getByRole('button', { name: 'Versions', exact: true }).click();
    await expect(editor.getByText('No saved versions yet. Save version keeps this edit as a new one.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exposure).toHaveValue('0');
    const draftKey = `frameleaf.editor.continuity.${photo.id}`;
    await context.setOffline(true);
    try {
      await exposure.fill('0.5');
      await expect(exposure).toHaveValue('0.5');
      await expect
        .poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey))
        .toContain('"exposure":0.5');
    } finally {
      await context.setOffline(false);
    }
    await page.reload();
    await expect(exposure).toHaveValue('0.5');
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(exposure).toHaveValue('0');
    await editor.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(exposure).toHaveValue('0.5');
    const develop = await getAssetDevelop({ id: photo.id }, { headers: asBearerAuth(owner.accessToken) });
    expect(develop.revisions).toHaveLength(0);

    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', photo.id);
    await page.goBack();
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(photoTile.getByRole('checkbox')).toBeChecked();
    await expect(page.getByTestId('frameleaf-library')).toHaveAttribute('data-layout', 'work');
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('filename');
    await expect(tiles).toHaveCount(2);
    await expect(tiles.first()).toHaveAttribute('data-asset-id', photo.id);
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();

    const facesBefore = await getFaces({ id: photo.id }, { headers: asBearerAuth(owner.accessToken) });
    expect(facesBefore).toHaveLength(1);
    const face = facesBefore[0];
    expect((face.boundingBoxX2 - face.boundingBoxX1) / face.imageWidth).toBeCloseTo(0.2, 2);
    expect((face.boundingBoxY2 - face.boundingBoxY1) / face.imageHeight).toBeCloseTo(0.2, 2);
    expect(face.boundingBoxX1 / face.imageWidth).toBeCloseTo(0.25, 2);
    expect(face.boundingBoxY1 / face.imageHeight).toBeCloseTo(0.25, 2);
    const source = await getFaceSource({ id: photo.id }, { headers: asBearerAuth(owner.accessToken) });
    const faceWrite = {
      assetId: photo.id,
      personId: memberPerson.id,
      expectedSourceRevision: source.revision,
      imageWidth: face.imageWidth,
      imageHeight: face.imageHeight,
      x: 10,
      y: 10,
      width: 30,
      height: 30,
    };
    const memberContext = await browser.newContext();
    try {
      await utils.setAuthCookies(memberContext, member.accessToken);
      const memberPage = await memberContext.newPage();
      await memberPage.goto(`/albums/${album.id}/photos/${photo.id}`);
      await expect(memberPage.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', photo.id);
      await memberPage.keyboard.press('i');
      await expect(memberPage.locator('#detail-panel')).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Add person' })).toHaveCount(0);
      const denied = await memberPage.request.post('/api/faces', {
        headers: asBearerAuth(member.accessToken),
        data: faceWrite,
      });
      expect(denied.status()).toBe(400);
    } finally {
      await memberContext.close();
    }
    const anonymous = await request.post('/api/faces', { data: faceWrite });
    expect(anonymous.status()).toBe(401);
    expect(await getFaces({ id: photo.id }, { headers: asBearerAuth(owner.accessToken) })).toEqual(facesBefore);
    const membershipAfter = await getAlbumInfo({ id: album.id }, { headers: asBearerAuth(owner.accessToken) });
    const finalMemberships = await Promise.all(
      [photo, otherPhoto, video].map(async ({ id }) => {
        const albums = await getAllAlbums({ assetId: id }, { headers: asBearerAuth(owner.accessToken) });
        return albums.map((album) => album.id).toSorted((a, b) => a.localeCompare(b));
      }),
    );
    expect(finalMemberships).toEqual(originalMemberships);
    expect(membershipAfter.albumUsers).toEqual(membershipBefore.albumUsers);
    expect(membershipAfter.assetCount).toBe(3);

    // Leave a real draft before signing out; neither it nor the album selection may reach the next session.
    const albumUrl = page.url();
    await selection.getByRole('button', { name: 'Quick edit', exact: true }).click();
    await expect(exposure).toHaveValue('0');
    await exposure.fill('0.7');
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toContain('"exposure":0.7');
    await page.goto(albumUrl);
    await page.getByRole('button', { name: `Account menu for ${owner.name}` }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
    await expect
      .poll(() => page.evaluate((id) => sessionStorage.getItem(`frameleaf:library:tab:v1:${id}`), owner.userId))
      .toBeNull();
    const nextSession = await login({
      loginCredentialDto: { email: owner.userEmail, password: 'password' },
    });
    await utils.setAuthCookies(context, nextSession.accessToken);
    await page.goto(`/albums/${album.id}`);
    await expect(photoTile).toBeVisible();
    await expect(photoTile.getByRole('checkbox')).not.toBeChecked();
    await expect(page.getByRole('dialog', { name: /Edit/ })).toHaveCount(0);
  });

  test('opens an asset from a collection and returns to its grid (FL-40)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const photo = await utils.createAsset(admin.accessToken);
    const collection = await utils.createAlbum(admin.accessToken, {
      albumName: 'Trip collection',
      kind: AlbumKind.Collection,
    });
    await utils.createAlbum(admin.accessToken, {
      albumName: 'Trip album',
      parentId: collection.id,
      assetIds: [photo.id],
    });

    await page.goto(`/albums/${collection.id}`);
    const tile = page.locator(`[data-asset-id="${photo.id}"]`);
    await expect(tile).toBeVisible();
    await tile.locator('button').first().click();
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', photo.id);
    await page.goBack();
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(tile).toBeVisible();
  });

  test('opens the Map screen scoped to the album and returns to it from the viewer', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    // The markers are map layers, so they appear only once a style loads; serve one locally.
    await utils.mockMapStyle(context);

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

    // MapView.jsx:579-582: a single item's marker is a button named "Open <file name>, <place>".
    const mapMarker = page.getByRole('button', { name: /^Open thompson-springs\.jpg/ }).first();
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
    await expect(link.getByRole('switch', { name: /^Show photo details/ })).not.toBeChecked();
    // Originals carry their EXIF and GPS, so download follows metadata (off and disabled until it is on).
    const download = link.getByRole('switch', { name: /^Allow download/ });
    await expect(download).not.toBeChecked();
    await expect(download).toBeDisabled();
    await link.getByRole('switch', { name: /^Show photo details/ }).check();
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

  test('arranges albums in a custom order with the keyboard and keeps it (FL-52)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const collection = await utils.createAlbum(admin.accessToken, {
      albumName: 'Order shelf',
      kind: AlbumKind.Collection,
    });
    await utils.createAlbum(admin.accessToken, { albumName: 'Order first', parentId: collection.id });
    await utils.createAlbum(admin.accessToken, { albumName: 'Order second', parentId: collection.id });

    await page.goto('/albums');
    // The sort menu is keyboard-complete: open it, arrow to "Custom order", choose it.
    const sort = page.getByRole('button', { name: 'Sort albums' });
    await sort.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitemcheckbox', { name: 'Custom order' }).focus();
    await page.keyboard.press('Enter');

    const shelf = page.getByRole('region', { name: 'Order shelf' });
    const names = () =>
      shelf.getByRole('article').evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('aria-label')));
    const [first, second] = await names();

    // Move earlier from the tile's menu, by keyboard only.
    await shelf.getByRole('button', { name: `Actions for ${second}` }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Move earlier' }).focus();
    await page.keyboard.press('Enter');
    const announcement = `“${second}” is now 1 of 2`;
    await expect(page.getByRole('status').filter({ hasText: announcement })).toContainText(announcement);
    await expect.poll(names).toEqual([second, first]);

    // The order is saved on the server for this person and survives a reload.
    await page.reload();
    await expect.poll(names).toEqual([second, first]);
  });

  test('moves an album into a collection with the keyboard only (FL-52)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await utils.createAlbum(admin.accessToken, { albumName: 'Keyboard target', kind: AlbumKind.Collection });
    await utils.createAlbum(admin.accessToken, { albumName: 'Keyboard mover' });

    await page.goto('/albums');
    await page.getByRole('button', { name: 'Actions for Keyboard mover' }).first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Move to…' }).focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Move “Keyboard mover”' });
    await dialog.getByRole('radio', { name: /Keyboard target/ }).focus();
    await page.keyboard.press('Space');
    await dialog.getByRole('button', { name: 'Move', exact: true }).focus();
    await page.keyboard.press('Enter');

    await expect(page.getByText('Moved “Keyboard mover” into “Keyboard target”')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Keyboard target' }).getByRole('article', { name: 'Keyboard mover' }),
    ).toBeVisible();
  });

  test('refuses a move made from an outdated directory and shows the latest (FL-52)', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const family = await utils.createAlbum(admin.accessToken, {
      albumName: 'Stale family',
      kind: AlbumKind.Collection,
    });
    await utils.createAlbum(admin.accessToken, { albumName: 'Stale trips', kind: AlbumKind.Collection });
    const album = await utils.createAlbum(admin.accessToken, { albumName: 'Stale mover' });

    await page.goto('/albums');
    await expect(page.getByRole('article', { name: 'Stale mover' })).toBeVisible();

    // Another tab moves the album into Family while this page still shows it on its own.
    await moveAlbumToCollection(
      { id: album.id, moveAlbumDto: { collectionId: family.id } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    await page.getByRole('button', { name: 'Actions for Stale mover' }).first().click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move “Stale mover”' });
    await dialog.getByRole('radio', { name: /Stale trips/ }).check();
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();

    await expect(page.getByRole('status')).toContainText('Your albums changed since this page loaded');
    const tree = await getAlbumTree({ headers: asBearerAuth(admin.accessToken) });
    const node = tree.collections.find(({ collection }) => collection.id === family.id);
    expect(node?.albums.map(({ id }) => id)).toContain(album.id);
  });

  test('opens the album inside the Frameleaf shell, without the legacy app bar', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const album = await utils.createAlbum(admin.accessToken, { albumName: 'Shell album' });

    await page.goto(`/albums/${album.id}`);
    // AL-17: the breadcrumb leads back; the header offers Likes & comments even before anyone else joins (AL-14).
    const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(crumbs.getByRole('link', { name: 'Albums' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Likes & comments', exact: true })).toBeVisible();
    await crumbs.getByRole('link', { name: 'Albums' }).click();
    await page.waitForURL(/\/albums(?:\?|$)/);
  });

  test('on a phone keeps Add photos and Share and moves the other actions into More actions', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.setViewportSize({ width: 390, height: 844 });
    const asset = await utils.createAsset(admin.accessToken);
    const album = await utils.createAlbum(admin.accessToken, { albumName: 'Phone album', assetIds: [asset.id] });

    await page.goto(`/albums/${album.id}`);
    // Approved template: album actions beyond Add photos and Share move into "…".
    const toolbar = page.getByRole('toolbar', { name: /actions/ });
    await expect(toolbar.getByRole('button', { name: 'Add photos' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Share' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Slideshow' })).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: 'Download' })).toHaveCount(0);

    await toolbar.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu', { name: 'More actions' });
    for (const name of ['Shared links', 'Slideshow', 'Download']) {
      await expect(menu.getByRole('menuitem', { name })).toBeVisible();
    }
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Likes & comments' })).toBeVisible();
  });
});
