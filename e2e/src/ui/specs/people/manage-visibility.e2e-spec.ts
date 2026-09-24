import type { PersonResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

test('keeps a rejected unnamed visibility change retryable and returns to the directory only after confirmation', async ({
  context,
  page,
}) => {
  // This UI fixture has no authenticated socket session; keep unrelated live events local.
  await context.routeWebSocket('**/socket.io/**', () => {
    // The visibility flow uses the mocked HTTP responses below.
  });
  await setupBaseMockApiRoutes(context, '00000000-0000-4000-8000-000000000001');
  const people: PersonResponseDto[] = [
    { id: '00000000-0000-4000-8000-000000000002', name: 'Alex', isHidden: false, birthDate: null, thumbnailPath: '' },
    { id: '00000000-0000-4000-8000-000000000003', name: '', isHidden: false, birthDate: null, thumbnailPath: '' },
  ];
  const changes: unknown[] = [];
  await context.route('**/api/people/*/thumbnail*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>',
    }),
  );
  await context.route('**/api/people*', async (route, request) => {
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      changes.push(body);
      const results = body.people.map(({ id, isHidden }: { id: string; isHidden: boolean }) => {
        const success = changes.length > 1 || id === people[0].id;
        if (success) {
          people.find((person) => person.id === id)!.isHidden = isHidden;
        }
        return { id, success };
      });
      return route.fulfill({ json: results });
    }
    return route.fulfill({
      json: {
        people,
        total: people.length,
        hidden: people.filter((person) => person.isHidden).length,
        hasNextPage: false,
      },
    });
  });
  await context.route('**/api/albums*', (route) => route.fulfill({ json: [] }));
  await context.route('**/api/notifications*', (route) => route.fulfill({ json: [] }));
  // An elevated status the session privacy guard can verify: a PIN expiry and the server's clock.
  await context.route('**/api/auth/status', (route) =>
    route.fulfill({
      headers: { date: new Date().toUTCString() },
      json: {
        isElevated: true,
        password: true,
        pinCode: true,
        pinExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    }),
  );
  await context.route('**/api/albums/tree', (route) =>
    route.fulfill({ json: { collections: [], albums: [], spaces: [] } }),
  );
  await context.route('**/api/jobs/running', (route) =>
    route.fulfill({ json: { operations: [], memoryExports: [], queues: [], canManageQueues: false } }),
  );
  await context.route('**/api/media-operations*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await context.route('**/api/people/merge-suggestions', (route) => route.fulfill({ json: { suggestions: [] } }));
  await page.goto('/people/manage');
  const cards = page.locator('.pm-card');
  await expect(cards).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.pm-card .avatar .avatar').first()).toHaveCSS('width', '96px');
  await expect(page.getByTestId('sidebar-parent')).toHaveCSS('width', '0px');
  await cards.nth(0).click();
  await cards.nth(1).click();
  await page.getByRole('button', { name: 'Save changes (2)', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/people\/manage$/);
  expect(people.map(({ isHidden }) => isHidden)).toEqual([true, false]);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page).toHaveURL(/\/people$/);
  expect(changes).toEqual([
    { people: people.map(({ id }) => ({ id, isHidden: true })) },
    { people: [{ id: people[1].id, isHidden: true }] },
  ]);
  await page.goBack();
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(cards.nth(1)).toHaveAttribute('aria-pressed', 'false');
});
