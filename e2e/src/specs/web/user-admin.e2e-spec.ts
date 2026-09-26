import { createUserAdmin, getUserAdmin, getUserPinCodeStateAdmin, login, unlockAuthSession } from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/** FL-71: accounts are managed in the Command Center's Users area; `/admin/users` redirects there. */
const usersManager = '/user-settings?area=users&section=accounts';

/** FL-76: open an account's detail tab (Overview, Security, ...) from the detail's section nav. */
const openDetailTab = async (page: Page, name: string) => {
  await page.getByRole('navigation', { name: 'Detail sections' }).getByRole('button', { name, exact: true }).click();
};

/** FL-76: whether the server says the account has a PIN (never the PIN itself). */
const pinState = async (accessToken: string, id: string) => {
  const { pinCode } = await getUserPinCodeStateAdmin({ id }, { headers: asBearerAuth(accessToken) });
  return pinCode;
};

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
    await expect(page.locator('.resource-heading').getByText('Your server')).toBeVisible();
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
    await dialog.getByLabel('Email').fill('user@example.com');
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
      email: 'admin2@example.com',
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
      email: 'admin2@example.com',
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

  test.describe('FL-76 account lifecycle', () => {
    // FL-76: the create dialog takes an optional initial six-digit PIN, and the account can unlock with it.
    test('create an account with an initial PIN', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);

      await page.goto(usersManager);
      await page.getByRole('button', { name: 'Create account', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Create account' });
      await dialog.getByLabel('Name', { exact: true }).fill('PIN User');
      await dialog.getByLabel('Email').fill('pin-user@example.com');
      await dialog.getByLabel('Initial password', { exact: true }).fill('password');
      await dialog.getByLabel('Confirm password').fill('password');
      await dialog.getByLabel('Initial six-digit PIN', { exact: true }).fill('123456');
      await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // the new account's detail opens; its Security tab reports the PIN
      await expect(page.getByRole('heading', { name: 'PIN User', level: 2 })).toBeVisible();
      await openDetailTab(page, 'Security');
      await expect(page.getByText('PIN is set', { exact: true })).toBeVisible();

      const { accessToken } = await login({
        loginCredentialDto: { email: 'pin-user@example.com', password: 'password' },
      });
      // throws unless the server accepts it: the PIN given at creation unlocks the session
      await unlockAuthSession({ sessionUnlockDto: { pinCode: '123456' } }, { headers: asBearerAuth(accessToken) });
    });

    // FL-76: an administrator edits an account's quota and storage label from the edit dialog.
    test('edit the storage quota and storage label', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Quota User',
        email: 'quota-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await page.getByRole('button', { name: 'Edit account', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit account' });
      await dialog.getByLabel('Storage quota (GiB)').fill('10');
      await dialog.getByLabel('Storage label', { exact: true }).fill('quota-user');
      await expect(
        dialog.getByText(
          'Changing the label does not move existing files. Run the storage template migration separately when you are ready.',
        ),
      ).toBeVisible();
      await dialog.getByRole('button', { name: 'Save account' }).click();
      await expect(dialog).toHaveCount(0);

      await expect
        .poll(async () => {
          const { quotaSizeInBytes, storageLabel } = await getUserAdmin(
            { id: user.userId },
            { headers: asBearerAuth(admin.accessToken) },
          );
          return { quotaSizeInBytes, storageLabel };
        })
        .toEqual({ quotaSizeInBytes: 10 * 1024 ** 3, storageLabel: 'quota-user' });
    });

    // FL-76: delete keeps the account for the recovery delay (typed email to confirm); it is then
    // found under the Deleted filter and restored.
    test('delete an account with the recovery delay, find it under Deleted and restore it', async ({
      context,
      page,
    }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Leaving User',
        email: 'leaving-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await page.getByRole('button', { name: 'Delete account', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Delete account' });
      await expect(
        dialog.getByText(/Leaving User will lose access\. Their account can be restored for \d+ days?/),
      ).toBeVisible();
      const confirm = dialog.getByRole('button', { name: 'Delete account', exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type the account email to confirm').fill('leaving-user@example.com');
      await confirm.click();
      await expect(dialog).toHaveCount(0);

      await expect
        .poll(async () => {
          const { deletedAt, status } = await getUserAdmin(
            { id: user.userId },
            { headers: asBearerAuth(admin.accessToken) },
          );
          return { deleted: !!deletedAt, status };
        })
        .toEqual({ deleted: true, status: 'deleted' });

      // the default list shows active accounts; the Deleted filter finds this one
      await page.goto(usersManager);
      const table = page.getByRole('region', { name: 'Account table' });
      await expect(table.getByRole('link', { name: /leaving-user@immich\.cloud/ })).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Filter records' }).selectOption('deleted');
      await table.getByRole('link', { name: /leaving-user@immich\.cloud/ }).click();

      await page.getByRole('button', { name: 'Restore account', exact: true }).click();
      const restore = page.getByRole('dialog', { name: 'Restore Leaving User' });
      await restore.getByRole('button', { name: 'Restore account', exact: true }).click();
      await expect(restore).toHaveCount(0);

      await expect
        .poll(async () => {
          const { deletedAt, status } = await getUserAdmin(
            { id: user.userId },
            { headers: asBearerAuth(admin.accessToken) },
          );
          return { deleted: !!deletedAt, status };
        })
        .toEqual({ deleted: false, status: 'active' });
    });

    // FL-76: resetting a password issues a temporary one, shown once, that signs the account in.
    test('reset an account password', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Forgetful User',
        email: 'forgetful-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await openDetailTab(page, 'Security');
      await page.getByRole('button', { name: 'Reset password', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Reset password' });
      await dialog.getByRole('button', { name: 'Generate temporary password' }).click();

      const issued = dialog.getByLabel('Temporary password', { exact: true });
      await expect(issued).toBeVisible();
      const issuedText = await issued.textContent();
      const temporary = issuedText?.trim() ?? '';
      expect(temporary.length).toBeGreaterThan(0);
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      const session = await login({
        loginCredentialDto: { email: 'forgetful-user@example.com', password: temporary },
      });
      expect(session.shouldChangePassword).toBe(true);
    });

    // FL-76: an administrator sets a PIN (entered twice) and resets it from the Security tab.
    test('set and reset an account PIN', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'PIN Reset User',
        email: 'pin-reset-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await openDetailTab(page, 'Security');
      await expect(page.getByText('No PIN set', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'Set PIN', exact: true }).click();
      const setDialog = page.getByRole('dialog', { name: 'Set PIN' });
      await setDialog.getByLabel('New six-digit PIN', { exact: true }).fill('246810');
      await setDialog.getByLabel('Confirm six-digit PIN', { exact: true }).fill('246810');
      await setDialog.getByRole('button', { name: 'Set PIN', exact: true }).click();
      await expect(setDialog).toHaveCount(0);
      await expect(page.getByText('PIN is set', { exact: true })).toBeVisible();
      await expect.poll(() => pinState(admin.accessToken, user.userId)).toBe(true);

      await page.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      const resetDialog = page.getByRole('dialog', { name: 'Reset PIN' });
      await resetDialog.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      await expect(resetDialog).toHaveCount(0);
      await expect(page.getByText('No PIN set', { exact: true })).toBeVisible();
      await expect.poll(() => pinState(admin.accessToken, user.userId)).toBe(false);
    });

    // FL-76: an account created with a PIN through the API shows it on the Security tab, and the reset clears it.
    test('reset the PIN of an account created with one', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const created = await createUserAdmin(
        {
          userAdminCreateDto: {
            name: 'Created PIN User',
            email: 'created-pin-user@example.com',
            password: 'password',
            pinCode: '123456',
          },
        },
        { headers: asBearerAuth(admin.accessToken) },
      );

      await page.goto(`${usersManager}&user=${created.id}`);
      await openDetailTab(page, 'Security');
      await expect(page.getByText('PIN is set', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Reset PIN' });
      await dialog.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => pinState(admin.accessToken, created.id)).toBe(false);
    });
  });
});
