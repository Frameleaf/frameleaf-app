import {
  LoginResponseDto,
  deleteAssets,
  lockAssets,
  lockAuthSession,
  setUserOnboarding,
  setupPinCode,
  unlockAuthSession,
} from '@immich/sdk';
import { Page, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-34 in the browser: when the session locks — by the owner elsewhere, or when the PIN unlock
 * expires — whatever Locked media is open (the viewer, the Locked view, search results, Trash)
 * leaves the page, and nothing of it (thumbnail, name or count) stays behind.
 */

const pinCode = '246810';

/** Any element that still shows or links to the asset: a thumbnail, a preview or a viewer URL. */
const traces = (page: Page, assetId: string) => page.locator(`img[src*="${assetId}"], a[href*="${assetId}"]`);

test.describe('Locked content in the browser (FL-34)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await setupPinCode({ pinCodeSetupDto: { pinCode } }, { headers: asBearerAuth(admin.accessToken) });
  });

  /** A fresh onboarded account with one ordinary and one locked photo, its session unlocked. */
  const setup = async () => {
    const suffix = randomUUID().slice(0, 8);
    const user = await utils.userSetup(admin.accessToken, {
      email: `locked-${suffix}@example.com`,
      name: `Locked ${suffix}`,
      password: 'password',
    });
    const headers = asBearerAuth(user.accessToken);
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers });
    const plain = await utils.createAsset(user.accessToken, { assetData: { filename: `plain-${suffix}.png` } });
    const locked = await utils.createAsset(user.accessToken, { assetData: { filename: `secret-${suffix}.png` } });
    await lockAssets({ bulkIdsDto: { ids: [locked.id] } }, { headers });
    await setupPinCode({ pinCodeSetupDto: { pinCode } }, { headers });
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    return { user, headers, plain, locked, suffix };
  };

  test('closes an open viewer of a Locked item when the session locks elsewhere', async ({ context, page }) => {
    const { user, headers, locked } = await setup();
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto(`/locked/photos/${locked.id}`);
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);

    // the same session, locked from another tab or device
    await lockAuthSession({ headers });

    await expect(page).toHaveURL(/\/photos\/?$/);
    await expect(traces(page, locked.id)).toHaveCount(0);
  });

  test('empties the Locked view when the session locks, and asks for the PIN again', async ({ context, page }) => {
    const { user, headers, plain, locked } = await setup();
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/locked');
    await expect(traces(page, locked.id).first()).toBeVisible();
    await expect(traces(page, plain.id)).toHaveCount(0);

    await lockAuthSession({ headers });
    await expect(page).toHaveURL(/\/photos\/?$/);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(traces(page, locked.id)).toHaveCount(0);

    // the Locked view itself now needs the PIN again
    await page.goto('/locked');
    await expect(page).toHaveURL(/pin/);
    await expect(traces(page, locked.id)).toHaveCount(0);
  });

  test('lists what the Locked rules hide in the Locked view, badged Sensitive', async ({ context, page }) => {
    const { user, plain, locked, suffix } = await setup();
    const ruleMatch = await utils.createAsset(user.accessToken, { assetData: { filename: `rule-${suffix}.png` } });
    const [tag] = await utils.upsertTags(user.accessToken, [`Private ${suffix}`]);
    await utils.tagAssets(user.accessToken, tag.id, [ruleMatch.id]);
    await utils.updateMyPreferences(user.accessToken, { privacy: { suppression: { tagIds: [tag.id] } } });
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/locked');
    await expect(traces(page, locked.id).first()).toBeVisible();
    await expect(traces(page, ruleMatch.id).first()).toBeVisible();
    await expect(traces(page, plain.id)).toHaveCount(0);
    await expect(page.getByTitle('Sensitive')).toHaveCount(2);
  });

  test('drops what the Locked rules hide from open search results when the session locks', async ({
    context,
    page,
  }) => {
    const { user, headers, plain, locked, suffix } = await setup();
    const ruleMatch = await utils.createAsset(user.accessToken, { assetData: { filename: `rule-${suffix}.png` } });
    const [tag] = await utils.upsertTags(user.accessToken, [`Private ${suffix}`]);
    await utils.tagAssets(user.accessToken, tag.id, [ruleMatch.id]);
    await utils.updateMyPreferences(user.accessToken, { privacy: { suppression: { tagIds: [tag.id] } } });
    await utils.setAuthCookies(context, user.accessToken);

    // every name shares the suffix, so one search finds what this unlocked session may see
    await page.goto(`/search?query=${encodeURIComponent(JSON.stringify({ originalFileName: suffix }))}`);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(traces(page, ruleMatch.id).first()).toBeVisible();
    await expect(traces(page, locked.id)).toHaveCount(0);

    await lockAuthSession({ headers });
    await expect(traces(page, ruleMatch.id)).toHaveCount(0);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(page.getByText(`rule-${suffix}`)).toHaveCount(0);
    await expect(page.getByText(`Private ${suffix}`)).toHaveCount(0);
  });

  test('drops a trashed Locked item from Trash when the session locks', async ({ context, page }) => {
    const { user, headers, plain, locked } = await setup();
    await deleteAssets({ assetBulkDeleteDto: { ids: [plain.id, locked.id] } }, { headers });
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/trash');
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(traces(page, locked.id).first()).toBeVisible();

    await lockAuthSession({ headers });
    await expect(traces(page, locked.id)).toHaveCount(0);
    await expect(traces(page, plain.id).first()).toBeVisible();
  });

  test('closes the Locked view once the PIN unlock has expired', async ({ context, page }) => {
    const { user, locked } = await setup();
    await utils.setAuthCookies(context, user.accessToken);
    await page.goto('/locked');
    await expect(traces(page, locked.id).first()).toBeVisible();
    await page.waitForLoadState('networkidle');

    // the unlock runs out on the server (its hour is up), and the tab is looked at again
    const client = await utils.connectDatabase();
    await client.query(
      `UPDATE session SET "pinExpiresAt" = now() - interval '1 second' WHERE "userId" = $1 AND "pinExpiresAt" IS NOT NULL`,
      [user.userId],
    );
    await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));

    await expect(page).toHaveURL(/\/photos\/?$/);
    await expect(traces(page, locked.id)).toHaveCount(0);
  });

  test("never shows another account's Locked item, administrator included", async ({ context, page }) => {
    const { locked } = await setup();
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers: asBearerAuth(admin.accessToken) });
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(`/photos/${locked.id}`);
    await expect(page.getByTestId('preview')).toHaveCount(0);
    await page.goto('/locked');
    await expect(traces(page, locked.id)).toHaveCount(0);
  });
});
