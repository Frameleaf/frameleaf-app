import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Support Frameleaf (FL-157, FL-170, FL-172) against a mocked server: the store relay through the
 * address fragment (never a query string, a referrer or a history entry), activation through the
 * request body only, the activated card, and the "not available yet" state without a store.
 */
const KEY = 'FL-IC8Q-BT2Q-8ELH';

const products = (storeUrl: string | null) => ({
  currency: 'USD',
  licensedDiscount: 0.2,
  storeUrl,
  credit: { minimumUsd: 20, maximumUsd: 500 },
  backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
  products: [
    ['cloud-monthly', 'plan', 'month', 9.99],
    ['cloud-annual', 'plan', 'year', 99.9],
    ['supporter-server', 'supporter', 'one-time', 100],
    ['supporter-individual', 'supporter', 'one-time', 25],
  ].map(([id, kind, period, priceUsd]) => ({
    id,
    kind,
    period,
    priceUsd,
    storeUrl: storeUrl ? `${storeUrl}?product=${id}` : null,
  })),
});

test.describe.configure({ mode: 'parallel' });
test.describe('Support Frameleaf', () => {
  test('relays a key from the fragment and activates it without it ever entering an address', async ({
    context,
    page,
  }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    const urls: string[] = [];
    const referrers: string[] = [];
    let activation: unknown;
    page.on('request', (request) => {
      urls.push(request.url());
      referrers.push(request.headers()['referer'] ?? '');
    });
    await context.route('**/api/license/products', (route) =>
      route.fulfill({ json: products('https://frameleaf.cloud.test/store') }),
    );
    await context.route('**/api/users/me/license', async (route, request) => {
      if (request.method() === 'PUT') {
        activation = request.postDataJSON();
        return route.fulfill({ json: { kind: 'individual', keyHint: '8ELH', activatedAt: new Date().toISOString() } });
      }
      return route.fulfill({ status: 404, json: {} });
    });

    await page.goto(`/link#target=frameleaf_license&key=${KEY}`);
    await expect(page).toHaveURL(/\/buy$/);
    await expect(page.getByLabel('Product key')).toHaveValue(KEY);
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect.poll(() => activation).toEqual({ key: KEY });

    const history = await page.evaluate(() => location.href);
    for (const url of [...urls, ...referrers, history]) {
      expect(url).not.toContain(KEY);
      expect(url).not.toContain('licenseKey=');
    }
    expect(urls.some((url) => url.includes('pay.futo.org'))).toBe(false);
  });

  test('shows plans and supporter keys with no way to buy when no store is configured', async ({ context, page }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await context.route('**/api/license/products', (route) => route.fulfill({ json: products(null) }));
    await page.goto('/buy');

    await expect(page.getByRole('heading', { name: 'Support Frameleaf' })).toBeVisible();
    await expect(page.getByText('$99.90')).toBeVisible();
    // Two plans and two supporter keys, plus the AI credit note an administrator sees under the
    // credit packs (design/frameleaf/template/src/AuthScreens.jsx, the "AI credit" card).
    await expect(page.getByText('Purchasing isn’t available on this server yet.')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Purchase' })).toHaveCount(0);
  });

  test('ignores the old query-string key relay', async ({ context, page }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await page.goto(`/link?target=activate_license&licenseKey=${KEY}`);
    await expect(page).not.toHaveURL(/buy/);
  });
});
