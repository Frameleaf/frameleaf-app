import { faker } from '@faker-js/faker';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  TimelineAssetConfig,
  TimelineData,
  toAssetResponseDto,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';

/**
 * FL-49: the glass search palette (`SearchPalette.jsx`, September 24 Apple-style refinements). Typed
 * operators become chips that compile to the structured search filter, the histogram narrows by date,
 * the Advanced view replaces a typed chip for the same field and ">" hands off to the command palette.
 * The search endpoints are mocked; the bodies the palette sends are what the specs assert.
 */

const JAMIE = '00000000-0000-4000-8000-000000000001';

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', json: body });

const openPalette = async (page: Page) => {
  await page.goto('/photos');
  await page.getByTestId('search-entry').click();
  const palette = page.getByRole('dialog', { name: 'Search your library' });
  await expect(palette).toBeVisible();
  return palette;
};

test.describe.configure({ mode: 'parallel' });
test.describe('search palette', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  const assets: TimelineAssetConfig[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] };
  let metadataBodies: Record<string, unknown>[] = [];

  test.beforeAll(() => {
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    for (const timeBucket of timelineRestData.buckets.values()) {
      assets.push(...timeBucket);
    }
  });

  const setupSearchRoutes = async (context: BrowserContext) => {
    await context.route('**/api/people?*', (route) =>
      route.fulfill(
        json({
          people: [
            { id: JAMIE, name: 'Jamie', thumbnailPath: '', isHidden: false, updatedAt: '2026-01-01T00:00:00.000Z' },
          ],
          total: 1,
          hidden: 0,
          hasNextPage: false,
        }),
      ),
    );
    await context.route('**/api/pets*', (route) => route.fulfill(json([])));
    await context.route('**/api/tags', (route) => route.fulfill(json([])));
    await context.route('**/api/search/suggestions*', (route) => route.fulfill(json(['Banff'])));
    await context.route('**/api/search/facets', (route) =>
      route.fulfill(
        json({
          total: 5,
          facets: [
            { fieldName: 'people', counts: [{ value: JAMIE, label: 'Jamie', count: 3 }] },
            { fieldName: 'city', counts: [{ value: 'Banff', count: 2 }] },
          ],
        }),
      ),
    );
    await context.route('**/api/search/histogram', (route) =>
      route.fulfill(
        json({
          granularity: 'month',
          total: 5,
          buckets: [
            { date: '2026-06-01', count: 2 },
            { date: '2026-08-01', count: 3 },
          ],
        }),
      ),
    );
    await context.route('**/api/search/statistics', (route) => route.fulfill(json({ total: 5 })));
    await context.route('**/api/search/metadata', async (route, request) => {
      metadataBodies.push(request.postDataJSON());
      const items = assets.slice(0, 5).map((asset) => toAssetResponseDto(asset));
      return route.fulfill(
        json({
          albums: { total: 0, count: 0, items: [], facets: [] },
          assets: { total: items.length, count: items.length, items, facets: [], nextPage: null, nextCursor: null },
        }),
      );
    });
  };

  test.beforeEach(async ({ context }) => {
    metadataBodies = [];
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
    await setupSearchRoutes(context);
  });

  test('a typed operator becomes a chip and searches with the structured filter', async ({ page }) => {
    const palette = await openPalette(page);
    const input = palette.getByRole('combobox', { name: 'Search query' });
    await input.pressSequentially('person:Jam');
    await expect(palette.getByRole('option', { name: /Jamie/ })).toBeVisible();
    await input.press('Tab');
    await expect(palette.getByRole('button', { name: 'Remove Jamie' })).toBeVisible();
    await expect
      .poll(() => metadataBodies.some((body) => JSON.stringify(body).includes(`"all":["${JAMIE}"]`)))
      .toBe(true);
    await expect(palette.getByRole('radiogroup', { name: 'Search scope' })).toContainText('5');
  });

  test('clicking a histogram bar narrows to its month', async ({ page }) => {
    const palette = await openPalette(page);
    await palette.getByRole('button', { name: /Aug 2026, 3 matches/ }).click();
    await expect(palette.getByRole('button', { name: 'Remove After 2026-07-31' })).toBeVisible();
    await expect(palette.getByRole('button', { name: 'Remove Before 2026-09-01' })).toBeVisible();
  });

  test('the Advanced view is remembered and a pick replaces the typed chip', async ({ page }) => {
    const palette = await openPalette(page);
    const input = palette.getByRole('combobox', { name: 'Search query' });
    await input.pressSequentially('type:video ');
    await expect(palette.getByRole('button', { name: 'Remove Videos' })).toBeVisible();
    await palette.getByRole('button', { name: 'Advanced filters' }).click();
    await palette
      .getByRole('complementary', { name: 'Library filters' })
      .getByRole('button', { name: /^Photos/ })
      .click();
    await expect(palette.getByRole('button', { name: 'Remove Videos' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const reopened = await openPalette(page);
    await expect(reopened.getByRole('button', { name: 'Advanced filters' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('">" hands off to the command palette and Enter shows all results', async ({ page }) => {
    let palette = await openPalette(page);
    await palette.getByRole('combobox', { name: 'Search query' }).pressSequentially('>');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await page.keyboard.press('Escape');

    palette = await openPalette(page);
    const input = palette.getByRole('combobox', { name: 'Search query' });
    await input.pressSequentially('IMG');
    await input.press('Enter');
    await expect(page).toHaveURL(/\/search\?dq=/);
  });

  test('a search reopened from the results page comes back as typed chips (FL-48, SD-12)', async ({ page }) => {
    const query = {
      version: 1,
      text: '',
      mode: 'text',
      filter: { personIds: { all: [JAMIE] }, city: { eq: 'Banff' } },
      grouping: 'all',
      view: 'photos',
    };
    await page.goto(`/search?dq=${encodeURIComponent(JSON.stringify(query))}`);
    const chips = page.locator('#search-chips');
    await expect(chips.locator('.search-chip')).toHaveCount(2);
    await page.getByTestId('search-entry').click();
    const palette = page.getByRole('dialog', { name: 'Search your library' });
    await expect(palette.getByRole('button', { name: 'Remove Jamie' })).toBeVisible();
    await expect(palette.getByRole('button', { name: 'Remove Banff' })).toBeVisible();
  });
});
