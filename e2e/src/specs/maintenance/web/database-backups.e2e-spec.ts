import { LoginResponseDto } from '@frameleaf/sdk';
import { expect, Page, test } from '@playwright/test';
import { utils } from 'src/utils.js';

/**
 * FL-81 replaced the one-click restore confirmation with the design template's
 * `RestoreDialog` (design/frameleaf/template/src/Maintenance.jsx): "Restore backup" stays
 * disabled until the administrator types RESTORE. Prove the guard, then satisfy it.
 */
const confirmRestore = async (page: Page) => {
  const dialog = page.getByRole('dialog', { name: 'Restore this backup?' });
  const confirmButton = dialog.getByRole('button', { name: 'Restore backup', exact: true });

  await expect(confirmButton).toBeDisabled();
  await dialog.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
};

/**
 * FL-71: database backups are a Command Center page (the old `/admin/maintenance?isOpen=backups`
 * address redirects there). The page is shown under Backup as "Backups & restore"; its address is
 * unchanged, and nothing here depends on its heading. Maintenance mode returns to the page it was
 * started from, so the restore flows come back to that section.
 */
const databaseBackups = '/user-settings?area=maintenance&section=backups';
const backToMaintenance = '/user-settings?area=maintenance**';

test.describe.configure({ mode: 'serial' });

test.describe('Database Backups', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  // A failed test must not leave the server in maintenance mode for the tests after it.
  test.afterEach(async ({ context }) => {
    await utils.endMaintenance(context);
  });

  test('restore a backup from settings', async ({ context, page }) => {
    test.setTimeout(60_000);

    await utils.resetBackups(admin.accessToken);
    const filename = await utils.createBackup(admin.accessToken);
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(databaseBackups);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Restore this backup?' })).toContainText(filename);
    await confirmRestore(page);

    await page.waitForURL('/maintenance?**');
    await expect(page.getByRole('heading', { name: 'Maintenance is finished', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('button', { name: 'Open Frameleaf', exact: true }).click();
    await page.waitForURL(backToMaintenance, { timeout: 60_000 });
  });

  // FL-81: the restore runs on the server, so a dropped connection or a reload mid-restore picks the
  // progress back up (status is re-read on load), then offers the explicit return when the restore ends.
  test('a restore survives a dropped connection and a reload', async ({ context, page }) => {
    test.setTimeout(90_000);

    await utils.resetBackups(admin.accessToken);
    await utils.createBackup(admin.accessToken);
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(databaseBackups);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await confirmRestore(page);
    await page.waitForURL('/maintenance?**');
    // The sign-in token is stripped from the address, so a reload relies on the maintenance cookie.
    expect(new URL(page.url()).searchParams.has('token')).toBe(false);

    await context.setOffline(true);
    await page.waitForTimeout(1000);
    await context.setOffline(false);
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Maintenance is finished', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('button', { name: 'Open Frameleaf', exact: true }).click();
    await page.waitForURL(backToMaintenance, { timeout: 60_000 });
  });

  // FL-81: a backup from a newer server cannot be migrated down, so Restore stays disabled.
  test('a backup from a newer server cannot be restored', async ({ context, page }) => {
    await utils.resetBackups(admin.accessToken);
    const created = await utils.createBackup(admin.accessToken);
    await utils.setAuthCookies(context, admin.accessToken);
    const filename = created.replace(/-v.+-pg/, '-v999.0.0-pg');
    expect(filename).not.toBe(created);
    await utils.move(`/data/backups/${created}`, `/data/backups/${filename}`);

    await page.goto(databaseBackups);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore this backup?' });
    await expect(dialog.getByRole('alert')).toContainText('This backup was made by a newer server (v999.0.0)');
    await dialog.getByLabel('Type RESTORE to confirm').fill('RESTORE');
    await expect(dialog.getByRole('button', { name: 'Restore backup', exact: true })).toBeDisabled();
  });

  test('handle backup restore failure', async ({ context, page }) => {
    test.setTimeout(60_000);

    await utils.resetBackups(admin.accessToken);
    await utils.prepareTestBackup('corrupted', admin.accessToken);
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(databaseBackups);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await confirmRestore(page);

    await page.waitForURL('/maintenance?**');
    await expect(page.getByText('IM CORRUPTED')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'End maintenance' }).click();
    await expect(page.getByRole('heading', { name: 'Maintenance is finished', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Open Frameleaf', exact: true }).click();
    await page.waitForURL(backToMaintenance);
  });

  test('rollback to restore point if backup is missing admin', async ({ context, page }) => {
    test.setTimeout(90_000);

    await utils.resetBackups(admin.accessToken);
    await utils.prepareTestBackup('empty', admin.accessToken);
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(databaseBackups);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await confirmRestore(page);

    await page.waitForURL('/maintenance?**');
    await expect(page.getByText('Server health check failed, no admin exists.')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'End maintenance' }).click();
    await expect(page.getByRole('heading', { name: 'Maintenance is finished', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: 'Open Frameleaf', exact: true }).click();
    await page.waitForURL(backToMaintenance);
  });

  test('restore a backup from onboarding', async ({ context, page }) => {
    test.setTimeout(60_000);

    await utils.resetBackups(admin.accessToken);
    await utils.createBackup(admin.accessToken);
    await utils.setAuthCookies(context, admin.accessToken);

    await utils.resetDatabase();

    await page.goto('/');
    await page.getByRole('button', { name: 'Restore from backup' }).click();

    try {
      await page.waitForURL('/maintenance**');
    } catch {
      // when chained with the rest of the tests
      // this navigation may fail..? not sure why...
      await page.goto('/maintenance');
      await page.waitForURL('/maintenance**');
    }

    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await confirmRestore(page);

    await page.waitForURL('/maintenance?**');
    await expect(page.getByRole('heading', { name: 'Maintenance is finished', exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole('button', { name: 'Open Frameleaf', exact: true }).click();
    await page.waitForURL('/photos', { timeout: 60_000 });
  });
});
