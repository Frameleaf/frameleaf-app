import AxeBuilder from '@axe-core/playwright';
import { LoginResponseDto } from '@frameleaf/sdk';
import { expect, Page, test, TestInfo } from '@playwright/test';
import { utils } from 'src/utils.js';

/**
 * FL-310: production Svelte pages with real session cookies and APIs. The ordinary web project
 * starts unpaired and Cloud-unlinked; these cases qualify that state, not pairing or transfers.
 * No media, recovery keys, invitations, service flags or mocked API responses are created here.
 */
const backupUrl = '/user-settings?area=backups';
const sections = ['Status', 'Cloud Backup', 'Buddy controls', 'Recover', 'How it works'];
const hostingPrivacy =
  'Hosting is encrypted storage only. Your buddy’s photos, albums and filenames never appear in your library.';
const screens = [
  { name: 'desktop-dark', viewport: { width: 1440, height: 1000 }, theme: 'dark' },
  { name: 'desktop-light', viewport: { width: 1440, height: 1000 }, theme: 'light' },
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, theme: 'dark' },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, theme: 'light' },
] as const;

const setTheme = async (page: Page, theme: 'dark' | 'light') => {
  const shell = page.locator('.frameleaf:has(.command-center)');
  await expect(shell).toBeVisible();
  if ((await shell.getAttribute('data-theme')) !== theme) {
    await page.getByRole('button', { name: `Switch to ${theme} theme`, exact: true }).click();
  }
  await expect(shell).toHaveAttribute('data-theme', theme);
};

const recordScreen = async (page: Page, info: TestInfo, name: string, selector: string) => {
  await expect(page.locator(selector)).toBeVisible();
  // Only empty/setup states are captured. Mask the account and any displayed machine identifiers.
  await info.attach(name, {
    body: await page.screenshot({
      animations: 'disabled',
      mask: [page.locator('.fl-account-button'), page.locator('.cc-account-scope'), page.locator('.identifier')],
    }),
    contentType: 'image/png',
  });
  const overflow = await page
    .locator(`html, .cc-main, ${selector}`)
    .evaluateAll((elements) =>
      elements.map((element) => ({ tag: element.tagName, overflow: element.scrollWidth - element.clientWidth })),
    );
  expect(
    overflow.filter((item) => item.overflow > 1),
    `${name}: horizontal overflow`,
  ).toEqual([]);
  const { violations } = await new AxeBuilder({ page }).include(selector).withRules(['color-contrast']).analyze();
  expect(
    violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) })),
    `${name}: text contrast`,
  ).toEqual([]);
};

const expectSummary = async (page: Page) => {
  const summary = page.getByRole('region', { name: 'Backup & hosting', exact: true });
  await expect(summary).toHaveAttribute('aria-busy', 'false');
  await expect(summary.getByRole('alert')).toHaveCount(0);
  await expect(summary.getByRole('link', { name: /^My backup · outgoing/ })).toContainText('Not paired');
  const incoming = summary.getByRole('link', { name: /^Hosting for my buddy · incoming/ });
  await expect(incoming).toContainText('Not configured');
  await expect(incoming).toContainText('0 B encrypted');
  await expect(summary.getByRole('link', { name: /^Cloud Backup/ })).toContainText('Not configured');
  await expect(summary.getByText(hostingPrivacy, { exact: true })).toBeVisible();
  await expect(summary.locator('img, video, canvas')).toHaveCount(0);
  await incoming.scrollIntoViewIfNeeded();
  return summary;
};

test.describe('Buddy Backup production Command Center (FL-310)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(() => {
    utils.initSdk();
  });

  test.beforeEach(async ({ context, page }) => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.setAuthCookies(context, admin.accessToken);
    // Assert the real starting state; do not manufacture or silently skip an incompatible server.
    const response = await page.request.get('/api/admin/buddy-backup');
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: false,
      settings: null,
      pairing: null,
      keyFingerprint: null,
      recoveryVerified: false,
      lastCompleteAt: null,
      hosting: { committedBytes: 0, reservedBytes: 0, quotaBytes: 0 },
    });
    const cloud = await page.request.get('/api/admin/cloud/status');
    expect(cloud.status()).toBe(200);
    expect(await cloud.json()).toMatchObject({ state: 'unlinked', account: null });
  });

  for (const screen of screens) {
    test(`${screen.name}: unpaired setup, both summaries and recovery remain readable`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await page.setViewportSize(screen.viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto('/user-settings?area=overview');
      await expect(page.getByRole('heading', { level: 1, name: 'Overview', exact: true })).toBeVisible();
      await setTheme(page, screen.theme);
      const summary = await expectSummary(page);
      await recordScreen(page, info, `${screen.name}-overview`, '.backup-summary');

      const openBackup = summary.getByRole('link', { name: 'Open Backup', exact: true });
      await openBackup.focus();
      await openBackup.press('Enter');
      await expect(page).toHaveURL(`${backupUrl}&backupView=status`);
      await expect(page.getByRole('heading', { level: 1, name: 'Backup', exact: true })).toBeVisible();
      const navigation = page.getByRole('navigation', { name: 'Backup sections' });
      await expect(navigation.getByRole('link')).toHaveText(sections);
      await expect(navigation.getByRole('link', { name: 'Status', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      const outgoing = page.getByRole('region', { name: 'My backup', exact: true });
      const incoming = page.getByRole('region', { name: 'Hosting for my buddy', exact: true });
      await expect(outgoing.getByText('Not paired', { exact: true })).toBeVisible();
      await expect(
        outgoing.getByText('Link this Frameleaf server to your Cloud account before pairing.'),
      ).toBeVisible();
      await expect(outgoing.getByRole('button', { name: 'Set up Buddy Backup' })).toBeDisabled();
      await expect(incoming.getByText('Not configured', { exact: true })).toBeVisible();
      await expect(incoming.getByText('30 days, 12 monthly points, and the latest complete backup')).toBeVisible();
      await expect(incoming.locator('img, video, canvas')).toHaveCount(0);
      await navigation.scrollIntoViewIfNeeded();
      await recordScreen(page, info, `${screen.name}-status`, '.backup-center');
      const clippedTabs = await navigation.getByRole('link').evaluateAll((links) =>
        links
          .filter((link) => {
            const bounds = link.getBoundingClientRect();
            return bounds.left < 0 || bounds.right > innerWidth + 1 || bounds.height < 44;
          })
          .map((link) => link.textContent),
      );
      expect(clippedTabs, 'every Backup section fits and has a touch target').toEqual([]);

      // Tab reaches the final section even when the navigation wraps onto phone-width rows.
      await navigation.getByRole('link', { name: 'Recover', exact: true }).focus();
      await page.keyboard.press('Tab');
      const compare = navigation.getByRole('link', { name: 'How it works', exact: true });
      await expect(compare).toBeFocused();
      await expect(compare).toHaveCSS('outline-style', 'solid');
      await compare.press('Enter');
      await expect(compare).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { name: 'Two ways to keep a copy away from home.' })).toBeVisible();
      const cloud = page.getByRole('region', { name: 'Cloud Backup', exact: true });
      const buddy = page.getByRole('region', { name: 'Buddy Backup', exact: true });
      await expect(cloud).toContainText('Managed storage uses your chosen Cloud storage plan.');
      await expect(cloud).toContainText('Provider-side SSE-C encryption with your backup key.');
      await expect(buddy).toContainText('Independent quotas; no Frameleaf storage charge for your buddy’s disk.');
      await expect(buddy).toContainText('Both servers need active Cloud subscriptions for new backups.');
      await expect(buddy).toContainText('AES-256-GCM encryption before transmission');
      await expect(page.getByText(hostingPrivacy, { exact: true })).toBeVisible();
      await recordScreen(page, info, `${screen.name}-compare`, '.backup-center');

      await navigation.getByRole('link', { name: 'Cloud Backup', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Cloud backup is not set up', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Set up cloud backup', exact: true })).toBeDisabled();
      await recordScreen(page, info, `${screen.name}-cloud`, '.backup-center');

      await navigation.getByRole('link', { name: 'Buddy controls', exact: true }).click();
      const settings = incoming.getByRole('button', { name: 'Hosting & transfer settings', exact: true });
      await expect(settings).toBeEnabled();
      await recordScreen(page, info, `${screen.name}-controls`, '.backup-center');
      await settings.focus();
      await settings.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Hosting & transfer settings', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('data-theme', screen.theme);
      await expect(dialog.getByLabel('Dedicated hosting directory', { exact: true })).toHaveValue('');
      await expect(dialog.getByLabel('Storage to offer (GiB)', { exact: true })).toHaveValue('500');
      await expect(dialog.getByLabel('Upload limit (Mbit/s)', { exact: true })).toHaveValue('20');
      await expect(dialog.getByLabel('Download limit (Mbit/s)', { exact: true })).toHaveValue('20');
      await expect(dialog.getByRole('combobox', { name: 'Schedule', exact: true })).toHaveValue('0 2 * * *');
      await expect(dialog.getByLabel('Transfer window starts', { exact: true })).toHaveValue('00:00');
      await expect(dialog.getByLabel('Ends', { exact: true })).toHaveValue('00:00');
      await expect(dialog.getByRole('button', { name: 'Save hosting settings' })).toBeDisabled();
      await expect(dialog).not.toHaveCSS('animation-name', /fl-sheet-rise/);
      const centerOffset = await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: Math.abs(bounds.x + bounds.width / 2 - innerWidth / 2),
          y: Math.abs(bounds.y + bounds.height / 2 - innerHeight / 2),
        };
      });
      expect(centerOffset.x, 'dialog is horizontally centered').toBeLessThanOrEqual(1);
      expect(centerOffset.y, 'dialog is vertically centered').toBeLessThanOrEqual(1);
      await recordScreen(page, info, `${screen.name}-hosting-dialog`, 'dialog[open]');
      const derived = dialog.getByRole('checkbox', { name: 'Also include thumbnails and transcoded copies' });
      await derived.focus();
      await derived.press('Space');
      await expect(derived).toBeChecked();
      await expect(derived).toBeFocused();
      await recordScreen(page, info, `${screen.name}-hosting-checkbox`, 'dialog[open]');
      await derived.press('Space');
      await expect(derived).not.toBeChecked();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(settings).toBeFocused();

      await navigation.getByRole('link', { name: 'Recover', exact: true }).click();
      await expect(
        page.getByText(/Recovery needs a Cloud-authorized pairing and your verified recovery key\./),
      ).toBeVisible();
      const replacement = page.getByRole('region', { name: 'Recover on a replacement server', exact: true });
      await expect(replacement).toContainText('An active subscription is not required for recovery.');
      await expect(replacement.getByRole('link')).toHaveAttribute('href', 'https://frameleaf.cloud/buddy');
      await expect(replacement.getByRole('button', { name: 'Refresh recovery authorization' })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Start restore', exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Open Cloud restore controls' })).toBeVisible();
      await recordScreen(page, info, `${screen.name}-recover`, '.backup-center');

      if (screen.viewport.width < 768) {
        await page.getByRole('button', { name: 'Main menu', exact: true }).click();
      }
      await page
        .getByRole('navigation', { name: 'Settings navigation' })
        .getByRole('button', { name: 'Library analytics', exact: true })
        .click();
      await expect(page.getByRole('heading', { level: 1, name: 'Library analytics', exact: true })).toBeVisible();
      const analytics = await expectSummary(page);
      await expect(analytics).toContainText(
        'Server-wide operational snapshot. Independent of the library filters above.',
      );
      await expect(analytics).toContainText('Historical transfer totals are not recorded.');
      await recordScreen(page, info, `${screen.name}-analytics`, '.backup-summary');
      await analytics.getByRole('button', { name: 'Refresh', exact: true }).scrollIntoViewIfNeeded();
      await recordScreen(page, info, `${screen.name}-analytics-details`, '.backup-summary');
    });
  }

  test('an ordinary account cannot see or request server-wide Buddy status and controls', async ({ context, page }) => {
    const user = await utils.userSetup(admin.accessToken, {
      email: 'buddy-reader@example.com',
      name: 'Buddy reader',
      password: 'password',
      isAdmin: false,
    });
    await utils.setAuthCookies(context, user.accessToken);
    const buddyRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/admin/buddy-backup')) {
        buddyRequests.push(path);
      }
    });
    for (const area of ['overview', 'analytics', 'backups']) {
      await page.goto(`/user-settings?area=${area}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/^(Overview|Library analytics|Backup)$/);
      const navigation = page.getByRole('navigation', { name: 'Settings navigation' });
      await expect(navigation.getByRole('button', { name: 'Your preferences', exact: true })).toBeVisible();
      for (const name of ['Overview', 'Library analytics', 'Backup']) {
        await expect(navigation.getByRole('button', { name, exact: true })).toHaveCount(0);
      }
      await expect(page.getByRole('region', { name: 'Backup & hosting', exact: true })).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: 'Backup sections' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Hosting & transfer settings' })).toHaveCount(0);
    }
    expect(buddyRequests).toEqual([]);
    const status = await page.request.get('/api/admin/buddy-backup');
    expect(status.status()).toBe(403);
    const control = await page.request.post('/api/admin/buddy-backup/control', { data: { action: 'start' } });
    expect(control.status()).toBe(403);
  });
});
