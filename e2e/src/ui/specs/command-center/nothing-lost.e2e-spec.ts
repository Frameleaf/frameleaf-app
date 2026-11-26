import { faker } from '@faker-js/faker';
import { BrowserContext, expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-940: Library care › Nothing lost against a mocked server. The page opens on the answer, lists who removed
 * what, reads another chip from the server, and turns into a warning only when something can't be accounted for.
 */
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', json: body });

const MONTHS = [
  ['2026-11', 212, 4, 5, 2],
  ['2026-10', 640, 6, 8, 4],
  ['2026-09', 1105, 9, 6, 9],
  ['2026-08', 1872, 21, 12, 20],
  ['2026-07', 2410, 34, 9, 30],
  ['2026-06', 980, 11, 4, 14],
  ['2026-05', 1320, 16, 7, 11],
] as const;

const summary = (missing: number) => ({
  total: 24_968,
  states: { kept: 24_410 - missing, merged: 270, trashed: 96, removed: 192, missing },
  months: MONTHS.map(([month, added, merged, trashed, removed]) => {
    const gone = month === '2026-08' ? missing : 0;
    return {
      month,
      total: added,
      states: { kept: added - merged - trashed - removed - gone, merged, trashed, removed, missing: gone },
    };
  }),
});

const item = (overrides: Record<string, unknown>) => ({
  assetId: faker.string.uuid(),
  checksum: 'c',
  originalFileName: 'IMG_4410.HEIC',
  addedAt: '2026-11-02T18:20:00.000Z',
  addedVia: 'upload',
  state: 'removed',
  stateAt: '2026-11-13T20:42:00.000Z',
  stateBy: null,
  reason: 'deleted',
  ...overrides,
});

const setupLedgerMocks = async (context: BrowserContext, userId: string, missing = 0) => {
  const asked: string[] = [];
  const lists: Record<string, unknown[]> = {
    removed: [
      item({ stateBy: userId }),
      item({ originalFileName: 'VID_2207.MOV', reason: 'trash-expired', stateAt: '2026-11-10T03:00:00.000Z' }),
      item({ originalFileName: 'DSC_0192.ARW', reason: 'removed', addedVia: 'library-scan' }),
      item({ originalFileName: 'Beach day.jpg', stateBy: userId, addedVia: 'partner-copy' }),
    ],
    trashed: [item({ originalFileName: 'IMG_4398.HEIC', state: 'trashed', stateBy: userId, reason: null })],
    merged: [],
    missing: [
      item({ originalFileName: 'IMG_1902.HEIC', state: 'missing', reason: 'not-found' }),
      item({ originalFileName: 'IMG_1907.HEIC', state: 'missing', reason: 'not-found' }),
      item({ originalFileName: 'VID_1911.MOV', state: 'missing', reason: 'not-found' }),
    ],
  };
  await context.route('**/api/users/me/ledger?*', (route) => {
    const state = new URL(route.request().url()).searchParams.get('state') ?? '';
    asked.push(state);
    return route.fulfill(json({ items: lists[state] ?? [], nextCursor: null }));
  });
  await context.route('**/api/users/me/ledger/summary', (route) => route.fulfill(json(summary(missing))));
  return { asked };
};

test.describe('Nothing lost (FL-940)', () => {
  test('says everything is accounted for, who removed what, and by month', async ({ context, page }) => {
    const userId = faker.string.uuid();
    await setupBaseMockApiRoutes(context, userId);
    const { asked } = await setupLedgerMocks(context, userId);
    await page.goto('/user-settings?area=care&section=nothing-lost');

    const hero = page.getByRole('region', { name: 'Nothing lost' });
    await expect(
      hero.getByRole('heading', { name: 'All 24,968 photos and videos you added are accounted for' }),
    ).toBeVisible();
    await expect(hero.getByText('Can’t be accounted for')).toBeVisible();

    await expect(page.getByText('IMG_4410.HEIC')).toBeVisible();
    await expect(page.getByText(/^You deleted it/).first()).toBeVisible();
    await expect(page.getByText(/^Left the Trash when its time there ran out/)).toBeVisible();
    await expect(page.getByText(/^Found in a library folder/)).toBeVisible();

    await page.getByRole('button', { name: /^In the Trash/ }).click();
    await expect(page.getByText('IMG_4398.HEIC')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open the Trash' })).toBeVisible();
    await page.getByRole('button', { name: /^Stored once/ }).click();
    await expect(page.getByText('Nothing stored once')).toBeVisible();
    expect(asked).toEqual(['removed', 'trashed', 'merged']);

    await expect(page.getByRole('rowheader', { name: 'November 2026' })).toBeVisible();
    await page.getByRole('button', { name: 'Show earlier months' }).click();
    await expect(page.getByText('That’s every month since you started, in May 2026.')).toBeVisible();
  });

  test('turns into a warning when something can’t be accounted for, and lists it', async ({ context, page }) => {
    const userId = faker.string.uuid();
    await setupBaseMockApiRoutes(context, userId);
    await setupLedgerMocks(context, userId, 3);
    await page.goto('/user-settings?area=care&section=nothing-lost');

    const hero = page.getByRole('region', { name: 'Nothing lost' });
    await expect(hero.getByRole('heading', { name: '3 photos and videos can’t be accounted for' })).toBeVisible();
    await expect(page.getByText('IMG_1902.HEIC')).toBeVisible();
    await expect(page.getByText(/Missing since/).first()).toBeVisible();
    await expect(page.getByRole('rowheader', { name: 'August 2026' })).toBeVisible();
  });
});
