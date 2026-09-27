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

  test('drops a Locked item from search results when the session locks', async ({ context, page }) => {
    const { user, headers, plain, locked, suffix } = await setup();
    await utils.setAuthCookies(context, user.accessToken);

    // both names share the suffix, so one search finds both while unlocked
    await page.goto(`/search?query=${encodeURIComponent(JSON.stringify({ originalFileName: suffix }))}`);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(traces(page, locked.id).first()).toBeVisible();

    await lockAuthSession({ headers });
    await expect(traces(page, locked.id)).toHaveCount(0);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(page.getByText(`secret-${suffix}`)).toHaveCount(0);
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

  test('closes the Locked view when the PIN unlock expires', async ({ context, page }) => {
    const { user, locked } = await setup();
    // the unlock ends a few seconds from now, as it would after its hour
    const client = await utils.connectDatabase();
    await client.query(
      `UPDATE session SET "pinExpiresAt" = now() + interval '8 seconds' WHERE "userId" = $1 AND "pinExpiresAt" IS NOT NULL`,
      [user.userId],
    );
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/locked');
    await expect(traces(page, locked.id).first()).toBeVisible();

    await expect(page).toHaveURL(/\/photos\/?$/, { timeout: 20_000 });
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
