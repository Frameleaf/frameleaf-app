import { LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

test.describe.configure({ mode: 'serial' });

test.describe('Maintenance', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('enter and exit maintenance mode', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto('/admin/maintenance');
    await page.getByRole('button', { name: 'Switch to maintenance mode' }).click();

    // The Frameleaf redesign (FL-81) opens a confirmation dialog before starting maintenance
    // mode instead of acting on the first click; the legacy shell still acts immediately. Only
    // one of the two buttons below exists at a time, so this stays a no-op under the legacy shell.
    const confirmButton = page.getByRole('button', { name: 'Start maintenance mode now' });
    let needsConfirmation = false;
    try {
      needsConfirmation = await confirmButton.isVisible();
    } catch {
      // The legacy shell navigates immediately, removing the button.
    }
    if (needsConfirmation) {
      await confirmButton.click();
    }

    await expect(page.getByText('Temporarily Unavailable')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'End maintenance mode' }).click();
    await page.waitForURL('**/admin/maintenance*', { timeout: 10_000 });
  });

  test('maintenance shows no options to users until they authenticate', async ({ page }) => {
    const setCookie = await utils.enterMaintenance(admin.accessToken);
    const cookie = setCookie
      ?.map((cookie) => cookie.split(';', 1)[0].split('='))
      ?.find(([name]) => name === 'immich_maintenance_token');

    expect(cookie).toBeTruthy();

    await expect(async () => {
      await page.goto('/');
      await page.waitForURL('**/maintenance?**', {
        timeout: 1000,
      });
    }).toPass({ timeout: 10_000 });

    await expect(page.getByText('Temporarily Unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: 'End maintenance mode' })).toHaveCount(0);

    await page.goto(`/maintenance?${new URLSearchParams({ token: cookie![1] })}`);
    await expect(page.getByText('Temporarily Unavailable')).toBeVisible();
    await expect(page.getByRole('button', { name: 'End maintenance mode' })).toBeVisible();
    await page.getByRole('button', { name: 'End maintenance mode' }).click();
    await page.waitForURL('**/auth/login');
  });
});
