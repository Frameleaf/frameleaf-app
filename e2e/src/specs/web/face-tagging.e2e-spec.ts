import {
  AlbumUserRole,
  AssetEditAction,
  AssetMediaResponseDto,
  correctFace,
  editAsset,
  getFaces,
  getFaceSource,
  LoginResponseDto,
  PersonResponseDto,
  setUserOnboarding,
  SharedLinkType,
} from '@frameleaf/sdk';
import { expect, Page, test } from '@playwright/test';
import { PNG } from 'pngjs';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * A 400x300 gradient, so the preview has real geometry for the tagger to measure. `seed` shifts the
 * gradient: identical bytes would be deduplicated into the same asset on upload.
 */
const makeImage = (seed: number, width = 400, height = 300) => {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      image.data[index] = (x + seed) % 256;
      image.data[index + 1] = y % 256;
      image.data[index + 2] = (x + y) % 256;
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image);
};

const openInfoPanel = async (page: Page, asset: AssetMediaResponseDto) => {
  await page.goto(`/photos/${asset.id}`);
  await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
  await page.keyboard.press('i');
  const panel = page.locator('#detail-panel');
  await expect(panel).toBeVisible();
  return panel;
};

const openFaceTagger = async (page: Page, asset: AssetMediaResponseDto) => {
  const panel = await openInfoPanel(page, asset);
  await panel.getByRole('button', { name: 'Add person' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tag people' });
  await expect(dialog).toBeVisible();
  // The toolbar enables once the preview has loaded and been measured.
  await expect(dialog.getByRole('button', { name: 'Add face' })).toBeEnabled();
  return dialog;
};

/**
 * FL-38: face tagging and detected-face correction against the real server, so the web client and
 * the revision-checked face contract (PATCH /faces/:id, DELETE /faces/:id, POST /faces with the
 * face source revision) are exercised together rather than only against mocked routes.
 */
test.describe('Face tagging (FL-38)', () => {
  let admin: LoginResponseDto;
  let emma: PersonResponseDto;
  let jamie: PersonResponseDto;
  let priya: PersonResponseDto;

  const headers = () => asBearerAuth(admin.accessToken);

  let photos = 0;
  const createPhoto = async (filename: string) => {
    const asset = await utils.createAsset(admin.accessToken, {
      assetData: { bytes: makeImage(photos++), filename },
    });
    await utils.waitForAssetReady(admin.accessToken, asset.id);
    return asset;
  };

  const createPhotoWithDetectedFace = async (filename: string) => {
    const asset = await createPhoto(filename);
    const faceId = (await utils.createDetectedFace({
      assetId: asset.id,
      personGroupId: emma.id,
      imageWidth: 400,
      imageHeight: 300,
      box: { x1: 140, y1: 80, x2: 220, y2: 160 },
    }))!;
    return { asset, faceId };
  };

  const faceOf = async (asset: AssetMediaResponseDto, faceId: string) => {
    const faces = await getFaces({ id: asset.id, withHidden: true }, { headers: headers() });
    return faces.find((face) => face.id === faceId)!;
  };

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [emma, jamie, priya] = await Promise.all([
      utils.createPerson(admin.accessToken, { name: 'Emma' }),
      utils.createPerson(admin.accessToken, { name: 'Jamie' }),
      utils.createPerson(admin.accessToken, { name: 'Priya' }),
    ]);
    // People pickers list people with at least one face in the library (getAllForUser), so each
    // person starts with a face on a group photo.
    const group = await createPhoto('group.png');
    for (const person of [emma, jamie, priya]) {
      await utils.createFace({ assetId: group.id, personGroupId: person.id, imageWidth: 400, imageHeight: 300 });
    }
  });

  test.beforeEach(async ({ context }) => {
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test('reassigns a detected face in the tagger at the revision it was read', async ({ page }) => {
    const { asset, faceId } = await createPhotoWithDetectedFace('reassign.png');
    const before = await faceOf(asset, faceId);

    const dialog = await openFaceTagger(page, asset);
    const faces = dialog.getByRole('group', { name: 'Faces in this image' });
    await expect(faces).toContainText('Emma');
    await expect(faces).toContainText('Detected');

    await dialog.getByRole('button', { name: 'Jamie', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save face tags' }).click();
    await expect(dialog).toBeHidden();

    const after = await faceOf(asset, faceId);
    expect(after.person?.id).toBe(jamie.id);
    expect(after.revision).not.toBe(before.revision);
  });

  test('gives a detected face a person created in the tagger', async ({ page }) => {
    const { asset, faceId } = await createPhotoWithDetectedFace('create.png');

    const dialog = await openFaceTagger(page, asset);
    await dialog.getByRole('button', { name: 'Create person' }).click();
    await dialog.getByRole('textbox', { name: "New person's name" }).fill('Zoe Quinn');
    await dialog.getByRole('button', { name: 'Create and assign' }).click();
    await dialog.getByRole('button', { name: 'Save face tags' }).click();
    await expect(dialog).toBeHidden();

    const after = await faceOf(asset, faceId);
    expect(after.person?.name).toBe('Zoe Quinn');
  });

  test('a conflicting save keeps the draft until the latest faces are loaded', async ({ page }) => {
    const { asset, faceId } = await createPhotoWithDetectedFace('conflict.png');

    const dialog = await openFaceTagger(page, asset);
    await expect(dialog.getByRole('group', { name: 'Faces in this image' })).toContainText('Emma');

    // another view corrects the face while the tagger is open
    const read = await faceOf(asset, faceId);
    await correctFace(
      { id: faceId, assetFaceCorrectionDto: { expectedRevision: read.revision, personId: priya.id } },
      { headers: headers() },
    );

    await dialog.getByRole('button', { name: 'Jamie', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save face tags' }).click();

    await expect(dialog.getByText('Face tags changed in another view.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Face 1: Jamie' })).toBeVisible();
    const unchanged = await faceOf(asset, faceId);
    expect(unchanged.person?.id).toBe(priya.id);

    await dialog.getByRole('button', { name: 'Discard changes and load latest' }).click();
    await expect(dialog.getByText('Face tags changed in another view.')).toBeHidden();
    await expect(dialog.getByRole('group', { name: 'Faces in this image' })).toContainText('Priya');
  });

  test('a region drawn before the image was edited is refused and kept', async ({ page }) => {
    const asset = await createPhoto('source-change.png');

    const dialog = await openFaceTagger(page, asset);
    await dialog.getByRole('button', { name: 'Add face' }).click();
    await dialog.getByRole('button', { name: 'Jamie', exact: true }).click();

    await editAsset(
      {
        id: asset.id,
        assetEditsCreateDto: {
          edits: [{ action: AssetEditAction.Crop, parameters: { x: 100, y: 50, width: 200, height: 150 } }],
        },
      },
      { headers: headers() },
    );
    await utils.waitForQueueFinish(admin.accessToken, 'editor');

    await dialog.getByRole('button', { name: 'Save face tags' }).click();
    await expect(dialog.getByText(/This image changed since you opened it/)).toBeVisible();
    await expect(dialog.getByText('1 face')).toBeVisible();
    expect(await getFaces({ id: asset.id }, { headers: headers() })).toHaveLength(0);
  });

  test('only the signed-in owner can tag a photo shared with an album viewer and a link visitor (FL-40)', async ({
    browser,
    page,
    request,
  }) => {
    const asset = await createPhoto('face-write-boundary.png');
    const member = await utils.userSetup(admin.accessToken, {
      name: 'Album Viewer',
      email: 'face-album-viewer@example.com',
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(member.accessToken) });
    const album = await utils.createAlbum(admin.accessToken, {
      albumName: 'Face write boundary',
      assetIds: [asset.id],
      albumUsers: [{ userId: member.userId, role: AlbumUserRole.Viewer }],
    });
    const link = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [asset.id],
    });
    const memberPerson = await utils.createPerson(member.accessToken, { name: 'Member face' });
    const source = await getFaceSource({ id: asset.id }, { headers: headers() });
    const drawnFace = {
      assetId: asset.id,
      expectedSourceRevision: source.revision,
      imageWidth: 400,
      imageHeight: 300,
      x: 140,
      y: 80,
      width: 80,
      height: 80,
    };

    const memberContext = await browser.newContext();
    const guestContext = await browser.newContext();
    try {
      await utils.setAuthCookies(memberContext, member.accessToken);
      const memberPage = await memberContext.newPage();
      await memberPage.goto(`/albums/${album.id}/photos/${asset.id}`);
      await expect(memberPage.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
      await memberPage.keyboard.press('i');
      await expect(memberPage.locator('#detail-panel')).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Add person' })).toHaveCount(0);

      const guestPage = await guestContext.newPage();
      await guestPage.goto(`/share/${link.key}/photos/${asset.id}`);
      await guestPage.getByRole('button', { name: 'Information', exact: true }).click();
      await expect(guestPage.locator('#detail-panel')).toBeVisible();
      await expect(guestPage.getByRole('button', { name: 'Add person' })).toHaveCount(0);

      // A hidden control is not the permission boundary: use the real face endpoint with a valid
      // source revision and each denied identity before the owner saves through the viewer.
      const sharedWrite = await memberPage.request.post('/api/faces', {
        headers: asBearerAuth(member.accessToken),
        data: { ...drawnFace, personId: memberPerson.id },
      });
      expect(sharedWrite.status()).toBe(400);
      const linkWrite = await guestPage.request.post(`/api/faces?key=${encodeURIComponent(link.key)}`, {
        data: { ...drawnFace, personId: jamie.id },
      });
      expect(linkWrite.status()).toBe(403);
      const unsignedWrite = await request.post('/api/faces', { data: { ...drawnFace, personId: jamie.id } });
      expect(unsignedWrite.status()).toBe(401);
      expect(await getFaces({ id: asset.id }, { headers: headers() })).toHaveLength(0);

      await page.goto(`/albums/${album.id}`);
      const ownerTile = page.locator(`[data-asset-id="${asset.id}"]`);
      await expect(ownerTile).toBeVisible();
      await ownerTile.locator('button').first().click();
      await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', asset.id);
      await page.keyboard.press('i');
      const ownerPanel = page.locator('#detail-panel');
      await expect(ownerPanel).toBeVisible();
      await ownerPanel.getByRole('button', { name: 'Add person' }).click();
      const dialog = page.getByRole('dialog', { name: 'Tag people' });
      await expect(dialog.getByRole('button', { name: 'Add face' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Add face' }).click();
      await dialog.getByRole('button', { name: 'Jamie', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save face tags' }).click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(async () => {
          const faces = await getFaces({ id: asset.id }, { headers: headers() });
          return faces[0]?.person?.id;
        })
        .toBe(jamie.id);
      await page.goBack();
      await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
      await expect(ownerTile).toBeVisible();

      await memberPage.reload();
      await expect(memberPage.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
      await expect(memberPage.locator('#detail-panel')).toBeVisible();
      await expect(memberPage.getByRole('button', { name: 'Add person' })).toHaveCount(0);
    } finally {
      await Promise.all([memberContext.close(), guestContext.close()]);
    }
  });

  test('reassigns a face from its People chip menu', async ({ page }) => {
    const { asset, faceId } = await createPhotoWithDetectedFace('chip-reassign.png');

    const panel = await openInfoPanel(page, asset);
    await panel.getByRole('button', { name: 'Options for Emma' }).click();
    await page.getByRole('menuitem', { name: 'Reassign face…' }).click();
    await page.getByRole('textbox', { name: 'Find a person' }).fill('Jam');
    await page.getByRole('menuitem', { name: 'Jamie' }).click();

    await expect(page.getByText('Reassigned to Jamie')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Options for Jamie' })).toBeVisible();
    const reassigned = await faceOf(asset, faceId);
    expect(reassigned.person?.id).toBe(jamie.id);
  });

  test('hides a face from its People chip menu and shows it again', async ({ page }) => {
    const { asset, faceId } = await createPhotoWithDetectedFace('chip-hide.png');

    const panel = await openInfoPanel(page, asset);
    await panel.getByRole('button', { name: 'Options for Emma' }).click();
    await page.getByRole('menuitem', { name: 'Hide face' }).click();

    await expect(panel.getByRole('button', { name: 'Options for Emma' })).toBeHidden();
    const hidden = await faceOf(asset, faceId);
    expect(hidden.hiddenAt).toEqual(expect.any(String));

    await panel.getByRole('button', { name: 'Show hidden (1)' }).click();
    await expect(panel.getByTestId('hidden-face')).toContainText('Emma');
    await panel.getByRole('button', { name: 'Options for Emma' }).click();
    await page.getByRole('menuitem', { name: 'Show face' }).click();

    await expect(panel.getByTestId('hidden-face')).toHaveCount(0);
    const shown = await faceOf(asset, faceId);
    expect(shown.hiddenAt).toBeNull();
  });
});
