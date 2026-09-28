import {
  AlbumUserRole,
  LoginResponseDto,
  removeUserFromAlbum,
  setUserOnboarding,
  updateAlbumInfo,
  updateAlbumUser,
} from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

const openMore = async (page: Page) => {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  return page.getByRole('menu', { name: 'More actions' });
};

/**
 * FL-53: the album detail page under each role, and what happens when a role changes while the page
 * is open. The server refuses everything a role may not do; these check that the page never offers
 * it, and that it follows a change made elsewhere without a reload.
 */
test.describe('Album roles', () => {
  let owner: LoginResponseDto;
  let editor: LoginResponseDto;
  let viewer: LoginResponseDto;

  const onboard = (user: LoginResponseDto) =>
    setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(user.accessToken) });

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    owner = await utils.adminSetup();
    editor = await utils.userSetup(owner.accessToken, {
      name: 'Eddie Editor',
      email: 'editor@example.com',
      password: 'password',
    });
    viewer = await utils.userSetup(owner.accessToken, {
      name: 'Vera Viewer',
      email: 'viewer@example.com',
      password: 'password',
    });
    await Promise.all([onboard(editor), onboard(viewer)]);
  });

  const sharedAlbum = async (albumName: string) => {
    const asset = await utils.createAsset(owner.accessToken);
    return utils.createAlbum(owner.accessToken, {
      albumName,
      assetIds: [asset.id],
      albumUsers: [
        { userId: editor.userId, role: AlbumUserRole.Editor },
        { userId: viewer.userId, role: AlbumUserRole.Viewer },
      ],
    });
  };

  test('shows each role only the controls it may use', async ({ browser }) => {
    const album = await sharedAlbum('Role matrix');

    const matrix = [
      { user: owner, add: true, share: true, links: true, edit: true, leave: false },
      { user: editor, add: true, share: false, links: false, edit: true, leave: true },
      { user: viewer, add: false, share: false, links: false, edit: false, leave: true },
    ];

    for (const row of matrix) {
      const context = await browser.newContext();
      await utils.setAuthCookies(context, row.user.accessToken);
      const page = await context.newPage();
      await page.goto(`/albums/${album.id}`);
      // For an owner or editor the title is the prototype's inline-edit button inside the h1, whose
      // accessible name is "Edit title" (CollectionHeader.jsx:1092-1104), so wait on the breadcrumb.
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Role matrix')).toBeVisible();

      // Add (select from library) and upload share one menu.
      await expect(page.getByRole('button', { name: 'Add photos' })).toHaveCount(row.add ? 1 : 0);
      if (row.add) {
        await page.getByRole('button', { name: 'Add photos' }).click();
        await expect(page.getByRole('menuitem', { name: /Upload from computer/ })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      // Invite is the owner's; everyone else sees who is in the album.
      await expect(page.getByRole('button', { name: 'Share', exact: true })).toHaveCount(row.share ? 1 : 0);
      await expect(page.getByRole('button', { name: 'Members', exact: true })).toHaveCount(row.share ? 0 : 1);
      await expect(page.getByRole('button', { name: 'Shared links' })).toHaveCount(row.links ? 1 : 0);
      // Activity is offered to every role.
      await expect(page.getByRole('button', { name: /^Activity/ })).toBeVisible();

      const more = await openMore(page);
      await expect(more.getByRole('menuitem', { name: 'Edit details' })).toHaveCount(row.edit ? 1 : 0);
      await expect(more.getByRole('menuitem', { name: /Delete album/ })).toHaveCount(row.leave ? 0 : 1);
      await expect(more.getByRole('menuitem', { name: /Leave album/ })).toHaveCount(row.leave ? 1 : 0);
      await page.keyboard.press('Escape');

      // Removing items is an album-scoped bulk action, offered to owners and editors only.
      const tile = page.locator('[data-asset-id]').first();
      await tile.hover();
      await tile.getByRole('checkbox').click();
      const bar = page.getByRole('region', { name: 'Selected items' });
      await bar.getByRole('button', { name: 'More' }).click();
      await expect(page.getByRole('menuitem', { name: 'Remove from album' })).toHaveCount(row.edit ? 1 : 0);
      await context.close();
    }
  });

  test('keeps the history readable when comments are turned off', async ({ context, page }) => {
    const album = await sharedAlbum('Quiet album');
    await updateAlbumInfo(
      { id: album.id, updateAlbumDto: { isActivityEnabled: false } },
      { headers: asBearerAuth(owner.accessToken) },
    );

    await utils.setAuthCookies(context, viewer.accessToken);
    await page.goto(`/albums/${album.id}`);
    await page.getByRole('button', { name: /^Activity/ }).click();
    await expect(page.getByText(/Likes and comments are turned off here/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Like', exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Write a comment' })).toHaveCount(0);
  });

  test('lets the last member leave; the album stays with its owner, now private', async ({ browser }) => {
    const asset = await utils.createAsset(owner.accessToken);
    const album = await utils.createAlbum(owner.accessToken, {
      albumName: 'Last member',
      assetIds: [asset.id],
      albumUsers: [{ userId: viewer.userId, role: AlbumUserRole.Viewer }],
    });

    const memberContext = await browser.newContext();
    await utils.setAuthCookies(memberContext, viewer.accessToken);
    const member = await memberContext.newPage();
    await member.goto(`/albums/${album.id}`);
    const more = await openMore(member);
    await more.getByRole('menuitem', { name: /Leave album/ }).click();
    const confirm = member.getByRole('dialog', { name: 'Leave “Last member”?' });
    await confirm.getByRole('button', { name: /Leave album/ }).click();
    await member.waitForURL(/\/albums(?:\?|$)/);
    await expect(member.getByRole('article', { name: 'Last member' })).toHaveCount(0);
    // Leaving is one navigation: the page's own removal handling ignores the leave it caused.
    await member.waitForTimeout(1000);
    await expect(member).toHaveURL(/\/albums(?:\?|$)/);
    await expect(member.getByText('You are no longer a member of “Last member”.')).toHaveCount(0);
    await memberContext.close();

    const ownerContext = await browser.newContext();
    await utils.setAuthCookies(ownerContext, owner.accessToken);
    const page = await ownerContext.newPage();
    await page.goto(`/albums/${album.id}`);
    // Nobody else is in it any more; the owner keeps the album and its item.
    await expect(page.getByRole('button', { name: 'Private · share it' })).toBeVisible();
    await expect(page.getByText('1 item', { exact: true }).first()).toBeVisible();
    await ownerContext.close();
  });

  test('closes an open dialog and drops editing when the role is downgraded live', async ({ context, page }) => {
    const album = await sharedAlbum('Live downgrade');
    await utils.setAuthCookies(context, editor.accessToken);
    await page.goto(`/albums/${album.id}`);

    const more = await openMore(page);
    await more.getByRole('menuitem', { name: 'Options' }).click();
    const dialog = page.getByRole('dialog', { name: 'Options' });
    await expect(dialog).toBeVisible();

    // The owner makes the editor a viewer from another window.
    await updateAlbumUser(
      { id: album.id, userId: editor.userId, updateAlbumUserDto: { role: AlbumUserRole.Viewer } },
      { headers: asBearerAuth(owner.accessToken) },
    );

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add photos' })).toHaveCount(0);
    await expect(page.getByText('Your role changed: you can now only view this album.')).toBeVisible();

    // And back again, so the other cases keep an editor.
    await updateAlbumUser(
      { id: album.id, userId: editor.userId, updateAlbumUserDto: { role: AlbumUserRole.Editor } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
  });

  test('leaves the page when the member is removed while it is open', async ({ context, page }) => {
    const album = await sharedAlbum('Removed live');
    await utils.setAuthCookies(context, viewer.accessToken);
    await page.goto(`/albums/${album.id}`);
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await removeUserFromAlbum({ id: album.id, userId: viewer.userId }, { headers: asBearerAuth(owner.accessToken) });

    await page.waitForURL(/\/albums(?:\?|$)/);
    await expect(page.getByText('You are no longer a member of “Removed live”.')).toBeVisible();
  });

  test('keeps the owner’s share dialog true when a recipient leaves while it is open (FL-54)', async ({
    context,
    page,
  }) => {
    const album = await sharedAlbum('Recipient leaves');
    await utils.setAuthCookies(context, owner.accessToken);
    await page.goto(`/albums/${album.id}`);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const access = page.getByRole('region', { name: 'Who has access' });
    await expect(access.getByText('Vera Viewer')).toBeVisible();

    // The viewer leaves from their own device while the owner's dialog is open.
    await removeUserFromAlbum({ id: album.id, userId: 'me' }, { headers: asBearerAuth(viewer.accessToken) });

    await expect(access.getByText('Vera Viewer')).toHaveCount(0);
    await expect(access.getByText('Eddie Editor')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Vera Viewer' })).toHaveCount(0);
  });
});
