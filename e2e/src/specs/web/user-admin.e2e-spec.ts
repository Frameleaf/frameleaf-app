import {
  createUserAdmin,
  getMyUser,
  getUserAdmin,
  getUserPinCodeStateAdmin,
  login,
  unlockAuthSession,
  updateUserAdmin,
} from '@frameleaf/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/** FL-71: accounts are managed in the Command Center's Users area; `/admin/users` redirects there. */
const usersManager = '/user-settings?area=users&section=accounts';

/** FL-516: one person is one page (About, Sign-in & security, What they've turned on); no tabs. */
const roleOf = (page: Page) => page.getByRole('group', { name: 'Role' });

/** FL-516: Add a person makes up a temporary password and shows it once. */
const addPerson = async (page: Page, name: string, email: string) => {
  await page.getByRole('button', { name: 'Add a person', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Add person', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${name} is added` })).toBeVisible();
  const shown = await page.locator('p.password code').innerText();
  return shown.trim();
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
    await expect(page.getByText('Everyone with an account, and how much space each has.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a person', exact: true })).toBeVisible();
  });

  test('create user', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    // Create a new user from the Users manager's heading action
    await page.goto(usersManager);
    const password = await addPerson(page, 'Immich User', 'user@example.com');
    expect(password.length).toBeGreaterThan(7);

    // the temporary password signs them in, and they must choose their own
    const session = await login({ loginCredentialDto: { email: 'user@example.com', password } });
    expect(session.shouldChangePassword).toBe(true);
    await page.getByRole('button', { name: 'Back to Users' }).click();
    await expect(page.getByRole('row', { name: /user@example\.com/ })).toBeVisible();
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

    // FL-516: the role is a Member / Administrator choice in About, saved with the rest of About.
    await expect(roleOf(page).getByRole('button', { name: 'Member' })).toHaveAttribute('aria-pressed', 'true');
    await roleOf(page).getByRole('button', { name: 'Administrator' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

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

    await expect(roleOf(page).getByRole('button', { name: 'Administrator' })).toHaveAttribute('aria-pressed', 'true');
    await roleOf(page).getByRole('button', { name: 'Member' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect
      .poll(async () => {
        const userAdmin = await getUserAdmin({ id: user.userId }, { headers: asBearerAuth(admin.accessToken) });
        return userAdmin.isAdmin;
      })
      .toBe(false);
  });

  test.describe('FL-76 account lifecycle', () => {
    // FL-516: Add a person no longer asks for a PIN (the prototype's page); an administrator can set
    // one right after, from Sign-in & security, and it unlocks the new account's Locked folder.
    test('add a person, then set their PIN', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);

      await page.goto(usersManager);
      const password = await addPerson(page, 'PIN User', 'pin-user@example.com');
      await page.getByRole('button', { name: 'Open their page' }).click();
      await expect(page.getByRole('heading', { name: 'PIN User', level: 2 })).toBeVisible();

      await page.getByRole('button', { name: 'Set PIN', exact: true }).click();
      const setDialog = page.getByRole('dialog', { name: 'Set PIN' });
      await setDialog.getByLabel('New six-digit PIN', { exact: true }).fill('123456');
      await setDialog.getByLabel('Confirm six-digit PIN', { exact: true }).fill('123456');
      await setDialog.getByRole('button', { name: 'Set PIN', exact: true }).click();
      await expect(page.getByText('PIN is set', { exact: true })).toBeVisible();

      const { accessToken } = await login({ loginCredentialDto: { email: 'pin-user@example.com', password } });
      await unlockAuthSession({ sessionUnlockDto: { pinCode: '123456' } }, { headers: asBearerAuth(accessToken) });
    });

    // FL-516: space and the folder name on disk are edited in place on the person's page.
    test('edit the storage quota and storage label', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Quota User',
        email: 'quota-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await page.getByLabel('Space for Quota User').selectOption('50');
      await page.getByText('Advanced', { exact: true }).click();
      await page.getByLabel('Folder name on disk', { exact: true }).fill('quota-user');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect
        .poll(async () => {
          const { quotaSizeInBytes, storageLabel } = await getUserAdmin(
            { id: user.userId },
            { headers: asBearerAuth(admin.accessToken) },
          );
          return { quotaSizeInBytes, storageLabel };
        })
        // D5: the quota field is decimal GB
        .toEqual({ quotaSizeInBytes: 50 * 1000 ** 3, storageLabel: 'quota-user' });
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
      await page.getByRole('button', { name: 'Remove this person', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Remove this person' });
      await expect(dialog.getByText(/Leaving User is signed out everywhere and can’t sign in again\./)).toBeVisible();
      const confirm = dialog.getByRole('button', { name: 'Remove this person', exact: true });
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
      const table = page.getByRole('region', { name: 'Accounts' });
      await expect(table.getByRole('link', { name: /leaving-user@example\.com/ })).toHaveCount(0);
      await page.getByRole('combobox', { name: 'Filter accounts' }).selectOption('deleted');
      await table.getByRole('link', { name: /leaving-user@example\.com/ }).click();

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
      await expect(page.getByText('PIN is set', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Reset PIN' });
      await dialog.getByRole('button', { name: 'Reset PIN', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect.poll(() => pinState(admin.accessToken, created.id)).toBe(false);
    });

    // FL-516: About saves only what changed, so a role another administrator changed while the page
    // was open is never put back by an unrelated edit.
    test('keep a role changed elsewhere when saving another field', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Stale User',
        email: 'stale-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await expect(roleOf(page).getByRole('button', { name: 'Member' })).toHaveAttribute('aria-pressed', 'true');

      // another administrator promotes the account while this page is open
      await updateUserAdmin(
        { id: user.userId, userAdminUpdateDto: { isAdmin: true } },
        { headers: asBearerAuth(admin.accessToken) },
      );

      await page.getByLabel('Name', { exact: true }).fill('Renamed User');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await expect
        .poll(async () => {
          const after = await getUserAdmin({ id: user.userId }, { headers: asBearerAuth(admin.accessToken) });
          return { name: after.name, isAdmin: after.isAdmin };
        })
        .toEqual({ name: 'Renamed User', isAdmin: true });
    });

    // FL-76: an administrator signs one of another account's devices out from its Security tab.
    test("sign out another account's device", async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Device User',
        email: 'device-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await page.locator('.account-security').getByRole('button', { name: 'Sign out', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: 'Sign out device' });
      await confirm.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(confirm).toHaveCount(0);
      await expect(page.getByText('No signed-in devices.', { exact: true })).toBeVisible();

      await expect(getMyUser({ headers: asBearerAuth(user.accessToken) })).rejects.toThrow();
      // the administrator's own session is untouched
      await getMyUser({ headers: asBearerAuth(admin.accessToken) });
    });

    // FL-76: skipping recovery removes the account at once; it never shows up to be restored.
    test('permanently delete an account, skipping recovery', async ({ context, page }) => {
      const admin = await utils.adminSetup();
      await utils.setAuthCookies(context, admin.accessToken);
      const user = await utils.userSetup(admin.accessToken, {
        name: 'Removed User',
        email: 'removed-user@example.com',
        password: 'password',
      });

      await page.goto(`${usersManager}&user=${user.userId}`);
      await page.getByRole('button', { name: 'Remove this person', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Remove this person' });
      await dialog.getByLabel('Skip recovery and permanently remove this account').check();
      await expect(
        dialog.getByText(
          'The account, its original photos and videos, and its owned library entries will be removed. This cannot be undone.',
        ),
      ).toBeVisible();
      const confirm = dialog.getByRole('button', { name: 'Permanently delete', exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('Type the account email to confirm').fill('removed-user@example.com');
      await confirm.click();
      await expect(dialog).toHaveCount(0);

      // removal is queued at once: the account is either being removed or already gone
      await expect
        .poll(async () => {
          try {
            const { status } = await getUserAdmin({ id: user.userId }, { headers: asBearerAuth(admin.accessToken) });
            return status;
          } catch {
            return 'gone';
          }
        })
        .toMatch(/^(removing|gone)$/);
      await expect(getMyUser({ headers: asBearerAuth(user.accessToken) })).rejects.toThrow();
    });
  });
});
