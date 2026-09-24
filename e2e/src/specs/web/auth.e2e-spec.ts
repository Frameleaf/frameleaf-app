import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

test.describe('Registration', () => {
  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async () => {
    await utils.resetDatabase();
  });

  test('admin registration', async ({ page }) => {
    // welcome
    await page.goto('/');
    await page.getByRole('link', { name: 'Getting Started' }).click();

    // register (FL-80 prototype screen; the strength meter is advisory, the server decides)
    await expect(page).toHaveTitle(/Admin Registration/);
    await expect(page.getByRole('heading', { name: 'Create the admin account' })).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill('Immich Admin');
    await page.getByLabel('Email', { exact: true }).fill('admin@immich.app');
    await page.getByLabel('Password', { exact: true }).fill('password');
    await page.getByLabel('Confirm password', { exact: true }).fill('password');
    await page.getByRole('button', { name: 'Create account' }).click();

    // login
    await expect(page).toHaveTitle(/Login/);
    await page.goto('/auth/login?autoLaunch=0');
    await page.getByLabel('Email', { exact: true }).fill('admin@immich.app');
    await page.getByLabel('Password', { exact: true }).fill('password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // onboarding
    await expect(page).toHaveURL('/auth/onboarding');
    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('button', { name: 'Server Privacy' }).click();
    await page.getByRole('button', { name: 'User Privacy' }).click();
    await page.getByRole('button', { name: 'Storage Template' }).click();
    await page.getByRole('button', { name: 'Backups' }).click();
    await page.getByRole('button', { name: 'Mobile App' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // success
    await expect(page).toHaveURL(/\/photos(\?|$)/);
  });

  test('user registration', async ({ context, page }) => {
    const admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);

    // create user
    // FL-71: the old address opens the Command Center's Users manager.
    await page.goto('/admin/user-management');
    await page.waitForURL('**/user-settings?area=users&section=accounts');
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create account' });
    await dialog.getByLabel('Email').fill('user@immich.cloud');
    await dialog.getByLabel('Initial password').fill('password');
    await dialog.getByLabel('Confirm password').fill('password');
    await dialog.getByLabel('Name').fill('Immich User');
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog).toHaveCount(0);

    // logout
    await context.clearCookies();

    // login
    await page.goto('/auth/login?autoLaunch=0');
    await page.getByLabel('Email', { exact: true }).fill('user@immich.cloud');
    await page.getByLabel('Password', { exact: true }).fill('password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // change password (FL-80 prototype screen)
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await expect(page).toHaveURL('/auth/change-password');
    await page.getByLabel('New password', { exact: true }).fill('new-password');
    await page.getByLabel('Confirm new password', { exact: true }).fill('new-password');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    // login with new password
    await expect(page).toHaveURL('/auth/login?autoLaunch=0');
    await page.getByLabel('Email', { exact: true }).fill('user@immich.cloud');
    await page.getByLabel('Password', { exact: true }).fill('new-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    // onboarding
    await expect(page).toHaveURL('/auth/onboarding');
    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('button', { name: 'User Privacy' }).click();
    await page.getByRole('button', { name: 'Mobile App' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    // success
    await expect(page).toHaveURL(/\/photos/);
  });
});
