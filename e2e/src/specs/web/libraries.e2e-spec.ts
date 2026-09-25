import {
  cancelLibraryScan,
  getAllLibraries,
  LoginResponseDto,
  QueueCommand,
  QueueName,
  scanLibrary,
} from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';

/** FL-78: external libraries live in the Command Center's Libraries area; `/admin/library-management` redirects there. */
const librariesArea = '/user-settings?area=libraries';
/** `Route.viewLibrary` / `Route.editLibrary` in web/src/lib/route.ts. */
const viewLibrary = (id: string) => `${librariesArea}&selected=${encodeURIComponent(`library:${id}`)}`;
const editLibrary = (id: string) => `${viewLibrary(id)}&edit=1`;

/** The selected library's detail panel (LibraryDetail.svelte). */
const libraryDetail = (page: Page, name: string) => page.getByRole('region', { name: `${name} details` });

test.describe('Libraries (FL-78)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async ({ context }) => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test.afterAll(() => {
    utils.resetTempFolder();
  });

  // FL-78: the old library management address opens the Libraries area.
  test('the old library management address opens the Libraries area', async ({ page }) => {
    await page.goto('/admin/library-management');
    await page.waitForURL('**/user-settings?area=libraries');
    await expect(page.getByRole('heading', { name: 'Libraries', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add external library', exact: true })).toBeVisible();
  });

  // FL-78: add a library with an import folder, scan it, and see the scan complete with what it found.
  test('add a library with a folder and scan it', async ({ page }) => {
    const name = 'FL-78 web add';
    utils.createImageFile(`${testAssetDir}/temp/fl78-web-add/asset.png`);

    await page.goto(librariesArea);
    await page.getByRole('button', { name: 'Add external library', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add external library' });
    await dialog.getByLabel('Library name').fill(name);
    await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
    await dialog.getByLabel('Import folders 1', { exact: true }).fill(`${testAssetDirInternal}/temp/fl78-web-add`);
    await dialog.getByRole('button', { name: 'Create library', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('External library created', { exact: true })).toBeVisible();

    // creating a library does not scan it
    const detail = libraryDetail(page, name);
    const message = detail.getByTestId('library-scan-message');
    await expect(message).toHaveText('Check folders for new, changed and missing items.');

    await detail.getByRole('button', { name: 'Scan library', exact: true }).click();
    await expect(page.getByText('Library scan queued', { exact: true })).toBeVisible();

    // the page polls while the scan moves, and settles on the completed summary
    await expect(message).toHaveText(/· 1 added · 0 missing$/, { timeout: 60_000 });
    const row = page.getByRole('region', { name: 'Library table' }).getByRole('row', { name: new RegExp(name) });
    await expect(row.getByText('Completed', { exact: true })).toBeVisible();
  });

  // FL-78: a scan of a folder that disappeared fails, names the folder, and still says so after a reload.
  test('a scan of a folder that disappeared shows a failure that survives a reload', async ({ page }) => {
    const name = 'FL-78 web vanished';
    const folder = `${testAssetDir}/temp/fl78-web-vanished`;
    utils.createImageFile(`${folder}/asset.png`);
    const library = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name,
      importPaths: [`${testAssetDirInternal}/temp/fl78-web-vanished`],
    });
    rmSync(folder, { recursive: true, force: true });

    await page.goto(viewLibrary(library.id));
    const detail = libraryDetail(page, name);
    await detail.getByRole('button', { name: 'Scan library', exact: true }).click();

    // the retrying and the final failure both open with this sentence and carry the server's error
    const failure = /^A folder could not be read, so no items were marked missing\./;
    const message = detail.getByTestId('library-scan-message');
    await expect(message).toHaveText(failure, { timeout: 60_000 });
    await expect(message).toContainText(`${testAssetDirInternal}/temp/fl78-web-vanished`);

    await page.reload();
    await expect(libraryDetail(page, name).getByTestId('library-scan-message')).toHaveText(failure);
  });

  // FL-78: editing the folders of a library whose scan is under way warns that saving stops that scan.
  test('changing folders while a scan is waiting or running warns that saving stops it', async ({ page }) => {
    const name = 'FL-78 web busy';
    utils.createImageFile(`${testAssetDir}/temp/fl78-web-busy/asset.png`);
    const library = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name,
      importPaths: [`${testAssetDirInternal}/temp/fl78-web-busy`],
    });

    // a paused library queue holds the scan in its active, waiting state for as long as the test needs
    await utils.queueCommand(admin.accessToken, QueueName.Library, { command: QueueCommand.Pause });
    try {
      await scanLibrary({ id: library.id }, { headers: asBearerAuth(admin.accessToken) });

      await page.goto(editLibrary(library.id));
      const dialog = page.getByRole('dialog', { name: 'Edit external library' });
      const warning = dialog.getByText('Saving new folders or exclusions stops the scan in progress.', {
        exact: true,
      });
      await expect(dialog.getByLabel('Import folders 1', { exact: true })).toHaveValue(
        `${testAssetDirInternal}/temp/fl78-web-busy`,
      );
      await expect(warning).toHaveCount(0);

      await dialog.getByLabel('Import folders 1', { exact: true }).fill(`${testAssetDirInternal}/temp/fl78-web-moved`);
      await expect(warning).toBeVisible();

      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      try {
        await cancelLibraryScan({ id: library.id }, { headers: asBearerAuth(admin.accessToken) });
      } catch {
        // nothing left to cancel
      }
      await utils.queueCommand(admin.accessToken, QueueName.Library, { command: QueueCommand.Empty });
      await utils.queueCommand(admin.accessToken, QueueName.Library, { command: QueueCommand.Resume });
    }
  });

  // FL-78: removal is two-stage — review, then the typed name and the acknowledgement — and the
  // original files stay on disk.
  test('remove a library in two stages and keep its original files', async ({ page }) => {
    const name = 'FL-78 web remove';
    const hostFile = `${testAssetDir}/temp/fl78-web-remove/asset.png`;
    utils.createImageFile(hostFile);
    const library = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name,
      importPaths: [`${testAssetDirInternal}/temp/fl78-web-remove`],
    });
    await utils.scan(admin.accessToken, library.id);

    await page.goto(viewLibrary(library.id));
    const detail = libraryDetail(page, name);
    await detail.getByRole('button', { name: 'Remove library', exact: true }).click();

    // stage one: the review of what the removal takes with it
    const dialog = page.getByRole('dialog', { name: 'Remove library' });
    await expect(
      dialog.getByText(`Remove ${name} and its indexed entries? The files in your source folders will remain.`, {
        exact: true,
      }),
    ).toBeVisible();

    // stage two: the typed name and the acknowledgement
    const confirm = dialog.getByRole('button', { name: 'Remove library', exact: true });
    await dialog.getByLabel('Type the library name to confirm').fill(name);
    await expect(confirm).toBeDisabled();
    await dialog
      .getByRole('checkbox', { name: 'I understand that 1 indexed items will be removed from the library.' })
      .check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Library removed · source files retained', { exact: true })).toBeVisible();
    await expect(detail).toHaveCount(0);

    await expect
      .poll(async () => {
        const libraries = await getAllLibraries({}, { headers: asBearerAuth(admin.accessToken) });
        return libraries.map(({ id }) => id);
      })
      .not.toContain(library.id);

    // the library only ever referenced the file; it is still in its folder
    expect(existsSync(hostFile)).toBe(true);
  });
});
