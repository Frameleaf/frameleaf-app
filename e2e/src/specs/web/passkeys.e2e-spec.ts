import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { baseUrl, utils } from 'src/utils.js';

// FL-859: add, use and remove a passkey in the browser, with Chrome's virtual authenticator. The page is
// opened on localhost: the one plain http address browsers (and the server) allow passkeys on.
const local = `http://localhost:${new URL(baseUrl).port}`;
const email = 'admin@immich.app';
const password = 'admin';

const addVirtualAuthenticator = async (context: BrowserContext, page: Page) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
};

test.describe('Passkeys', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'The virtual authenticator is Chrome’s');

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    await utils.adminSetup();
  });

  test('adds a passkey, signs in with it and removes it', async ({ context, page }) => {
    await addVirtualAuthenticator(context, page);

    await page.goto(`${local}/auth/login`);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/photos/);

    await page.goto(`${local}/user-settings?area=privacy&section=passkeys`);
    await expect(page.getByRole('heading', { name: 'You don’t have a passkey yet' })).toBeVisible();
    await page.getByRole('button', { name: 'Add a passkey…' }).first().click();
    await page.getByLabel('Your password').fill(password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Name your passkey' })).toBeVisible();
    await page.getByLabel('Name').fill('Test laptop');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('“Test laptop” is added.', { exact: false })).toBeVisible();
    await expect(page.getByText('Test laptop', { exact: true })).toBeVisible();

    // signed out, the passkey signs in straight away (no password, no two-step code)
    await context.clearCookies();
    await page.goto(`${local}/auth/login`);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.waitForURL(/\/photos/);

    await page.goto(`${local}/user-settings?area=privacy&section=passkeys`);
    await page.getByRole('button', { name: 'Remove Test laptop' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
    // this browser stays signed in; the passkey no longer is one of its ways in
    await expect(page.getByText('“Test laptop” is removed. You sign in with your password again.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You don’t have a passkey any more' })).toBeVisible();
  });

  test('offers no passkey button on a plain http address that is not localhost', async ({ page }) => {
    await page.goto('/auth/login');
    await expect(page.getByText('Passkeys work only at a secure address.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);
  });
});
