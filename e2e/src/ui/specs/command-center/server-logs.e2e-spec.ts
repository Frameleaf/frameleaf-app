import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Server & updates › Advanced › Server logs (FL-893). Controlled answers stand in for the server's
 * log API (FL-870): the page's filters, what each sends to the server, and the download link. The
 * live tail is answered with an empty stream; following real lines is covered by the unit spec.
 */
const logsPage = '/user-settings?area=server&section=logs';

type Line = { id: string; at: string; worker: string; level: string; context: string; message: string };
const line = (index: number, overrides: Partial<Line> = {}): Line => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  at: `2026-11-10T09:41:${String(index).padStart(2, '0')}.000Z`,
  worker: 'microservices',
  level: 'log',
  context: 'Thumbnails',
  message: `Made previews for ${index} new photos`,
  ...overrides,
});
const LINES = [
  line(4, { level: 'error', context: 'Video conversion', message: 'Couldn’t convert VID_0001.MOV' }),
  line(3, { level: 'warn', context: 'Metadata', message: 'IMG_2041.HEIC has no date in the file' }),
  line(2, { worker: 'machine-learning', context: 'Faces', message: 'Found 2 faces in 3 photos' }),
  line(1, { worker: 'api', context: 'Sign in', message: 'Taylor signed in from Safari' }),
];

test.use({ serviceWorkers: 'block' });
test.setTimeout(60_000);
test.beforeEach(async ({ context }) => {
  await context.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort(),
  );
});

const open = async (context: BrowserContext, page: Page) => {
  const asked: URLSearchParams[] = [];
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }));
  await setupBaseMockApiRoutes(context, '11111111-1111-4111-8111-111111111111');
  await context.route('**/api/admin/logs/stream*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': heartbeat\n\n' }),
  );
  await context.route(/\/api\/admin\/logs(\?.*)?$/, (route) => {
    const search = new URL(route.request().url()).searchParams;
    asked.push(search);
    const q = search.get('q')?.toLowerCase();
    const worker = search.get('worker');
    const entries = LINES.filter(
      (entry) =>
        (!worker || entry.worker === worker) && (!q || `${entry.context} ${entry.message}`.toLowerCase().includes(q)),
    );
    return route.fulfill({ status: 200, json: { entries, nextCursor: null } });
  });
  await page.goto(logsPage);
  await expect(page.getByRole('heading', { name: 'Server logs', level: 1 })).toBeVisible({ timeout: 30_000 });
  return asked;
};
const lines = (page: Page) => page.getByRole('list', { name: 'Log lines' }).getByRole('button');

test('combines the source, the search and what to show, and clears them together', async ({ context, page }) => {
  const asked = await open(context, page);
  await expect(lines(page)).toHaveCount(4);
  await expect(lines(page).first()).toContainText('Taylor signed in from Safari');
  await expect(lines(page).last()).toContainText('Problem');

  await page.getByRole('combobox', { name: 'From' }).selectOption({ label: 'Background work' });
  await expect(lines(page)).toHaveCount(2);
  expect(asked.at(-1)?.get('worker')).toBe('microservices');

  await page.getByRole('combobox', { name: 'Show' }).selectOption({ label: 'Problems only' });
  await expect(lines(page)).toHaveCount(1);
  await expect(page.getByText('Showing 1 of 2 lines.')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search the logs' }).fill('jasper');
  await expect(page.getByText('Nothing matches “jasper” in the last 7 days')).toBeVisible();
  expect(asked.at(-1)?.get('q')).toBe('jasper');

  await page.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(lines(page)).toHaveCount(4);
  expect(asked.at(-1)?.get('q')).toBeNull();
  expect(asked.at(-1)?.get('worker')).toBeNull();
});

test('downloads the chosen span of logs as a zip', async ({ context, page }) => {
  await open(context, page);
  await context.route('**/api/admin/logs/download*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK\u0005\u0006') }),
  );
  await page.getByRole('button', { name: 'Download…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download the logs' });
  await dialog.getByRole('button', { name: 'Last 3 days' }).click();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Download', exact: true }).click(),
  ]);
  expect(download.url()).toContain('/api/admin/logs/download?hours=72');
  expect(download.suggestedFilename()).toMatch(/^frameleaf-logs-\d{4}-\d{2}-\d{2}-last-72h\.zip$/);
});
