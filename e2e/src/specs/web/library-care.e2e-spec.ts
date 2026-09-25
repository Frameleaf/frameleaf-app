import {
  getSummary,
  list as listMediaHealth,
  LoginResponseDto,
  MediaHealthCategory,
  MediaHealthStatus,
  reopen,
} from '@immich/sdk';
import { expect, Page, test } from '@playwright/test';
import { asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';

/**
 * Library Care (FL-69): scan → finding → candidate → review → repair → reconcile, with partial
 * failures and the administrator/owner boundary. Missing originals are made with an external library
 * whose files the test moves on disk, so the scan, the search for originals and the relink all run
 * against real files. The Missing and Damaged media tools are an administrator's (the template marks
 * both `admin: true`); an owner may still read their own findings through the API.
 */
test.describe.configure({ mode: 'serial' });

const findings = (accessToken: string, options: { allAccounts?: boolean; ownerId?: string } = {}) =>
  listMediaHealth(
    { category: MediaHealthCategory.Missing, size: 200, ...options },
    { headers: asBearerAuth(accessToken) },
  );

const findingItems = async (accessToken: string) => {
  const { buckets } = await findings(accessToken);
  return buckets.flatMap(({ items }) => items);
};

const openMissingMedia = async (page: Page) => {
  await page.goto('/user-settings?area=utilities&section=missing-media');
  await expect(page.getByRole('heading', { name: 'Missing media' })).toBeVisible();
};

test.describe('Library Care', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  const folder = `${testAssetDir}/temp/library-care`;
  const internal = `${testAssetDirInternal}/temp/library-care`;

  const scanAndWait = async (page: Page) => {
    await page.getByRole('button', { name: 'Scan again' }).click();
    await expect(page.getByRole('status')).toContainText('Scan queued');
    await expect
      .poll(
        async () => {
          const { runs } = await getSummary({}, { headers: asBearerAuth(admin.accessToken) });
          return runs.missing?.status;
        },
        { timeout: 60_000 },
      )
      .toBe('completed');
    await page.reload();
  };

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    owner = await utils.userSetup(admin.accessToken, {
      email: 'jamie@immich.cloud',
      name: 'Jamie',
      password: 'password',
    });
    utils.resetTempFolder();
    utils.createImageFile(`${folder}/Lake.png`);
    utils.createImageFile(`${folder}/Cabin.png`);
    const library = await utils.createLibrary(admin.accessToken, { ownerId: admin.userId, importPaths: [internal] });
    await utils.scan(admin.accessToken, library.id);
  });

  test.afterAll(() => {
    utils.resetTempFolder();
  });

  test('finds a moved original, relinks it to its verified copy and reconciles the finding', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    utils.createDirectory(`${folder}/moved`);
    utils.renameImageFile(`${folder}/Lake.png`, `${folder}/moved/Lake.png`);

    await openMissingMedia(page);
    await scanAndWait(page);

    // finding
    const row = page.getByRole('row', { name: /Lake\.png/ });
    await expect(row).toContainText('Missing');

    // candidate: search the library's own location for an exact copy
    await row.getByRole('checkbox', { name: 'Select Lake.png' }).check();
    await page.getByRole('button', { name: 'Locate originals' }).click();
    const locate = page.getByRole('dialog', { name: 'Choose candidate originals' });
    await locate.getByRole('checkbox').first().check();
    await locate.getByRole('button', { name: 'Search selected locations' }).click();
    await expect(locate).toContainText('exact match', { timeout: 60_000 });
    await locate.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('row', { name: /Lake\.png/ })).toContainText('Verified copy ready to relink', {
      timeout: 30_000,
    });

    // inspect: the recorded checksum and the candidate's own
    await page
      .getByRole('row', { name: /Lake\.png/ })
      .getByRole('button', { name: 'Inspect' })
      .click();
    const inspect = page.getByRole('dialog', { name: 'Lake.png' });
    await expect(inspect).toContainText(/Recorded SHA1|Recorded SHA256/);
    await expect(inspect).toContainText(`${internal}/moved/Lake.png`);
    await inspect.getByRole('button', { name: 'Done' }).first().click();

    // review → repair: a fixed set, then a durable job; a relink offers no Undo
    await page
      .getByRole('row', { name: /Lake\.png/ })
      .getByRole('checkbox')
      .check();
    await page.getByRole('button', { name: 'Relink verified matches' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm 1 item' }).click();
    const notice = page.getByRole('status');
    await expect(notice).toContainText('queued for relinking');
    await expect(notice.getByRole('button', { name: 'Undo' })).toHaveCount(0);

    // reconcile: the finding is settled and names who relinked it and from where
    await expect
      .poll(
        async () => {
          const items = await findingItems(admin.accessToken);
          return items.find(({ originalFileName }) => originalFileName === 'Lake.png')?.status;
        },
        { timeout: 60_000 },
      )
      .toBe(MediaHealthStatus.Relinked);
    await page.getByRole('combobox', { name: 'Show' }).selectOption('all');
    await page
      .getByRole('row', { name: /Lake\.png/ })
      .getByRole('button', { name: 'Inspect' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Lake.png' })).toContainText('Relinked');
    await expect(page.getByRole('dialog', { name: 'Lake.png' })).toContainText('Previous path');
  });

  test('reports a copy that vanished before the relink on its row instead of dropping it', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    utils.createDirectory(`${folder}/moved`);
    utils.renameImageFile(`${folder}/Cabin.png`, `${folder}/moved/Cabin.png`);
    await openMissingMedia(page);
    await scanAndWait(page);

    await page
      .getByRole('row', { name: /Cabin\.png/ })
      .getByRole('checkbox')
      .check();
    await page.getByRole('button', { name: 'Locate originals' }).click();
    const locate = page.getByRole('dialog', { name: 'Choose candidate originals' });
    await locate.getByRole('checkbox').first().check();
    await locate.getByRole('button', { name: 'Search selected locations' }).click();
    await expect(locate).toContainText('exact match', { timeout: 60_000 });
    await locate.getByRole('button', { name: 'Cancel' }).click();

    // the verified copy disappears between review and repair
    utils.removeImageFile(`${folder}/moved/Cabin.png`);
    await page
      .getByRole('row', { name: /Cabin\.png/ })
      .getByRole('checkbox')
      .check();
    await page.getByRole('button', { name: 'Relink verified matches' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm 1 item' }).click();

    await expect(page.getByRole('row', { name: /Cabin\.png/ })).toContainText(/could not|no longer|failed/i, {
      timeout: 60_000,
    });
    const items = await findingItems(admin.accessToken);
    const cabin = items.find(({ originalFileName }) => originalFileName === 'Cabin.png');
    expect(cabin?.status).not.toBe(MediaHealthStatus.Relinked);
  });

  test('undoes a dismissal from the notice', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openMissingMedia(page);

    await page
      .getByRole('row', { name: /Cabin\.png/ })
      .getByRole('checkbox')
      .check();
    await page.getByRole('button', { name: 'Dismiss findings' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm 1 item' }).click();
    const notice = page.getByRole('status');
    await expect(notice).toContainText('1 item updated.');
    await expect(page.getByRole('row', { name: /Cabin\.png/ })).toHaveCount(0);

    await notice.getByRole('button', { name: 'Undo' }).click();
    await expect(notice).toContainText('Last change undone.');
    await expect(page.getByRole('row', { name: /Cabin\.png/ })).toBeVisible();

    await notice.getByRole('button', { name: 'Dismiss utility message' }).click();
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('lists every account by name for an administrator and opens the Job manager', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openMissingMedia(page);

    const account = page.getByRole('combobox', { name: 'Account' });
    await expect(account.getByRole('option')).toHaveText(['All accounts', 'Immich Admin', 'Jamie']);
    await expect(account).toHaveValue('all');

    await expect(page.getByRole('region', { name: 'Other queues' })).toContainText('Duplicate groups');
    await page.getByRole('button', { name: 'View jobs' }).first().click();
    await expect(page).toHaveURL(/area=processing&section=queues/);
  });

  test('keeps an owner to their own findings and out of the administrator tools', async ({ context, page }) => {
    await utils.setAuthCookies(context, owner.accessToken);
    await page.goto('/user-settings?area=utilities&section=missing-media');
    await expect(page.getByRole('alert')).toContainText('Administrator access is required for this tool.');

    // The API holds the same line: an owner reads only their own findings and may not reopen others'.
    await expect(findings(owner.accessToken, { allAccounts: true })).rejects.toThrow();
    await expect(findings(owner.accessToken, { ownerId: admin.userId })).rejects.toThrow();
    const own = await findings(owner.accessToken);
    expect(own.total).toBe(0);
    const [adminFinding] = await findingItems(admin.accessToken);
    const { results } = await reopen(
      { mediaHealthBulkActionDto: { ids: [adminFinding.id] } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    expect(results[0]).toMatchObject({ success: false, error: 'Finding is not available' });
  });

  test('shows the Library care toggles in settings', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/user-settings?area=care&section=integrity-checks');
    for (const name of [
      'Schedule incremental health scans',
      'Verify original checksums',
      'Audit database and file references',
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await page.goto('/user-settings?area=care&section=repair');
    for (const name of [
      'Suggest Live Photo relinking',
      'Suggest recoverable RAW sources',
      'Group near-duplicates for review',
    ]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
  });
});
