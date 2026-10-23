// Throwaway review captures for FL-516 (not committed).
import { expect, test, type BrowserContext } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

const OUT = process.env.REVIEW_OUT ?? '/tmp/review';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const EMMA = '22222222-2222-4222-8222-222222222222';

const emma = {
  id: EMMA,
  name: 'Emma',
  email: 'emma@example.test',
  isAdmin: false,
  avatarColor: 'pink',
  profileImagePath: '',
  profileChangedAt: new Date().toISOString(),
  quotaSizeInBytes: 200_000_000_000,
  quotaUsageInBytes: 192_400_000_000,
  storageLabel: null,
  shouldChangePassword: false,
  status: 'active',
  createdAt: '2025-03-02T10:00:00.000Z',
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  oauthId: '',
  license: null,
};

const mock = async (context: BrowserContext) => {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort(),
  );
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }));
  await setupBaseMockApiRoutes(context, ADMIN);
  await context.route('**/api/admin/users?*', (route) => route.fulfill({ json: [emma] }));
  await context.route(`**/api/admin/users/${EMMA}/preferences`, (route) =>
    route.fulfill({
      json: {
        memories: { enabled: true },
        people: { enabled: true },
        folders: { enabled: true },
        tags: { enabled: false },
        ratings: { enabled: true },
        emailNotifications: { enabled: true, albumInvite: true, albumUpdate: false },
      },
    }),
  );
  await context.route(`**/api/admin/users/${EMMA}/statistics*`, (route) =>
    route.fulfill({ json: { images: 1200, videos: 80, total: 1280 } }),
  );
  await context.route(`**/api/admin/users/${EMMA}/sessions`, (route) => route.fulfill({ json: [] }));
  await context.route('**/api/libraries*', (route) => route.fulfill({ json: [] }));
};

test('person page', async ({ context, page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mock(context);
  await page.goto(`/user-settings?area=users&user=${EMMA}`);
  await expect(page.getByRole('heading', { name: 'What they’ve turned on' })).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/person.png`, fullPage: true });
});

test('add a person', async ({ context, page }) => {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await mock(context);
  await page.goto('/user-settings?area=users&new=1');
  await expect(page.getByRole('heading', { name: 'Add a person' }).first()).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/add-person.png`, fullPage: true });
});

test('users list', async ({ context, page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await mock(context);
  await page.goto('/user-settings?area=users');
  await expect(page.getByText('Each new person starts with')).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: `${OUT}/users.png`, fullPage: true });
});
