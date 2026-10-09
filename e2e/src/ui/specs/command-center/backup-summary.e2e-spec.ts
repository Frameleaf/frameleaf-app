import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';
import { analyticsReportFixture } from '../../../../../web/src/lib/frameleaf/analytics.fixture';

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort(),
  );
});

// Controlled responses qualify rendered links and role/error behavior only.
test('Command Center status links and failed-refresh recovery', async ({ context, page }) => {
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }));
  await setupBaseMockApiRoutes(context, '11111111-1111-4111-8111-111111111111');
  await setupCloudMockApiRoutes(context, { state: 'linked', requests: [] });
  await context.route('**/api/analytics?**', (route) => route.fulfill({ json: analyticsReportFixture() }));
  let failed = false;
  await context.route('**/api/admin/buddy-backup', (route) =>
    route.fulfill(
      failed
        ? { status: 503, json: {} }
        : {
            json: {
              enabled: true,
              configured: true,
              pairing: { state: 'active' },
              recoveryVerified: true,
              keyFingerprint: 'fixture',
              settings: { pausedSending: false, pausedReceiving: false },
              lastCompleteAt: null,
              lastVerifiedAt: null,
              connection: null,
              transferMbps: 0,
              hosting: { committedBytes: 1024, reservedBytes: 128, quotaBytes: 4096 },
            },
          },
    ),
  );
  await context.route('**/api/admin/cloud/backup', (route) =>
    route.fulfill(failed ? { status: 503, json: {} } : { json: { configured: true, usage: { bytes: 2048 } } }),
  );
  await page.goto('/user-settings?area=overview');
  const summary = page.getByRole('region', { name: 'Backup & hosting' });
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await expect(summary).toHaveAttribute('aria-busy', 'false');
  for (const [name, view] of [
    [/Open Backup/, 'status'],
    [/My backup · outgoing/, 'status'],
    [/Hosting for my buddy · incoming/, 'controls'],
    [/Cloud Backup/, 'cloud'],
  ] as const) {
    await expect(summary.getByRole('link', { name })).toHaveAttribute(
      'href',
      `/user-settings?area=backups&backupView=${view}`,
    );
  }
  await expect(summary.getByRole('link', { name: /Hosting for my buddy · incoming/ })).toContainText(/1(?:\.0)? KiB/);
  await expect(summary.getByRole('link', { name: /Cloud Backup/ })).toContainText(/2(?:\.0)? KiB/);
  failed = true;
  await summary.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(summary.getByRole('alert')).toBeVisible();
  await expect(summary.getByRole('link', { name: /Hosting for my buddy · incoming/ })).not.toContainText(
    /1(?:\.0)? KiB/,
  );
  await expect(summary.getByRole('link', { name: /Cloud Backup/ })).not.toContainText(/2(?:\.0)? KiB/);
  failed = false;
  await summary.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(summary.getByRole('alert')).toHaveCount(0);
  await expect(summary.getByRole('link', { name: /Cloud Backup/ })).toContainText(/2(?:\.0)? KiB/);
});

test('ordinary account has no server-wide backup summary or backup requests', async ({ context, page }) => {
  let requests = 0;
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }));
  await setupBaseMockApiRoutes(context, '11111111-1111-4111-8111-111111111111');
  await context.route('**/api/users/me', (route) =>
    route.fulfill({
      json: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'ordinary@example.test',
        name: 'Ordinary fixture',
        isAdmin: false,
        profileImagePath: '',
        avatarColor: 'orange',
      },
    }),
  );
  await context.route('**/api/analytics?**', (route) => route.fulfill({ json: analyticsReportFixture() }));
  await context.route(/\/api\/admin\/(buddy-backup|cloud\/backup)$/, (route) => {
    requests++;
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/user-settings?area=overview');
  await expect(page.getByRole('heading', { name: 'Import & protection', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page
      .getByRole('navigation', { name: 'Settings navigation' })
      .getByRole('button', { name: 'Overview', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Backup & hosting' })).toHaveCount(0);
  expect(requests).toBe(0);
});
