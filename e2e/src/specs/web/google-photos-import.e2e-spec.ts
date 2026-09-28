import {
  createTakeoutArchive,
  createTakeoutImport,
  getTakeoutImport,
  uploadTakeoutArchiveChunk,
  type LoginResponseDto,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

test.describe('Google Photos import (FL-144)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('verifies staged bytes and resumes an archive after a page reload', async ({ context, page }) => {
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const bytes = Buffer.from('original-archive-bytes-for-resume');
    const name = 'takeout-001.zip';
    const takeout = await createTakeoutImport({ takeoutCreateDto: { name: 'Family export' } }, auth);
    const archive = await createTakeoutArchive(
      { id: takeout.id, takeoutArchiveCreateDto: { name, size: bytes.length } },
      auth,
    );
    await uploadTakeoutArchiveChunk(
      { id: takeout.id, archiveId: archive.id, offset: 0, body: new Blob([bytes.subarray(0, 8).toString()]) },
      { ...auth, headers: { ...auth.headers, 'Content-Type': 'application/octet-stream' } },
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/user-settings?area=backup&section=takeout&workflow=import&import=${takeout.id}`);
    const dialog = page.getByRole('dialog', { name: 'Import Google Photos' });
    await expect(dialog.getByRole('heading', { name: 'Stage' })).toBeVisible();
    await expect(dialog.getByText(name)).toBeVisible();
    await page.reload();
    await expect(dialog.getByText(name)).toBeVisible();

    const chooser = dialog.locator('input[type="file"]');
    const wrongBytes = Buffer.from(bytes);
    wrongBytes[0] = 'x'.charCodeAt(0);
    await chooser.setInputFiles({ name, mimeType: 'application/zip', buffer: wrongBytes });
    await expect(dialog.getByRole('alert')).toHaveText(
      'The selected archive differs from the one being uploaded. Select the original archive to resume.',
    );
    expect((await getTakeoutImport({ id: takeout.id }, auth)).sources[0].received).toBe(8);

    await chooser.setInputFiles({ name, mimeType: 'application/zip', buffer: bytes });
    await expect(dialog.getByRole('status')).toContainText('Archives uploaded');
    await expect
      .poll(async () => (await getTakeoutImport({ id: takeout.id }, auth)).sources[0].received)
      .toBe(bytes.length);
    await expect(dialog.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
