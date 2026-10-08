import { getIntegrityReportSummary, LoginResponseDto, ManualJobName, QueueName } from '@frameleaf/sdk';
import { expect, Page, test } from '@playwright/test';
import { asBearerAuth, dockerExec, utils } from 'src/utils.js';

/**
 * FL-81: the integrity checks and their report viewer against the real server — a scan, a specific
 * repair, the refresh ("Recheck findings"), pagination and deleting a whole report. The files live
 * in the server container's upload folder; other specs may leave untracked files there, so counts
 * are relative and the rows are found by path.
 */
test.describe.configure({ mode: 'serial' });

const integrity = '/user-settings?area=maintenance&section=integrity';
const untrackedReport = `${integrity}&report=untracked_file`;
const row = (page: Page, path: string) => page.getByRole('row').filter({ hasText: path });

test.describe('Integrity', () => {
  let admin: LoginResponseDto;
  let folder: string;

  const untrackedCount = async () => {
    const summary = await getIntegrityReportSummary({ headers: asBearerAuth(admin.accessToken) });
    return summary.untracked_file;
  };

  const runUntrackedCheck = async () => {
    await utils.createJob(admin.accessToken, { name: ManualJobName.IntegrityUntrackedFiles });
    await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);
  };

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    folder = `/data/upload/${admin.userId}`;
    await utils.mkFolder(folder);
  });

  test('a check run from its card counts the new untracked file', async ({ context, page }) => {
    await runUntrackedCheck();
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(integrity);

    // Each check is the prototype's card (`Maintenance.jsx:449-491`): "Last run … · n findings".
    const card = page.getByRole('article', { name: 'Untracked Files' });
    const line = card.getByText(/Last run .* · \d+ findings?/);
    const findings = async () => {
      const text = await line.textContent();
      return Number(text?.match(/(\d+) findings?/)?.[1]);
    };
    const previous = await findings();

    await utils.putTextFile('untracked', `${folder}/untracked1.png`);
    await card.getByRole('button', { name: 'Run check' }).click();

    await expect.poll(findings, { timeout: 20_000 }).toBe(previous + 1);
    await expect(card.getByRole('button', { name: 'Run check' })).toBeEnabled();
  });

  test('deleting one finding removes that file and only that finding', async ({ context, page }) => {
    await utils.putTextFile('untracked', `${folder}/untracked2.png`);
    await runUntrackedCheck();
    const before = await untrackedCount();

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(untrackedReport);
    await expect(page.getByRole('heading', { name: 'Untracked Files report' })).toBeVisible();
    await page.getByLabel('Filter findings by path').fill(`${folder}/untracked`);
    await expect(row(page, `${folder}/untracked1.png`)).toBeVisible();

    await row(page, `${folder}/untracked2.png`).getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this finding?' });
    await expect(dialog).toContainText('The file is deleted from disk.');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(row(page, `${folder}/untracked2.png`)).toHaveCount(0);
    await expect(row(page, `${folder}/untracked1.png`)).toBeVisible();
    await expect.poll(untrackedCount).toBe(before - 1);

    const { exitCode } = await dockerExec([`test -e ${folder}/untracked2.png`]).promise;
    expect(exitCode).not.toBe(0);
  });

  test('"Recheck findings" drops a finding whose file is gone', async ({ context, page }) => {
    await utils.putTextFile('untracked', `${folder}/untracked3.png`);
    await runUntrackedCheck();

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(untrackedReport);
    await page.getByLabel('Filter findings by path').fill(`${folder}/untracked3.png`);
    await expect(row(page, `${folder}/untracked3.png`)).toBeVisible();

    await utils.deleteFile(`${folder}/untracked3.png`);
    await page.getByRole('button', { name: 'Recheck findings' }).click();

    await expect(page.getByText('No findings match this filter.')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Filter findings by path').fill(`${folder}/untracked1.png`);
    await expect(row(page, `${folder}/untracked1.png`)).toBeVisible();
  });

  test('a report longer than a page loads the rest with "Load more"', async ({ context, page }) => {
    await dockerExec([`for i in $(seq 1 501); do echo untracked > ${folder}/page$i.png; done`]).promise;
    await runUntrackedCheck();
    expect(await untrackedCount()).toBeGreaterThan(500);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(untrackedReport);

    const rows = page.locator('tbody tr');
    // The report endpoint pages 500 findings at a time.
    await expect(rows).toHaveCount(500);
    await expect(page.getByText('500 findings loaded · more available')).toBeVisible();

    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(() => rows.count()).toBeGreaterThan(500);
  });

  test('deleting the report deletes every untracked file it lists', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(untrackedReport);
    await expect(page.locator('tbody tr').first()).toContainText('/data/');

    await page.getByRole('button', { name: 'Delete report' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this report?' });
    await expect(dialog).toContainText('Every file in this report is deleted from disk.');
    await dialog.getByRole('button', { name: 'Delete report' }).click();

    await expect(page.getByText('No findings.')).toBeVisible();
    await utils.waitForQueueFinish(admin.accessToken, QueueName.IntegrityCheck);
    await expect.poll(untrackedCount).toBe(0);

    const { exitCode } = await dockerExec([`test -e ${folder}/page1.png`]).promise;
    expect(exitCode).not.toBe(0);
  });
});
