import {
  AlbumKind,
  AlbumUserRole,
  LoginResponseDto,
  acceptSharedSpaceInvitation,
  addAssetsToAlbum,
  getAlbumInfo,
  removeUserFromAlbum,
  setUserOnboarding,
  updateAlbumUser,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-55: a shared space followed live by the people in it — a contributor downgraded or taken out
 * while the space is open, a background "Add everything matching" cancelled before it adds
 * anything, and people named in the space independently of anybody's own names for them.
 */
test.describe('Shared spaces', () => {
  let owner: LoginResponseDto;
  let editor: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    await utils.connectDatabase();
    owner = await utils.adminSetup();
    editor = await utils.userSetup(owner.accessToken, {
      name: 'Eddie Editor',
      email: 'space-editor@example.com',
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(editor.accessToken) });
  });

  /** A space owned by the admin that the editor has joined as an editor. */
  const newSpace = async (albumName: string) => {
    const space = await utils.createAlbum(owner.accessToken, {
      albumName,
      kind: AlbumKind.Space,
      albumUsers: [{ userId: editor.userId, role: AlbumUserRole.Editor }],
    });
    await acceptSharedSpaceInvitation({ id: space.id }, { headers: asBearerAuth(editor.accessToken) });
    return space;
  };

  test('drops the contributor controls when an editor is made a viewer while the space is open', async ({
    context,
    page,
  }) => {
    const space = await newSpace('Downgrade space');
    await utils.setAuthCookies(context, editor.accessToken);
    await page.goto(`/sharing/${space.id}`);
    await expect(page.getByRole('heading', { name: 'Add everything matching' })).toBeVisible();

    await updateAlbumUser(
      { id: space.id, userId: editor.userId, updateAlbumUserDto: { role: AlbumUserRole.Viewer } },
      { headers: asBearerAuth(owner.accessToken) },
    );

    await expect(page.getByRole('heading', { name: 'Add everything matching' })).toHaveCount(0);
  });

  test('takes a removed contributor out of the space at once', async ({ context, page }) => {
    const space = await newSpace('Removal space');
    const asset = await utils.createAsset(editor.accessToken);
    await addAssetsToAlbum(
      { id: space.id, bulkIdsDto: { ids: [asset.id] } },
      { headers: asBearerAuth(editor.accessToken) },
    );

    await utils.setAuthCookies(context, editor.accessToken);
    await page.goto(`/sharing/${space.id}`);
    await expect(page.locator(`[data-asset-id="${asset.id}"]`)).toBeVisible();

    await removeUserFromAlbum({ id: space.id, userId: editor.userId }, { headers: asBearerAuth(owner.accessToken) });

    await page.waitForURL(/\/sharing(?:\?|$)/);
    await expect(page.getByText('You are no longer a member of “Removal space”.')).toBeVisible();
    // Their original is still in their own library.
    await page.goto('/photos');
    await expect(page.locator(`[data-asset-id="${asset.id}"]`)).toBeVisible();
  });

  test('cancels a background add-all-matching before it adds anything', async ({ context, page }) => {
    const space = await newSpace('Cancel space');
    await Promise.all([utils.createAsset(editor.accessToken), utils.createAsset(editor.accessToken)]);

    await utils.setAuthCookies(context, editor.accessToken);
    await page.goto(`/sharing/${space.id}`);
    const section = page.getByRole('region', { name: 'Add everything matching' });
    // The count is asked for once the page is interactive; a click before hydration does nothing.
    // The whole library is the source, so the count includes the editor's items from earlier cases.
    const counted = section.getByText(/^\d+ items will be added\.$/);
    await expect(async () => {
      await section.getByRole('button', { name: 'Check the count' }).click();
      await expect(counted).toBeVisible({ timeout: 2000 });
    }).toPass();
    const countText = await counted.textContent();
    const total = Number(countText?.match(/\d+/)?.[0]);
    expect(total).toBeGreaterThanOrEqual(2);

    // Hold the "what matches" lookup so the operation is still resolving when it is cancelled.
    const gate: { release?: () => void } = {};
    const held = new Promise<void>((resolve) => (gate.release = resolve));
    await page.route('**/api/search/metadata', async (route) => {
      await held;
      await route.fallback();
    });

    await section.getByRole('button', { name: `Add ${total} items` }).click();
    await expect(section.getByText(/Working out what matches/)).toBeVisible();
    await section.getByRole('button', { name: 'Cancel' }).click();
    gate.release?.();

    await expect(section.getByText(/Stopped after/)).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    const after = await getAlbumInfo({ id: space.id }, { headers: asBearerAuth(owner.accessToken) });
    expect(after.assetCount).toBe(0);
  });

  test('names people in the space independently of anybody’s own names for them', async ({ browser }) => {
    const space = await newSpace('People space');
    const ownerAsset = await utils.createAsset(owner.accessToken);
    const editorAsset = await utils.createAsset(editor.accessToken);
    await addAssetsToAlbum(
      { id: space.id, bulkIdsDto: { ids: [ownerAsset.id] } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    await addAssetsToAlbum(
      { id: space.id, bulkIdsDto: { ids: [editorAsset.id] } },
      { headers: asBearerAuth(editor.accessToken) },
    );
    // Each of them has their own, private name for the same grandmother.
    const mom = await utils.createPerson(owner.accessToken, { name: 'Mom' });
    await utils.createFace({ assetId: ownerAsset.id, personGroupId: mom.id });
    const nana = await utils.createPerson(editor.accessToken, { name: 'Nana' });
    await utils.createFace({ assetId: editorAsset.id, personGroupId: nana.id });

    const name = async (accessToken: string, personName: string, spaceName: string) => {
      const context = await browser.newContext();
      await utils.setAuthCookies(context, accessToken);
      const page = await context.newPage();
      await page.goto(`/sharing/${space.id}?panel=people`);
      const people = page.getByRole('region', { name: 'People in the photos' });
      await people.getByLabel('Choose a person').selectOption({ label: personName });
      await people.getByLabel('Name in this shared space').fill(spaceName);
      await people.getByRole('button', { name: 'Add to shared space' }).click();
      await expect(people.getByText(spaceName, { exact: true })).toBeVisible();
      return { context, page, people };
    };

    const ownerView = await name(owner.accessToken, 'Mom', 'Grandma');
    const editorView = await name(editor.accessToken, 'Nana', 'Grandma Rose');

    // Each sees the space's names, never the other's private one.
    await editorView.page.reload();
    await expect(editorView.people.getByText('Grandma', { exact: true })).toBeVisible();
    await expect(editorView.page.getByText('Mom', { exact: true })).toHaveCount(0);
    await ownerView.page.reload();
    await expect(ownerView.people.getByText('Grandma Rose', { exact: true })).toBeVisible();
    await expect(ownerView.page.getByText('Nana', { exact: true })).toHaveCount(0);

    await ownerView.context.close();
    await editorView.context.close();
  });

  test('invites through a named recipient group after reviewing it (FL-55)', async ({ context, page }) => {
    const reviewer = await utils.userSetup(owner.accessToken, {
      name: 'Rita Recipient',
      email: 'space-recipient@example.com',
      password: 'password',
    });
    const space = await utils.createAlbum(owner.accessToken, { albumName: 'Group space', kind: AlbumKind.Space });

    await utils.setAuthCookies(context, owner.accessToken);
    await page.goto(`/sharing/${space.id}?panel=members`);
    await page.getByRole('button', { name: 'Invite people' }).click();
    await page.getByRole('button', { name: 'New group…' }).click();
    const groups = page.getByRole('dialog', { name: 'Recipient groups' });
    await groups.getByRole('button', { name: 'New group…' }).click();
    await groups.getByLabel('Group name').fill('Book club');
    const list = groups.getByRole('listbox', { name: 'People in this group' });
    await list.getByRole('option', { name: /Rita Recipient/ }).click();
    await list.getByRole('option', { name: /Eddie Editor/ }).click();
    await groups.getByRole('button', { name: 'Save group of 2' }).click();
    await groups.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('button', { name: 'Invite Book club, 2 people' }).click();
    const sheet = page.getByRole('dialog', { name: 'Invite “Book club”' });
    await sheet.getByRole('checkbox', { name: /Eddie Editor/ }).uncheck();
    await sheet.getByRole('button', { name: 'Send 1 invitation' }).click();

    // The roster now lists Rita as an unanswered invitation, and nobody else was invited.
    const members = page.getByRole('region', { name: 'Members' });
    await expect(
      members.getByRole('listitem').filter({ hasText: 'Rita Recipient' }).filter({ hasText: 'Invitation sent' }),
    ).toBeVisible();
    await expect(
      members.getByRole('listitem').filter({ hasText: 'Eddie Editor' }).filter({ hasText: 'Invitation sent' }),
    ).toHaveCount(0);
    const info = await getAlbumInfo({ id: space.id }, { headers: asBearerAuth(owner.accessToken) });
    // An invitation grants nothing until it is accepted.
    expect(info.albumUsers.map(({ user }) => user.id)).not.toContain(reviewer.userId);
  });
});
