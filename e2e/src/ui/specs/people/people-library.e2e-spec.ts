import type { PeopleListItemDto } from '@immich/sdk';
import { expect, test, type BrowserContext } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

// FL-37 / FL-57: the Frameleaf People library (template/src/People.jsx `PeopleLibrary`).
const person = (id: string, name: string, assetCount: number, lastSeenAt: string): PeopleListItemDto => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  name,
  assetCount,
  lastSeenAt,
  isHidden: false,
  birthDate: null,
  thumbnailPath: '',
});

const setup = async (context: BrowserContext) => {
  await context.routeWebSocket('**/socket.io/**', () => {
    // This UI fixture has no authenticated socket session.
  });
  await setupBaseMockApiRoutes(context, '00000000-0000-4000-8000-000000000001');
  const people = [
    person('2', 'Alex', 2, '2024-01-01T00:00:00.000Z'),
    person('3', 'Blair', 9, '2023-01-01T00:00:00.000Z'),
    person('4', '', 5, '2025-01-01T00:00:00.000Z'),
  ];
  const verdicts: { method: string; body: unknown }[] = [];
  await context.route('**/api/people/*/thumbnail*', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="teal"/></svg>',
    }),
  );
  await context.route('**/api/people*', (route) =>
    route.fulfill({ json: { people, total: people.length, hidden: 0, hasNextPage: false } }),
  );
  await context.route('**/api/people/merge-suggestions', (route) =>
    route.fulfill({ json: { suggestions: [{ person: people[0], suggestion: people[2], distance: 0.3 }] } }),
  );
  await context.route('**/api/people/merge-suggestions/verdicts', (route, request) => {
    verdicts.push({ method: request.method(), body: request.postDataJSON() });
    return request.method() === 'PUT'
      ? route.fulfill({ json: { ...request.postDataJSON(), createdAt: new Date().toISOString() } })
      : route.fulfill({ status: 204 });
  });
  await context.route('**/api/assets/statistics*', (route) =>
    route.fulfill({ json: { images: 10, videos: 2, total: 12 } }),
  );
  await context.route('**/api/albums*', (route) => route.fulfill({ json: [] }));
  await context.route('**/api/albums/tree', (route) =>
    route.fulfill({ json: { collections: [], albums: [], spaces: [] } }),
  );
  await context.route('**/api/notifications*', (route) => route.fulfill({ json: [] }));
  await context.route('**/api/jobs/running', (route) =>
    route.fulfill({ json: { operations: [], memoryExports: [], queues: [], canManageQueues: false } }),
  );
  await context.route('**/api/media-operations*', (route) => route.fulfill({ json: { items: [], total: 0 } }));
  return { verdicts };
};

const names = async (page: import('@playwright/test').Page) => {
  const labels = await page.locator('.pl-card .pl-meta > button').allTextContents();
  return labels.map((name) => name.trim());
};

test('sorts the People grid by name, photo count and recently seen', async ({ context, page }) => {
  await setup(context);
  await page.goto('/people');

  await expect(page.getByText('3 people · 12 photos and videos')).toBeVisible();
  await expect(page.locator('.pl-card')).toHaveCount(3);
  expect(await names(page)).toEqual(['Alex', 'Blair', 'Add a name']);
  await expect(page.locator('.pl-card').first().getByText('2 items')).toBeVisible();

  const sort = page.getByRole('combobox', { name: 'Sort people' });
  await sort.selectOption('count');
  await expect.poll(() => names(page)).toEqual(['Blair', 'Add a name', 'Alex']);
  await sort.selectOption('recent');
  await expect.poll(() => names(page)).toEqual(['Add a name', 'Alex', 'Blair']);

  await page.getByRole('searchbox', { name: 'Find a person' }).fill('bla');
  await expect(page.locator('.pl-card')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Find a person' }).fill('nobody');
  await expect(page.getByText('No people match your search.')).toBeVisible();
});

test('stores a "not the same person" verdict and undoes it from the toast', async ({ context, page }) => {
  const { verdicts } = await setup(context);
  await page.goto('/people');

  const banner = page.getByRole('region', { name: 'Merge suggestion' });
  await expect(banner.getByText('Are these the same person?')).toBeVisible();
  await banner.getByRole('button', { name: 'No', exact: true }).click();

  await expect(banner).toHaveCount(0);
  expect(verdicts[0]).toEqual({
    method: 'PUT',
    body: {
      personId: '00000000-0000-4000-8000-000000000002',
      suggestionId: '00000000-0000-4000-8000-000000000004',
      verdict: 'different',
    },
  });

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(banner).toBeVisible();
  expect(verdicts[1]).toEqual({
    method: 'DELETE',
    body: { personId: '00000000-0000-4000-8000-000000000002', suggestionId: '00000000-0000-4000-8000-000000000004' },
  });
});
