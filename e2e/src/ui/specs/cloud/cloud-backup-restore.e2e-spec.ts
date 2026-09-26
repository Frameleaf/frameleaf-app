import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import {
  CloudBackupMockState,
  MANIFESTS,
  MANIFEST_ITEMS,
  setupCloudBackupMockApiRoutes,
} from 'src/ui/mock-network/cloud-backup-network.js';
import { CloudMockState, setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';

/**
 * Settings → Frameleaf Cloud → Cloud backup → Restore (FL-164) against a mocked server: the kept backups,
 * a search of the newest one, and an item still in the library restored in place through the restore
 * dialog, after choosing the backup; a deleted item comes back into the restore folder; the whole library
 * needs RESTORE typed first. Every restore is queued on the server and shown as restoring.
 */
const backupPage = '/user-settings?area=cloud&section=cloud-backup';

test.describe.configure({ mode: 'parallel' });
test.describe('Frameleaf Cloud backup restore', () => {
  let backup: CloudBackupMockState;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    const cloud: CloudMockState = { state: 'linked', requests: [] };
    await setupCloudMockApiRoutes(context, cloud);
    backup = { configured: true, keyMode: 'server', requests: [], restoring: null };
    await setupCloudBackupMockApiRoutes(context, backup);
  });

  test('restores an item still in the library in place from the chosen backup', async ({ page }) => {
    await page.goto(backupPage);
    const restore = page.locator('#fc-restore-title');
    await expect(restore.getByRole('heading', { name: 'Restore', exact: true })).toBeVisible();
    await expect(restore.getByText('Newest backup')).toBeVisible();

    await restore.getByRole('searchbox', { name: 'Search this backup' }).fill('elk');
    const row = restore.getByRole('row', { name: /Elk\.jpg/ });
    await expect(row.getByText('Still in the library')).toBeVisible();
    await row.getByRole('button', { name: 'Restore…' }).click();

    const dialog = page.getByRole('dialog', { name: 'Restore “Elk.jpg”' });
    await expect(dialog.getByText(/verified against its fingerprint/)).toBeVisible();
    await dialog.getByLabel('Restore from').selectOption(MANIFESTS[1].key);
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(dialog).toBeHidden();

    const request = backup.requests.find(({ path }) => path === 'admin/cloud/backup/restore');
    expect(request?.body).toEqual({
      manifestKey: MANIFESTS[1].key,
      scope: 'asset',
      assetIds: [MANIFEST_ITEMS[0].assetId],
    });
    await expect(restore.getByText('Restore queued. Follow it here or in Activity.')).toBeVisible();
  });

  test('brings a deleted item back into the restore folder without a dialog', async ({ page }) => {
    await page.goto(backupPage);
    const restore = page.locator('#fc-restore-title');
    await restore.getByRole('radio', { name: 'Deleted from the library' }).click();
    const row = restore.getByRole('row', { name: /IMG_2041\.HEIC/ });
    await expect(row.getByText('Not in the library')).toBeVisible();
    await expect(restore.getByRole('row', { name: /Elk\.jpg/ })).toBeHidden();
    await row.getByRole('button', { name: 'Restore', exact: true }).click();

    await expect
      .poll(() => backup.requests.find(({ path }) => path === 'admin/cloud/backup/restore')?.body)
      .toEqual({ manifestKey: MANIFESTS[0].key, scope: 'files', assetIds: [MANIFEST_ITEMS[1].assetId] });
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('restores the whole library only after RESTORE is typed', async ({ page }) => {
    await page.goto(backupPage);
    const restore = page.locator('#fc-restore-title');
    await restore.getByRole('radio', { name: 'Whole library' }).click();
    await expect(restore.getByText('The database comes back through maintenance')).toBeVisible();

    const start = restore.getByRole('button', { name: 'Start whole-library restore' });
    await expect(start).toBeDisabled();
    await restore.getByLabel('Type RESTORE to confirm').fill('restore');
    await expect(start).toBeEnabled();
    await start.click();

    await expect
      .poll(() => backup.requests.find(({ path }) => path === 'admin/cloud/backup/restore')?.body)
      .toEqual({ manifestKey: MANIFESTS[0].key, scope: 'library' });
  });
});
