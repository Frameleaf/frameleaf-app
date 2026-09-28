import { LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

test.describe.configure({ mode: 'serial' });

test.describe('Maintenance', () => {
  let admin: LoginResponseDto;
  // Set by a test that enters maintenance mode through the API, where the browser holds no token.
  let apiToken: string | undefined;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  // A failed test must not leave the server in maintenance mode for the tests after it.
  test.afterEach(async ({ context }) => {
    await utils.endMaintenance(context, apiToken);
  });

  test('enter and exit maintenance mode', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    // FL-71: maintenance mode is the Command Center's Maintenance → Maintenance mode section.
    await page.goto('/user-settings?area=maintenance&section=mode');
    await page.getByRole('button', { name: 'Start maintenance' }).click();

    // FL-81: MaintenanceModeCard always asks for confirmation before starting maintenance mode
    // (it signs every other session out), with the prototype's optional reason, which the
    // maintenance page then shows (FL-80).
    const dialog = page.getByRole('dialog', { name: 'Start maintenance mode' });
    await dialog.getByLabel('Reason shown on the maintenance page (optional)').fill('Replacing the library disk');
    await dialog.getByRole('button', { name: 'Start maintenance' }).click();

    await expect(page.getByRole('heading', { name: 'Frameleaf is being looked after' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText('Replacing the library disk')).toBeVisible();
    await page.getByRole('button', { name: 'End maintenance' }).click();
    await page.waitForURL('**/user-settings?area=maintenance*', { timeout: 10_000 });
  });

  test('maintenance shows no options to users until they authenticate', async ({ page }) => {
    const setCookie = await utils.enterMaintenance(admin.accessToken);
    const cookie = setCookie
      ?.map((cookie) => cookie.split(';', 1)[0].split('='))
      ?.find(([name]) => name === 'immich_maintenance_token');

    expect(cookie).toBeTruthy();
    apiToken = cookie![1];

    await expect(async () => {
      await page.goto('/');
      await page.waitForURL('**/maintenance?**', {
        timeout: 1000,
      });
    }).toPass({ timeout: 10_000 });

    await expect(page.getByRole('heading', { name: 'Frameleaf is being looked after' })).toBeVisible();
    await expect(page.getByText(/Checking again in \d+ s/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'End maintenance' })).toHaveCount(0);

    await page.goto(`/maintenance?${new URLSearchParams({ token: cookie![1] })}`);
    await expect(page.getByRole('heading', { name: 'Frameleaf is being looked after' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'End maintenance' })).toBeVisible();
    await page.getByRole('button', { name: 'End maintenance' }).click();
    await page.waitForURL('**/auth/login');
  });

  // FL-81: a refused sign-in link (expired after 4 hours, or from an earlier maintenance) is reported,
  // and the token never stays in the address.
  test('a refused sign-in link says so and leaves the address', async ({ page }) => {
    const setCookie = await utils.enterMaintenance(admin.accessToken);
    apiToken = setCookie
      ?.map((cookie) => cookie.split(';', 1)[0].split('='))
      ?.find(([name]) => name === 'immich_maintenance_token')?.[1];

    await expect(async () => {
      await page.goto(`/maintenance?${new URLSearchParams({ token: 'expired.sign-in.link' })}`);
      await expect(page.getByRole('heading', { name: 'Frameleaf is being looked after' })).toBeVisible({
        timeout: 1000,
      });
    }).toPass({ timeout: 10_000 });

    await expect(page.getByRole('alert')).toContainText('This maintenance sign-in link is no longer valid.');
    await expect(page.getByRole('button', { name: 'End maintenance' })).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('token')).toBe(false);
  });
});
