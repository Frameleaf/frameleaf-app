import { faker } from '@faker-js/faker';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * Support Frameleaf (FL-157, FL-170, FL-172, CLD-004) against a mocked server: the account site's
 * one-time link code redeemed by the server, old links with a key never used and stripped, activation
 * of a pasted key through the request body only, the activated card, and the "not available yet"
 * state without a store. No key is ever in a request address, a referrer, a console line or a
 * history entry.
 */
const KEY = 'FL-IC8Q-BT2Q-8EL6';
const CODE = 'flc_jf23qnbc4wvmpnuogenclb2hyo';

const products = (storeUrl: string | null) => ({
  currency: 'USD',
  licensedDiscount: 0.2,
  pricesVersion: '2026-09-25.1',
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

/**
 * Watch everything that could carry a secret: every request URL and Referer, every console line,
 * and every history entry (read by walking back through the session history at the end).
 */
const watch = (page: Page) => {
  const requests: { url: string; referer: string; navigation: boolean; body: string | null }[] = [];
  const logs: string[] = [];
  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      referer: request.headers()['referer'] ?? '',
      navigation: request.isNavigationRequest(),
      body: request.postData(),
    });
  });
  page.on('console', (message) => {
    logs.push(message.text());
  });
  return { requests, logs };
};

/**
 * The server sends the /link page with `Referrer-Policy: no-referrer` (ApiService.ssr, unit tested
 * in api.service.spec.ts); the web build these mocked specs run against has no server, so add it the
 * same way here. Requests the page makes itself are also covered by the early policy in app.html.
 */
const serveLinkLikeTheServer = (context: BrowserContext) =>
  context.route(
    (url) => url.pathname === '/link',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'referrer-policy': 'no-referrer' } });
    },
  );

const historyEntries = async (page: Page) => {
  const entries = [page.url()];
  for (let step = 0; step < 5; step++) {
    const length = await page.evaluate(() => history.length);
    if (length <= 1) {
      break;
    }
    let moved;
    try {
      moved = await page.goBack({ waitUntil: 'commit' });
    } catch {
      moved = null;
    }
    if (!moved) {
      break;
    }
    entries.push(page.url());
  }
  return entries;
};

test.describe.configure({ mode: 'parallel' });
test.describe('Support Frameleaf', () => {
  test('redeems a one-time link code through the server, and no key ever enters an address (CLD-004)', async ({
    context,
    page,
  }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await serveLinkLikeTheServer(context);
    const seen = watch(page);
    let redeemed: unknown;
    await context.route('**/api/license/products', (route) =>
      route.fulfill({ json: products('https://frameleaf.cloud.test/store') }),
    );
    await context.route('**/api/license/link-code', async (route, request) => {
      redeemed = request.postDataJSON();
      return route.fulfill({ json: { kind: 'individual', keyHint: '8EL6' } });
    });

    await page.goto(`/link?target=frameleaf_license&linkCode=${CODE}`);
    await expect(page).toHaveURL(/\/buy$/, { timeout: 30_000 });
    await expect.poll(() => redeemed).toEqual({ code: CODE });
    await expect(page.getByText('Thank you. Your key is active.')).toBeVisible();
    await expect(page.getByLabel('Product key')).toHaveValue('');

    // the code went out once, in a request body; after the page took it only the address it was
    // opened with (the account site's navigation) ever held it, and no referrer carried it on
    const withCode = seen.requests.filter(({ url }) => url.includes(CODE));
    expect(withCode.map(({ navigation }) => navigation)).toEqual([true]);
    expect(seen.requests.filter(({ body }) => body?.includes(CODE))).toHaveLength(1);
    for (const { url, referer, body } of seen.requests) {
      expect(url).not.toContain(KEY);
      expect(referer).not.toContain(CODE);
      expect(body ?? '').not.toContain(KEY);
    }
    for (const line of seen.logs) {
      expect(line).not.toContain(CODE);
    }
    for (const entry of await historyEntries(page)) {
      expect(entry).not.toContain(CODE);
      expect(entry).not.toContain('linkCode');
    }
  });

  for (const [name, address] of [
    ['query string', `/link?target=activate_license&licenseKey=${KEY}`],
    ['fragment', `/link#target=frameleaf_license&key=${KEY}`],
  ] as const) {
    test(`never uses a key in an old link's ${name}, strips it and asks for it to be pasted (CLD-004)`, async ({
      context,
      page,
    }) => {
      await setupBaseMockApiRoutes(context, faker.string.uuid());
      await serveLinkLikeTheServer(context);
      const seen = watch(page);
      await context.route('**/api/license/products', (route) =>
        route.fulfill({ json: products('https://frameleaf.cloud.test/store') }),
      );

      await page.goto(address);
      await expect(page).toHaveURL(/\/buy$/, { timeout: 30_000 });
      await expect(page.getByText(/keys are no longer accepted in links\. Paste your key below/)).toBeVisible();
      await expect(page.getByLabel('Product key')).toHaveValue('');

      // only the navigation that opened the old link can hold the key (a browser never sends the
      // fragment); nothing the page sent afterwards did, in an address, a referrer or a body
      const later = seen.requests.filter(({ navigation, url }) => !(navigation && url.includes('/link')));
      for (const { url, referer, body } of later) {
        expect(url).not.toContain(KEY);
        expect(referer).not.toContain(KEY);
        expect(body ?? '').not.toContain(KEY);
      }
      expect(seen.requests.some(({ url }) => url.includes('/api/license/link-code'))).toBe(false);
      expect(seen.requests.some(({ url }) => url.includes('/api/users/me/license'))).toBe(false);
      for (const line of seen.logs) {
        expect(line).not.toContain(KEY);
      }
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(KEY);
      for (const entry of await historyEntries(page)) {
        expect(entry).not.toContain(KEY);
        expect(entry).not.toContain('licenseKey');
      }
    });
  }

  test('never sends a link code that is not shaped like one, and asks for the key (CLD-004)', async ({
    context,
    page,
  }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await serveLinkLikeTheServer(context);
    const seen = watch(page);
    const invalid = CODE.toUpperCase();
    await context.route('**/api/license/products', (route) =>
      route.fulfill({ json: products('https://frameleaf.cloud.test/store') }),
    );

    await page.goto(`/link?target=frameleaf_license&linkCode=${invalid}`);
    await expect(page).toHaveURL(/\/buy$/, { timeout: 30_000 });
    await expect(
      page.getByText(/This link from your Frameleaf account isn’t valid\. Paste your key below/),
    ).toBeVisible();
    expect(seen.requests.some(({ url }) => url.includes('/api/license/link-code'))).toBe(false);
    const sent = seen.requests.filter(({ navigation }) => !navigation);
    for (const { url, referer, body } of sent) {
      expect(url).not.toContain(invalid);
      expect(referer).not.toContain(invalid);
      expect(body ?? '').not.toContain(invalid);
    }
    for (const entry of await historyEntries(page)) {
      expect(entry).not.toContain(invalid);
    }
  });

  test('activates a pasted key through the request body only', async ({ context, page }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    const seen = watch(page);
    let activation: unknown;
    await context.route('**/api/license/products', (route) =>
      route.fulfill({ json: products('https://frameleaf.cloud.test/store') }),
    );
    await context.route('**/api/users/me/license', async (route, request) => {
      if (request.method() === 'PUT') {
        activation = request.postDataJSON();
        return route.fulfill({ json: { kind: 'individual', keyHint: '8EL6', activatedAt: new Date().toISOString() } });
      }
      return route.fulfill({ status: 404, json: {} });
    });

    await page.goto('/buy');
    await page.getByLabel('Product key').fill(KEY);
    await page.getByRole('button', { name: 'Activate' }).click();
    await expect.poll(() => activation).toEqual({ key: KEY });

    for (const { url, referer } of seen.requests) {
      expect(url).not.toContain(KEY);
      expect(referer).not.toContain(KEY);
    }
    expect(seen.requests.some(({ url }) => url.includes('pay.futo.org'))).toBe(false);
    for (const entry of await historyEntries(page)) {
      expect(entry).not.toContain(KEY);
    }
  });

  test('shows plans and supporter keys with no way to buy when no store is configured', async ({ context, page }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await context.route('**/api/license/products', (route) => route.fulfill({ json: products(null) }));
    await page.goto('/buy');

    await expect(page.getByRole('heading', { name: 'Support Frameleaf' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('$99.90')).toBeVisible();
    // Two plans and two supporter keys, plus the AI credit note an administrator sees under the
    // credit packs (design/frameleaf/template/src/AuthScreens.jsx, the "AI credit" card).
    await expect(page.getByText('Purchasing isn’t available on this server yet.')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Purchase' })).toHaveCount(0);
  });
});
