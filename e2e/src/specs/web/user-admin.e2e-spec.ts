import { getUserAdmin } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/** FL-71: accounts are managed in the Command Center's Users area; `/admin/users` redirects there. */
const usersManager = '/user-settings?area=users&section=accounts';

test.describe('User Administration', () => {
  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async () => {
    await utils.resetDatabase();
  });

  test('validate admin/users link', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    // FL-71: the old address opens the Command Center's Users manager (AccountsLibraries.jsx).
    await page.goto(`/admin/users`);
    await page.waitForURL('**/user-settings?area=users&section=accounts');
    await expect(page).toHaveTitle(/Settings/);
    await expect(page.getByText('Command center / Users')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
    await expect(page.getByText('Manage profiles, features, preferences, storage and sign-in.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
  });

  test('create user', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    // Create a new user from the Users manager's heading action
    await page.goto(usersManager);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create account' });
    await dialog.getByLabel('Email').fill('user@immich.cloud');
    await dialog.getByLabel('Initial password', { exact: true }).fill('password');
    await dialog.getByLabel('Confirm password').fill('password');
    await dialog.getByLabel('Name', { exact: true }).fill('Immich User');
    await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Verify the user exists in the user list
    await expect(page.getByRole('row', { name: /user@immich\.cloud/ })).toBeVisible();
  });

  test('promote to admin', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    const user = await utils.userSetup(admin.accessToken, {
      name: 'Admin 2',
      email: 'admin2@immich.cloud',
      password: 'password',
    });

    expect(user.isAdmin).toBe(false);

    await page.goto(`${usersManager}&user=${user.userId}`);

    // FL-76: the Frameleaf account form carries the role as a select, not a switch.
    await page.getByRole('button', { name: 'Edit account', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Role')).toHaveValue('user');
    await dialog.getByLabel('Role').selectOption('admin');
    await dialog.getByRole('button', { name: 'Save account' }).click();

    await expect
      .poll(async () => {
        const userAdmin = await getUserAdmin({ id: user.userId }, { headers: asBearerAuth(admin.accessToken) });
        return userAdmin.isAdmin;
      })
      .toBe(true);
  });

  test('revoke admin access', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    const user = await utils.userSetup(admin.accessToken, {
      name: 'Admin 2',
      email: 'admin2@immich.cloud',
      password: 'password',
      isAdmin: true,
    });

    expect(user.isAdmin).toBe(true);

    await page.goto(`${usersManager}&user=${user.userId}`);

    await page.getByRole('button', { name: 'Edit account', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Role')).toHaveValue('admin');
    await dialog.getByLabel('Role').selectOption('user');
    await dialog.getByRole('button', { name: 'Save account' }).click();

    await expect
      .poll(async () => {
        const userAdmin = await getUserAdmin({ id: user.userId }, { headers: asBearerAuth(admin.accessToken) });
        return userAdmin.isAdmin;
      })
      .toBe(false);
  });
});
