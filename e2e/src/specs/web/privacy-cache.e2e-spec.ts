import { lockAssets, setUserOnboarding, shareItems, unshareItems } from '@frameleaf/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, baseUrl, utils } from 'src/utils.js';

/**
 * FL-137 (QA-101): what a browser already loaded never outlives access. The web client's service worker
 * handles every thumbnail and original request; after a share is revoked, the item is Locked, or
 * another person signs in on the same browser, the same URL must go back to the server and be refused.
 */
/** Fetches from inside the page, so the service worker and the browser's HTTP cache both apply. */
const fetchStatus = (page: Page, url: string) =>
  page.evaluate(async (target) => {
    const response = await fetch(target);
    await response.arrayBuffer();
    return response.status;
  }, url);

const thumbnail = (id: string) => `/api/assets/${id}/thumbnail`;
const original = (id: string) => `/api/assets/${id}/original`;

/** Signs out and in again from inside the page, as the web client does. */
const switchUser = (page: Page, email: string) =>
  page.evaluate(async (address) => {
    await fetch('/api/auth/logout', { method: 'POST' });
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: address, password: 'password' }),
    });
    return response.status;
  }, email);

const controlled = async (page: Page) => {
  await page.waitForFunction(() => !!navigator.serviceWorker?.controller, undefined, { timeout: 30_000 });
};

test('revocation, Locking and a new sign-in are never answered from the browser (FL-137)', async ({ browser }) => {
  test.setTimeout(120_000);
  utils.initSdk();
  await utils.resetDatabase();
  const owner = await utils.adminSetup();
  const recipient = await utils.userSetup(owner.accessToken, {
    name: 'Jamie Recipient',
    email: 'privacy-cache-recipient@example.com',
    password: 'password',
  });
  const stranger = await utils.userSetup(owner.accessToken, {
    name: 'Sam Stranger',
    email: 'privacy-cache-stranger@example.com',
    password: 'password',
  });
  for (const user of [recipient, stranger]) {
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(user.accessToken) });
  }
  const revoked = await utils.createAsset(owner.accessToken, { assetData: { filename: 'revoked-fl137.png' } });
  const locked = await utils.createAsset(owner.accessToken, { assetData: { filename: 'locked-fl137.png' } });
  const share = (assetIds: string[]) =>
    shareItems(
      { itemShareChangeDto: { assetIds, userIds: [recipient.userId] } },
      { headers: asBearerAuth(owner.accessToken) },
    );
  await share([revoked.id, locked.id]);

  const context = await browser.newContext({ baseURL: baseUrl });
  try {
    await utils.setAuthCookies(context, recipient.accessToken);
    const page = await context.newPage();
    await page.goto('/sharing?section=shared-with-you');
    await controlled(page);
    await expect(page.getByRole('region', { name: 'Shared with you' }).getByRole('listitem')).toHaveCount(2);
    for (const id of [revoked.id, locked.id]) {
      // Upload processing is asynchronous; only mutate access after the generated media is warm.
      await expect.poll(() => fetchStatus(page, thumbnail(id)), { timeout: 30_000 }).toBe(200);
      expect(await fetchStatus(page, original(id))).toBe(200);
    }

    // The owner stops sharing one item and Locks the other. The server now refuses both, and the
    // service worker must revalidate normal requests, including fresh browser HTTP-cache entries.
    await unshareItems(
      { itemShareChangeDto: { assetIds: [revoked.id], userIds: [recipient.userId] } },
      { headers: asBearerAuth(owner.accessToken) },
    );
    await lockAssets({ bulkIdsDto: { ids: [locked.id] } }, { headers: asBearerAuth(owner.accessToken) });
    for (const id of [revoked.id, locked.id]) {
      expect(await fetchStatus(page, thumbnail(id))).not.toBe(200);
      expect(await fetchStatus(page, original(id))).not.toBe(200);
    }

    // The recipient gets the first item back and loads it into the browser cache; then someone else
    // signs in on this browser. Nothing may come from either cache.
    await share([revoked.id]);
    expect(await fetchStatus(page, thumbnail(revoked.id))).toBe(200);
    expect(await fetchStatus(page, original(revoked.id))).toBe(200);
    expect(await switchUser(page, 'privacy-cache-stranger@example.com')).toBe(201);
    expect(await fetchStatus(page, thumbnail(revoked.id))).not.toBe(200);
    expect(await fetchStatus(page, original(revoked.id))).not.toBe(200);
  } finally {
    await context.close();
  }
});
