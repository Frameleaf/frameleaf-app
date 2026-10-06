import {
  LoginResponseDto,
  deleteAssets,
  deleteSession,
  getConfig,
  getSessions,
  lockAssets,
  lockAuthSession,
  login,
  setUserOnboarding,
  setupPinCode,
  unlockAuthSession,
  updateConfig,
} from '@frameleaf/sdk';
import { Page, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';

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

  test.afterAll(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  /** A fresh onboarded account with one ordinary and one locked photo, its session unlocked. */
  const setup = async (signal: AbortSignal) => {
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
    // Queue observation is administrative; media readiness uses this owner's unlocked bearer session.
    await utils.waitForAssetReady(admin.accessToken, plain.id, { headers, signal });
    await utils.waitForAssetReady(admin.accessToken, locked.id, { headers, signal });
    return { user, headers, plain, locked, suffix };
  };

  test('closes an open viewer of a Locked item when the session locks elsewhere', async ({
    context,
    page,
    assetReady,
  }) => {
    const { user, headers, locked } = await setup(assetReady.signal);
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto(`/locked/photos/${locked.id}`);
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);

    // the same session, locked from another tab or device
    await lockAuthSession({ headers });

    await expect(page).toHaveURL(/\/photos\/?$/);
    await expect(traces(page, locked.id)).toHaveCount(0);
  });

  test('empties the Locked view when the session locks, and asks for the PIN again', async ({
    context,
    page,
    assetReady,
  }) => {
    const { user, headers, plain, locked } = await setup(assetReady.signal);
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

  test('lists what the Locked rules hide in the Locked view, badged Sensitive', async ({
    context,
    page,
    assetReady,
  }) => {
    const { user, headers, plain, locked, suffix } = await setup(assetReady.signal);
    const ruleMatch = await utils.createAsset(user.accessToken, { assetData: { filename: `rule-${suffix}.png` } });
    await utils.waitForAssetReady(admin.accessToken, ruleMatch.id, { headers, signal: assetReady.signal });
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

  test('finds marks and rule matches in unlocked search, and drops them when the session locks (FL-195)', async ({
    context,
    page,
    assetReady,
  }) => {
    const { user, headers, plain, locked, suffix } = await setup(assetReady.signal);
    const ruleMatch = await utils.createAsset(user.accessToken, { assetData: { filename: `rule-${suffix}.png` } });
    await utils.waitForAssetReady(admin.accessToken, ruleMatch.id, { headers, signal: assetReady.signal });
    const [tag] = await utils.upsertTags(user.accessToken, [`Private ${suffix}`]);
    await utils.tagAssets(user.accessToken, tag.id, [ruleMatch.id]);
    await utils.updateMyPreferences(user.accessToken, { privacy: { suppression: { tagIds: [tag.id] } } });
    await utils.setAuthCookies(context, user.accessToken);

    // every name shares the suffix, so one search finds what this unlocked session may see: FL-195, the
    // owner's own mark as well as the rule match, like any other item
    await page.goto(`/search?query=${encodeURIComponent(JSON.stringify({ originalFileName: suffix }))}`);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(traces(page, ruleMatch.id).first()).toBeVisible();
    await expect(traces(page, locked.id).first()).toBeVisible();

    await lockAuthSession({ headers });
    await expect(traces(page, ruleMatch.id)).toHaveCount(0);
    await expect(traces(page, locked.id)).toHaveCount(0);
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(page.getByText(`rule-${suffix}`)).toHaveCount(0);
    await expect(page.getByText(`Private ${suffix}`)).toHaveCount(0);
  });

  test('drops a trashed Locked item from Trash when the session locks', async ({ context, page, assetReady }) => {
    const { user, headers, plain, locked } = await setup(assetReady.signal);
    await deleteAssets({ assetBulkDeleteDto: { ids: [plain.id, locked.id] } }, { headers });
    await utils.setAuthCookies(context, user.accessToken);

    await page.goto('/trash');
    await expect(traces(page, plain.id).first()).toBeVisible();
    await expect(traces(page, locked.id).first()).toBeVisible();

    await lockAuthSession({ headers });
    await expect(traces(page, locked.id)).toHaveCount(0);
    await expect(traces(page, plain.id).first()).toBeVisible();
  });

  test('closes the Locked view once the PIN unlock has expired', async ({ context, page, assetReady }) => {
    const { user, locked } = await setup(assetReady.signal);
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

  test("never shows another account's Locked item, administrator included", async ({ context, page, assetReady }) => {
    const { locked } = await setup(assetReady.signal);
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers: asBearerAuth(admin.accessToken) });
    await utils.setAuthCookies(context, admin.accessToken);

    await page.goto(`/photos/${locked.id}`);
    await expect(page.getByTestId('preview')).toHaveCount(0);
    await page.goto('/locked');
    await expect(traces(page, locked.id)).toHaveCount(0);
  });

  test('keeps corrected document evidence after reload and clears open detail on relock or revocation (FL-63)', async ({
    context,
    page,
    assetReady,
  }) => {
    const { user, headers, locked } = await setup(assetReady.signal);
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
    await updateConfig(
      {
        adminConfigDto: {
          ...config,
          machineLearning: {
            ...config.machineLearning,
            ocr: { ...config.machineLearning.ocr, documentFields: true },
          },
        },
      },
      { headers: asBearerAuth(admin.accessToken) },
    );

    const db = await utils.connectDatabase();
    await db.query(
      `INSERT INTO asset_ocr ("assetId", x1, y1, x2, y2, x3, y3, x4, y4, "boxScore", "textScore", text)
       VALUES ($1, 0.15, 0.2, 0.8, 0.2, 0.8, 0.32, 0.15, 0.32, 0.9, 0.96, $2)`,
      [locked.id, 'Grand total $18.50'],
    );
    await db.query(
      `INSERT INTO ocr_search ("assetId", text) VALUES ($1, $2)
       ON CONFLICT ("assetId") DO UPDATE SET text = EXCLUDED.text`,
      [locked.id, 'grand total 18.50'],
    );

    await utils.setAuthCookies(context, user.accessToken);
    await page.goto('/documents?query=grand');
    const tile = page.locator(`[data-asset-id="${locked.id}"]`);
    await expect(tile).toBeVisible();
    await tile.click();
    await page.getByRole('button', { name: 'Information', exact: true }).click();

    const text = page.getByTestId('frameleaf-document-text');
    await expect(text.getByTestId('frameleaf-document-text-body')).toContainText('Grand total $18.50');
    const total = text.getByTestId('frameleaf-document-fields').locator('li').filter({ hasText: 'Total' });
    await expect(total).toContainText('$18.50');
    await total.getByRole('button', { name: 'Show where' }).click();
    await expect(page.getByTestId('document-region-highlight')).toBeVisible();

    await total.getByRole('button', { name: 'Correct' }).click();
    await total.getByRole('textbox', { name: 'Total value' }).fill('$19.25');
    await total.getByRole('button', { name: 'Save' }).click();
    await expect(total).toContainText('$19.25');

    await page.reload();
    await expect(page.locator('#detail-panel')).toBeVisible();
    await expect(page.getByTestId('frameleaf-document-fields')).toContainText('$19.25');

    await lockAuthSession({ headers });
    await expect(page).toHaveURL(/\/photos\/?$/);
    await expect(page.getByTestId('frameleaf-document-text')).toHaveCount(0);
    await expect(page.getByText('$19.25')).toHaveCount(0);
    await expect(traces(page, locked.id)).toHaveCount(0);

    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    await page.goto('/documents?query=grand');
    await page.locator(`[data-asset-id="${locked.id}"]`).click();
    await expect(page.locator('#detail-panel')).toBeVisible();
    await expect(page.getByTestId('frameleaf-document-fields')).toContainText('$19.25');

    const other = await login({ loginCredentialDto: { email: user.userEmail, password: 'password' } });
    const sessions = await getSessions({ headers });
    const session = sessions.find((item) => item.current);
    expect(session).toBeDefined();
    await deleteSession({ id: session!.id }, { headers: asBearerAuth(other.accessToken) });
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(page.getByTestId('frameleaf-document-text')).toHaveCount(0);
    await expect(page.getByText('$19.25')).toHaveCount(0);
    await expect(traces(page, locked.id)).toHaveCount(0);
  });
});
