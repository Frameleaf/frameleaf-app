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
    // FL-80 ON-1: the prototype's onboarding — a step rail, Next through every step, then the
    // summary's "Open Frameleaf". The server's first administrator sees all nine steps.
    await expect(page).toHaveURL('/auth/onboarding');
    await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    for (const title of [
      'Choose your language',
      'Pick a theme',
      'Server Privacy',
      'Your privacy',
      'Storage template',
      'Back up your phone',
      'Get the mobile app',
      "You're all set",
    ]) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }
    // The rail's compact progress line is visual only (aria-hidden); the panel announces the step.
    await expect(page.getByRole('paragraph').filter({ hasText: 'Step 9 of 9' })).toBeAttached();
    await page.getByRole('button', { name: 'Open Frameleaf' }).click();

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
    // FL-80 ON-1: an account on an onboarded server skips the server steps.
    await expect(page).toHaveURL('/auth/onboarding');
    for (const title of [
      'Choose your language',
      'Pick a theme',
      'Your privacy',
      'Back up your phone',
      'Get the mobile app',
      "You're all set",
    ]) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.getByRole('heading', { name: title })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Storage' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open Frameleaf' }).click();

    // success
    await expect(page).toHaveURL(/\/photos/);
  });
});
