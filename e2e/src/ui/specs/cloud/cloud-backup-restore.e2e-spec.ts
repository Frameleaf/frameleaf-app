import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import {
  CloudBackupMockState,
  MANIFESTS,
  MANIFEST_ALBUMS,
  MANIFEST_ITEMS,
  RESTORE_ID,
  RUN_ID,
  setupCloudBackupMockApiRoutes,
} from 'src/ui/mock-network/cloud-backup-network.js';
import { CloudMockState, setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';

/**
 * Settings → Frameleaf Cloud → Cloud backup → Restore (FL-164) against a mocked server: the kept backups,
 * a search of the newest one, and an item still in the library restored in place through the restore
 * dialog, after choosing the backup and how its details come back; a deleted item comes back as it was, or
 * into the restore folder from a backup made before details were recorded; a deleted album is restored and
 * an album missing items repaired; the whole library needs RESTORE typed first. Every restore is queued on
 * the server and shown as restoring.
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
    await expect(restore.getByRole('heading', { name: 'Restore', exact: true })).toBeVisible({ timeout: 30_000 });
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

  test('fills in an item’s missing details when asked', async ({ page }) => {
    await page.goto(backupPage);
    const restore = page.locator('#fc-restore-title');
    await restore
      .getByRole('row', { name: /Elk\.jpg/ })
      .getByRole('button', { name: 'Restore…' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Restore “Elk.jpg”' });
    const details = dialog.getByRole('group', { name: 'Details' });
    await expect(details.getByRole('radio', { name: /Keep current details/ })).toBeChecked();
    await details.getByRole('radio', { name: /Fill in missing details/ }).check();
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();

    await expect
      .poll(() => backup.requests.find(({ path }) => path === 'admin/cloud/backup/restore')?.body)
      .toEqual({
        manifestKey: MANIFESTS[0].key,
        scope: 'asset',
        assetIds: [MANIFEST_ITEMS[0].assetId],
        details: 'fill',
      });
  });

  test('brings a deleted item back as it was when the backup holds its details', async ({ page }) => {
    await page.goto(backupPage);
    const restore = page.locator('#fc-restore-title');
    await restore
      .getByRole('row', { name: /Campfire evening\.jpg/ })
      .getByRole('button', { name: 'Restore', exact: true })
      .click();

    await expect
      .poll(() => backup.requests.find(({ path }) => path === 'admin/cloud/backup/restore')?.body)
      .toEqual({ manifestKey: MANIFESTS[0].key, scope: 'asset', assetIds: [MANIFEST_ITEMS[2].assetId] });
  });

  test('restores a deleted album and repairs one missing items', async ({ page }) => {
    await page.goto(backupPage);
    const restore = page.locator('#fc-restore-title');
    await restore.getByRole('radio', { name: 'Albums' }).click();

    const deleted = restore.getByRole('row', { name: /Lake house weekend/ });
    await expect(deleted.getByText('84 items')).toBeVisible();
    await expect(restore.getByRole('row', { name: /Moraine Lake/ }).getByText('3 items missing')).toBeVisible();
    await deleted.getByRole('button', { name: 'Restore album' }).click();

    await expect
      .poll(() => backup.requests.find(({ path }) => path === 'admin/cloud/backup/restore')?.body)
      .toEqual({ manifestKey: MANIFESTS[0].key, scope: 'album', albumId: MANIFEST_ALBUMS[0].albumId });
    await expect(restore.getByText('Restore queued. Follow it here or in Activity.')).toBeVisible();
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

/**
 * FL-164: pause, resume and cancel a backup run and a restore in progress, on the Cloud backup page and in
 * Settings › Background work, against the mocked `admin/cloud/backup/runs/:id/*` routes.
 */
test.describe('Frameleaf Cloud backup run controls', () => {
  let backup: CloudBackupMockState;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    const cloud: CloudMockState = { state: 'linked', requests: [] };
    await setupCloudMockApiRoutes(context, cloud);
    backup = {
      configured: true,
      keyMode: 'server',
      requests: [],
      running: { state: 'running' },
      restoring: { scope: 'files', state: 'running' },
    };
    await setupCloudBackupMockApiRoutes(context, backup);
  });

  test('pauses, resumes and cancels a backup run on the Cloud backup page', async ({ page }) => {
    await page.goto(backupPage);
    const controls = page.getByRole('group', { name: 'Cloud backup controls', exact: true });
    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect(controls.getByRole('button', { name: 'Resume' })).toBeVisible();
    expect(backup.requests.some(({ path }) => path === `admin/cloud/backup/runs/${RUN_ID}/pause`)).toBe(true);

    await controls.getByRole('button', { name: 'Resume' }).click();
    await expect(controls.getByRole('button', { name: 'Pause' })).toBeVisible();

    await controls.getByRole('button', { name: 'Cancel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel Cloud backup?' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('group', { name: 'Cloud backup controls', exact: true })).toBeHidden();
    expect(backup.running).toBeNull();
  });

  test('cancels a restore from Settings › Background work', async ({ page }) => {
    await page.goto('/user-settings?area=processing&section=queues');
    const work = page.getByTestId('cloud-background-work');
    const controls = work.getByRole('group', { name: 'Restore from cloud backup controls' });
    await controls.getByRole('button', { name: 'Cancel' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel Restore from cloud backup?' });
    await expect(dialog.getByText('Files already restored stay where they are')).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep going' }).click();
    expect(backup.restoring).not.toBeNull();

    await controls.getByRole('button', { name: 'Cancel' }).click();
    await page
      .getByRole('dialog', { name: 'Cancel Restore from cloud backup?' })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(work.getByRole('group', { name: 'Restore from cloud backup controls' })).toBeHidden();
    expect(backup.requests.some(({ path }) => path === `admin/cloud/backup/runs/${RESTORE_ID}/cancel`)).toBe(true);
  });
});
