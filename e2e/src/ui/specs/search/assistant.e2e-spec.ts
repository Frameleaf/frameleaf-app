import { expect, test, type BrowserContext } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-918: the Library Assistant search beta on /search. The server's answers are mocked: the question
 * goes to POST /assistant/ask, the grid shows why each item matched, and Classic search is one tap
 * away and saved as the person's preference.
 */
const json = (body: unknown) => ({ status: 200, contentType: 'application/json', json: body });
const ASSET = '00000000-0000-4000-8000-0000000000a1';
const SWITCH_BACK_TOKEN = '00000000-0000-4000-8000-0000000000a2';

const answer = {
  query: 'Emma by the lake',
  summary: 'Items of Emma in Lake Louise · 1 found',
  answeredBy: 'rules',
  plan: { people: ['Emma'], city: 'Lake Louise' },
  results: {
    albums: { total: 0, count: 0, items: [], facets: [] },
    assets: {
      total: 1,
      count: 1,
      items: [{ id: ASSET, originalFileName: 'lake.jpg', type: 'IMAGE', thumbhash: null }],
      facets: [],
      nextPage: null,
      nextCursor: null,
    },
  },
  reasons: [
    {
      assetId: ASSET,
      items: [
        { kind: 'person', text: 'Emma is in this photo', value: 'Emma' },
        { kind: 'place', text: 'Taken in Lake Louise', value: 'Lake Louise' },
      ],
    },
  ],
  warnings: [],
  switchBackToken: SWITCH_BACK_TOKEN,
};

const enableAssistant = async (context: BrowserContext) => {
  await context.route('**/api/server/features', (route) =>
    route.fulfill(
      json({
        smartSearch: false,
        askSearch: false,
        assistant: true,
        facialRecognition: false,
        duplicateDetection: false,
        map: true,
        reverseGeocoding: true,
        importFaces: false,
        sidecar: true,
        search: true,
        trash: true,
        oauth: false,
        oauthAutoLaunch: false,
        ocr: false,
        passwordLogin: true,
        configFile: false,
        email: false,
      }),
    ),
  );
};

test.describe('Library Assistant search (FL-918)', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, '11111111-1111-4111-8111-111111111111');
    await enableAssistant(context);
  });

  test('answers a question with why each photo matched, and switches to classic search', async ({ context, page }) => {
    const asked: unknown[] = [];
    const saved: unknown[] = [];
    const switchedBack: unknown[] = [];
    await context.route('**/api/assistant/ask', async (route) => {
      asked.push(route.request().postDataJSON());
      await route.fulfill(json(answer));
    });
    await context.route('**/api/assistant/classic', async (route) => {
      switchedBack.push(route.request().postDataJSON());
      await route.fulfill({ status: 204 });
    });
    await context.route('**/api/users/me/preferences', async (route) => {
      if (route.request().method() === 'PUT') {
        saved.push(route.request().postDataJSON());
      }
      return route.fallback();
    });

    await page.goto('/search');
    const field = page.getByRole('textbox', { name: 'Ask about your photos' });
    await expect(field).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Beta')).toBeVisible();

    await field.fill('Emma by the lake');
    await field.press('Enter');
    await expect(page.getByText('Items of Emma in Lake Louise · 1 found')).toBeVisible();
    await expect(page.getByText(/Answered with simple search/)).toBeVisible();
    const tile = page.getByRole('list', { name: 'Matching photos' }).getByRole('listitem');
    await expect(tile).toContainText('Emma');
    await expect(tile).toContainText('Lake Louise');
    expect(asked[0]).toMatchObject({ query: 'Emma by the lake' });

    await page.getByRole('radio', { name: 'Classic search' }).click();
    await expect(page.getByRole('radio', { name: 'Classic search' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => saved).toContainEqual({ search: { classic: true } });
    await expect.poll(() => switchedBack).toEqual([{ token: SWITCH_BACK_TOKEN }]);
  });
});
