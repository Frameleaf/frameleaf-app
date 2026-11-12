import { faker } from '@faker-js/faker';
import { BrowserContext, expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-1470: Library care › Tidy up against a mocked server (FL-1469). Screenshots is turned on, its suggestions are
 * reviewed in the large view, one is kept, the rest go to the Archive, the archive is undone, and a photo is put
 * back from Tidied away. Archive automatically stays off throughout.
 */
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', json: body });

/** One page of suggestions, as the server lists them. */
const suggestionPage = (items: string[]) => ({
  total: items.length,
  items: items.map((assetId) => ({ assetId, kinds: ['screenshots'], automatic: false })),
  nextPage: null,
});

const KINDS = ['memes', 'documents', 'screenshots', 'shop', 'chat', 'slides', 'notes', 'accidental'];

const setupTidyUpMocks = async (context: BrowserContext) => {
  const ids = [faker.string.uuid(), faker.string.uuid(), faker.string.uuid()];
  const server = {
    on: false,
    automatic: false,
    waiting: [...ids],
    archived: [] as string[],
    kept: [] as string[],
    updates: [] as unknown[],
    decisions: [] as { assetIds: string[]; decision: string }[],
  };
  const kind = (id: string) => ({
    kind: id,
    enabled: id === 'screenshots' && server.on,
    strictness: 'balanced',
    automatic: id === 'screenshots' && server.automatic,
    visual: !['screenshots', 'chat', 'accidental'].includes(id),
    available: true,
    waiting: id === 'screenshots' && server.on ? server.waiting.length : 0,
    albumId: null,
  });
  const status = () => ({
    kinds: KINDS.map((id) => kind(id)),
    waiting: server.on ? server.waiting.length : 0,
    tidiedAway: server.archived.length,
    collectionId: server.on ? 'collection' : null,
  });

  await context.route('**/api/tidy-up', (route) => route.fulfill(json(status())));
  await context.route('**/api/tidy-up/kinds/*', (route) => {
    const body = route.request().postDataJSON() as { enabled?: boolean; automatic?: boolean };
    server.updates.push(body);
    server.on = body.enabled ?? server.on;
    server.automatic = body.automatic ?? server.automatic;
    return route.fulfill(json(kind('screenshots')));
  });
  await context.route('**/api/tidy-up/suggestions*', (route) =>
    route.fulfill(json(suggestionPage(server.on ? server.waiting : []))),
  );
  await context.route('**/api/tidy-up/tidied-away*', (route) => route.fulfill(json(suggestionPage(server.archived))));
  await context.route('**/api/tidy-up/decide', (route) => {
    const body = route.request().postDataJSON() as { assetIds: string[]; decision: string };
    server.decisions.push(body);
    const ids = new Set(body.assetIds);
    if (body.decision === 'archive') {
      server.archived.push(...body.assetIds);
      server.waiting = server.waiting.filter((id) => !ids.has(id));
    } else if (body.decision === 'keep') {
      server.kept.push(...body.assetIds);
      server.waiting = server.waiting.filter((id) => !ids.has(id));
      server.archived = server.archived.filter((id) => !ids.has(id));
    } else {
      server.waiting.push(...body.assetIds);
      server.archived = server.archived.filter((id) => !ids.has(id));
    }
    return route.fulfill(json({ updated: body.assetIds.length, skipped: 0 }, 201));
  });
  await context.route('**/api/assets/*', (route) =>
    route.request().method() === 'GET' && !route.request().url().includes('/thumbnail')
      ? route.fulfill(
          json({ id: 'x', originalFileName: 'Screenshot_20260611-213301.png', localDateTime: '2026-06-11T21:33:01' }),
        )
      : route.fallback(),
  );
  return { server, ids };
};

test.describe('Tidy up (FL-1470)', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('turns Screenshots on, reviews in the large view, archives, undoes and puts back', async ({ context, page }) => {
    const { server, ids } = await setupTidyUpMocks(context);
    await page.goto('/user-settings?area=care&section=tidy-up');

    await expect(page.getByRole('heading', { name: 'Choose what to tidy' })).toBeVisible();
    await page.getByRole('switch', { name: 'Look for Screenshots' }).click();
    await expect.poll(() => server.updates).toEqual([{ enabled: true }]);
    await expect(page.getByRole('heading', { name: '3 photos could go to the Archive' })).toBeVisible();

    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page).toHaveURL(/section=tidy-up-review/);

    // The large view: keep the first, step on with the keyboard.
    await page.getByRole('button', { name: 'Open in the large view' }).first().click();
    const viewer = page.getByRole('dialog', { name: 'Large view' });
    await expect(viewer.getByText('1 of 3')).toBeVisible();
    await expect(viewer.getByText('Saved as a screenshot')).toBeVisible();
    await page.keyboard.press('k');
    await expect(viewer.getByText('2 of 3')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();

    await page.getByRole('button', { name: 'Archive 2 photos' }).click();
    await expect(page.getByText('2 photos moved to the Archive')).toBeVisible();
    expect(server.decisions).toEqual([
      { assetIds: [ids[1], ids[2]], decision: 'archive' },
      { assetIds: [ids[0]], decision: 'keep' },
    ]);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Archive 2 photos' })).toBeVisible();
    await expect.poll(() => server.decisions.at(-1)).toEqual({ assetIds: [ids[1], ids[2]], decision: 'undo' });

    await page.getByRole('button', { name: 'Archive 2 photos' }).click();
    await page.getByRole('button', { name: 'See Tidied away' }).click();
    await page.getByRole('button', { name: 'Put back' }).first().click();
    await expect.poll(() => server.decisions.at(-1)).toEqual({ assetIds: [ids[1]], decision: 'keep' });
    expect(server.automatic).toBe(false);
  });
});
