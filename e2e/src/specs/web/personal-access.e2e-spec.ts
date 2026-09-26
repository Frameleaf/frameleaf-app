import {
  ConfigCredential,
  LoginResponseDto,
  Permission,
  getMyPreferences,
  lockAuthSession,
  setUserOnboarding,
  setupPinCode,
  unlockAuthSession,
  updateConfigCredential,
} from '@immich/sdk';
import { BrowserContext, Page, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';

/**
 * FL-67: personal access in the Command Center (Access & security, Your profile) and the
 * write-only server credentials. Copy comes from LockedRulesPanel.svelte, ProfileSection.svelte,
 * ApiKeysSection.svelte / ApiKeyDialog.svelte and CredentialRow.svelte (i18n/en.json).
 */

const lockedRulesUrl = '/user-settings?area=security&section=suppressed-content';
const profileUrl = '/user-settings?area=preferences&section=account';
const apiKeysUrl = '/user-settings?area=security&section=api-keys';
const emailSettingsUrl = '/user-settings?area=notifications&section=notifications&isOpen=email';

const pinCode = '135790';

// A 1x1 PNG; the upload route is intercepted, so only its name and type matter.
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const openLockedRules = async (context: BrowserContext, page: Page, accessToken: string) => {
  await utils.setAuthCookies(context, accessToken);
  await page.goto(lockedRulesUrl);
  await expect(page.getByRole('button', { name: 'Save Locked rules' })).toBeVisible();
};

test.describe('Personal access (FL-67)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  /** A fresh onboarded account, so no test sees another test's rules, keys or photo. */
  const createUser = async () => {
    const suffix = randomUUID().slice(0, 8);
    const user = await utils.userSetup(admin.accessToken, {
      email: `personal-access-${suffix}@example.com`,
      name: `Personal Access ${suffix}`,
      password: 'password',
    });
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(user.accessToken) });
    return user;
  };

  /** A fresh account with a PIN whose browser session (the cookie token) is unlocked. */
  const createUnlockedUser = async () => {
    const user = await createUser();
    const headers = asBearerAuth(user.accessToken);
    await setupPinCode({ pinCodeSetupDto: { pinCode } }, { headers });
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    return user;
  };

  test('drops the draft and asks to unlock again when the session locks before saving', async ({ context, page }) => {
    // FL-67: "A session locked during the save drops the draft and asks to unlock again." The live
    // lock event is held back so the save itself is what finds the session locked.
    await context.routeWebSocket('**/socket.io/**', () => {});
    const user = await createUnlockedUser();
    await utils.upsertTags(user.accessToken, ['Relock draft']);
    await openLockedRules(context, page, user.accessToken);

    const tag = page.getByRole('checkbox', { name: 'Relock draft' });
    await tag.check();
    await expect(tag).toBeChecked();

    await lockAuthSession({ headers: asBearerAuth(user.accessToken) });
    await page.getByRole('button', { name: 'Save Locked rules' }).click();

    await expect(
      page.getByRole('status').filter({ hasText: 'Unlock again before saving Locked rules.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock Locked settings' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Relock draft' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save Locked rules' })).toHaveCount(0);

    // nothing was saved
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers: asBearerAuth(user.accessToken) });
    const preferences = await getMyPreferences({ headers: asBearerAuth(user.accessToken) });
    expect(preferences.privacy.suppression.tagIds).toEqual([]);
  });

  test('keeps the draft and shows the conflict when another tab changed the rules', async ({ context, page }) => {
    // FL-67: "if the rules themselves changed in another tab or device the draft stays and the
    // owner decides to reload."
    const user = await createUnlockedUser();
    await utils.upsertTags(user.accessToken, ['Tab one', 'Tab two']);
    await openLockedRules(context, page, user.accessToken);

    const other = await context.newPage();
    await other.goto(lockedRulesUrl);
    await expect(other.getByRole('button', { name: 'Save Locked rules' })).toBeVisible();

    await other.getByRole('checkbox', { name: 'Tab two' }).check();

    await page.getByRole('checkbox', { name: 'Tab one' }).check();
    await page.getByRole('button', { name: 'Save Locked rules' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Locked rules saved.' })).toBeVisible();

    // Coming back to the other tab may already notice the change (and disable Save); otherwise the
    // save itself is refused with 409 and reports the same conflict.
    const otherSave = other.getByRole('button', { name: 'Save Locked rules' });
    if (await otherSave.isEnabled()) {
      await otherSave.click();
    }

    await expect(
      other
        .getByRole('alert')
        .filter({ hasText: 'These rules changed elsewhere. Your draft is kept until you reload.' }),
    ).toBeVisible();
    await expect(other.getByRole('button', { name: 'Discard draft and reload rules' })).toBeVisible();
    await expect(other.getByRole('checkbox', { name: 'Tab two' })).toBeChecked();
    await expect(otherSave).toBeDisabled();

    const preferences = await getMyPreferences({ headers: asBearerAuth(user.accessToken) });
    expect(preferences.privacy.suppression.tagIds).toHaveLength(1);

    await other.getByRole('button', { name: 'Discard draft and reload rules' }).click();
    await expect(other.getByRole('checkbox', { name: 'Tab one' })).toBeChecked();
    await expect(other.getByRole('checkbox', { name: 'Tab two' })).not.toBeChecked();
  });

  test('says why a profile photo was not used', async ({ context, page }) => {
    // FL-67: "A photo the server refuses leaves the current avatar in place and says why."
    const user = await createUser();
    await utils.setAuthCookies(context, user.accessToken);
    await page.goto(profileUrl);

    const profile = page.getByRole('region', { name: 'Your profile' });
    await expect(profile.getByRole('button', { name: 'Upload photo' })).toBeVisible();
    const fileInput = profile.locator('input[type="file"]');

    // a file that is not an image is refused before it is sent
    await fileInput.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await expect(
      profile.getByRole('alert').filter({ hasText: 'Choose a JPEG, PNG, WebP, HEIC, AVIF, DNG or SVG image.' }),
    ).toBeVisible();

    // an image the server refuses shows the server's reason
    await page.route('**/api/users/profile-image', async (route) => {
      if (route.request().method() !== 'POST') {
        return route.fallback();
      }
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Invalid profile image', error: 'Bad Request', statusCode: 400 }),
      });
    });
    await fileInput.setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: tinyPng });
    await expect(profile.getByRole('alert').filter({ hasText: 'Invalid profile image' })).toBeVisible();
    await expect(profile.getByRole('button', { name: 'Remove photo' })).toHaveCount(0);
  });

  test('clears a stored server credential', async ({ context, page }) => {
    // FL-67: a write-only credential row shows only whether a value is stored; Clear removes it
    // after a confirmation.
    await updateConfigCredential(
      { name: ConfigCredential.SmtpPassword, configCredentialUpdateDto: { value: 'fl67-smtp-password' } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(emailSettingsUrl);

    const emailGroup = page.locator('#setting-group-email');
    const toggle = emailGroup.locator('> button');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }

    const row = page.locator('.credential').filter({ hasText: 'SMTP password' });
    await expect(row.getByText('Stored', { exact: true }).first()).toBeVisible();
    await expect(row).not.toContainText('fl67-smtp-password');

    await row.getByRole('button', { name: 'Clear' }).click();
    const confirm = page.getByRole('dialog', { name: 'Clear SMTP password' });
    await expect(confirm).toContainText('Clear the SMTP password?');
    await confirm.getByRole('button', { name: 'Clear' }).click();

    await expect(row.getByText('Not set', { exact: true }).first()).toBeVisible();
    await expect(row.getByRole('button', { name: 'Clear' })).toHaveCount(0);

    const { body } = await request(app)
      .get('/admin/config/credentials')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(body).toContainEqual({ name: 'smtp-password', configured: false });
  });

  test('shows a rotated API key once', async ({ context, page }) => {
    // FL-67: rotating shows the new value once; the old value stops working at once.
    const user = await createUser();
    const { secret: oldSecret } = await utils.createApiKey(user.accessToken, [Permission.All]);

    await utils.setAuthCookies(context, user.accessToken);
    await page.goto(apiKeysUrl);

    const row = page.getByRole('listitem').filter({ hasText: 'e2e' });
    await row.getByRole('button', { name: 'Rotate' }).click();

    const confirm = page.getByRole('dialog', { name: 'Rotate e2e' });
    await expect(confirm).toContainText('The old key stops working at once');
    await confirm.getByRole('button', { name: 'Rotate' }).click();

    const reveal = page.getByRole('dialog', { name: 'Your new API key' });
    await expect(reveal).toContainText('This key is shown once. Copy it now; it cannot be shown again.');
    const secretText = await reveal.getByLabel('New API key').textContent();
    const secret = secretText?.trim() ?? '';
    expect(secret).not.toBe('');
    expect(secret).not.toBe(oldSecret);

    const withNew = await request(app).get('/users/me').set('x-api-key', secret);
    expect(withNew.status).toBe(200);
    const withOld = await request(app).get('/users/me').set('x-api-key', oldSecret);
    expect(withOld.status).toBe(401);

    await reveal.getByRole('button', { name: 'Done' }).click();
    await expect(reveal).toHaveCount(0);
    await expect(page.getByText(secret)).toHaveCount(0);
  });
});
