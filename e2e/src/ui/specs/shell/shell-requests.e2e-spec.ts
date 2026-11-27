import { faker } from '@faker-js/faker';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createDefaultTimelineConfig, generateTimelineData, TimelineData } from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupSocketMock } from 'src/ui/mock-network/socket-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';

/**
 * UI audit 2026-11-26 (FL-1786): what the app shell asks the server, counted in a real browser
 * against a mocked API. Each test names the requests it guards, so a change that makes the shell
 * ask again on every page, or twice at start-up, fails here.
 */

/** `GET /api/users/me` → `GET users/me`: the method and the path below `/api/`, without the query; ids read `:id`. */
const key = (method: string, url: string) =>
  `${method} ${new URL(url).pathname.replace(/^\/api\//, '').replaceAll(/[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}/g, ':id')}`;

const recordApi = (page: Page) => {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.resourceType() !== 'websocket') {
      seen.push(key(request.method(), request.url()));
    }
  });
  return {
    count: (name: string) => seen.filter((item) => item === name).length,
    /** The requests made since `mark`, most frequent first: `{ 'GET partners': 1 }`. */
    since: (mark: number) => {
      const counts: Record<string, number> = {};
      for (const item of seen.slice(mark)) {
        counts[item] = (counts[item] ?? 0) + 1;
      }
      return counts;
    },
    mark: () => seen.length,
    total: () => seen.length,
  };
};

/** No request for `quiet` ms: start-up and the shell's own reads have finished. */
const settled = async (page: Page, total: () => number, quiet = 1500) => {
  let last = -1;
  while (last !== total()) {
    last = total();
    await page.waitForTimeout(quiet);
  }
};

/** FL-1796: what the top bar and the rail read. A page change must not ask for any of them again. */
const SHELL_REQUESTS = [
  'GET albums/hierarchy',
  'GET partners',
  'GET notifications',
  'GET media-operations',
  'GET admin/cloud/backup',
  'GET server/library-setup/progress',
];

const album = (ownerId: string, id: string, albumName: string) => ({
  album: { id, albumName, kind: 'album', parentId: null, ownerId, albumUsers: [], icon: null },
  children: [],
});

const json = (body: unknown) => (route: Route) => route.fulfill({ json: body });

/** What the shell reads beyond `setupBaseMockApiRoutes`; anything else answers 404 and is still counted. */
const setupShellRoutes = async (context: BrowserContext) => {
  await context.route('**/api/albums/hierarchy*', json({ roots: [] }));
  await context.route('**/api/partners*', json([]));
  await context.route('**/api/media-operations*', json({ items: [], total: 0 }));
  await context.route(
    '**/api/jobs/running',
    json({ operations: [], memoryExports: [], queues: [], canManageQueues: true }),
  );
  await context.route('**/api/admin/cloud/backup', json({ activeRun: null, activeRestore: null }));
  await context.route(
    '**/api/server/library-setup/progress',
    json({
      active: false,
      phase: null,
      paused: false,
      completedAt: null,
      items: 0,
      people: 0,
      albums: 0,
      flagged: 0,
      stages: [],
    }),
  );
};

test.describe('app shell requests', () => {
  let timelineRestData: TimelineData;
  const testContext = new TimelineTestContext();

  test.beforeAll(() => {
    testContext.adminId = faker.string.uuid();
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: testContext.adminId });
  });

  test.beforeEach(async ({ context }) => {
    await context.route('**/api/**', (route) => route.fulfill({ status: 404, json: { message: 'Not mocked' } }));
    await setupBaseMockApiRoutes(context, testContext.adminId);
    await setupTimelineMockApiRoutes(
      context,
      timelineRestData,
      { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] },
      testContext,
    );
    await setupShellRoutes(context);
    await setupSocketMock(context);
  });

  // FL-1798
  test('asks for the account, its preferences, the config and the feature flags once on a cold load', async ({
    page,
  }) => {
    const api = recordApi(page);
    await page.goto('/photos');
    await expect(page.getByRole('navigation', { name: 'Library navigation' })).toBeVisible();
    await settled(page, api.total);

    test.info().annotations.push({ type: 'requests', description: JSON.stringify(api.since(0)) });
    for (const request of ['GET users/me', 'GET users/me/preferences', 'GET server/config', 'GET server/features']) {
      expect(api.count(request), request).toBe(1);
    }
  });
  // FL-1796
  test('keeps the top bar and the rail across a page change, and asks the server nothing for them', async ({
    page,
  }) => {
    const api = recordApi(page);
    await page.goto('/photos');
    const rail = page.getByRole('navigation', { name: 'Library navigation' });
    await expect(rail).toBeVisible();
    await settled(page, api.total);
    // Marks survive only on elements that are never rebuilt.
    await page.evaluate(() => {
      document.querySelector('.fl-topbar')?.setAttribute('data-kept', 'yes');
      document.querySelector('#sidebar')?.setAttribute('data-kept', 'yes');
    });

    for (const [name, path] of [
      ['Favorites', '/favorites'],
      ['Archive', '/archive'],
      ['Library', '/photos'],
    ] as const) {
      const mark = api.mark();
      await rail.getByRole('link', { name, exact: true }).click();
      await page.waitForURL((url) => url.pathname === path);
      await settled(page, api.total);

      const asked = api.since(mark);
      test.info().annotations.push({ type: `requests opening ${path}`, description: JSON.stringify(asked) });
      await expect(page.locator('.fl-topbar')).toHaveAttribute('data-kept', 'yes');
      await expect(page.locator('#sidebar')).toHaveAttribute('data-kept', 'yes');
      for (const request of SHELL_REQUESTS) {
        expect(asked[request] ?? 0, `${request} when opening ${path}`).toBe(0);
      }
    }
  });

  // FL-1796
  test('never empties the album list in the rail while a page opens', async ({ context, page }) => {
    await context.route('**/api/albums/hierarchy*', (route) =>
      route.fulfill({
        json: { roots: [album(testContext.adminId, '3f0c1c1e-0000-4000-8000-000000000001', 'Summer in the Rockies')] },
      }),
    );
    await page.goto('/photos');
    const rail = page.getByRole('navigation', { name: 'Library navigation' });
    const row = rail.getByRole('link', { name: 'Summer in the Rockies' });
    await expect(row).toBeVisible();
    // Every moment the row is missing from the rail is recorded from here on.
    await page.evaluate(() => {
      const state = globalThis as unknown as { railBlanked: boolean };
      state.railBlanked = false;
      new MutationObserver(() => {
        if (!document.querySelector('#sidebar a[data-album-id]')) {
          state.railBlanked = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });

    await rail.getByRole('link', { name: 'Favorites', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/favorites');
    await rail.getByRole('link', { name: 'Library', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/photos');
    await expect(row).toBeVisible();

    expect(await page.evaluate(() => (globalThis as unknown as { railBlanked: boolean }).railBlanked)).toBe(false);
  });

  // FL-1796: the rail used to be rebuilt with each page, which closed the phone menu.
  test('closes the phone menu when a page opens from it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/photos');
    const rail = page.locator('#sidebar');
    await expect(rail).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'Main menu' }).click();
    await expect(rail).not.toHaveAttribute('inert', '');

    await rail.getByRole('link', { name: 'Favorites', exact: true }).click();
    await page.waitForURL((url) => url.pathname === '/favorites');
    await expect(rail).toHaveAttribute('inert', '');
  });
});
