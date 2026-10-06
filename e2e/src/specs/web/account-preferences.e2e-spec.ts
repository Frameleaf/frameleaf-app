import { getMyPreferences, setUserOnboarding } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, baseUrl, utils } from 'src/utils.js';

test.describe('Account preferences (FL-144)', () => {
  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
  });

  test('keeps a self draft through an admin conflict without bleeding into the next account', async ({
    browser,
    context,
    page,
  }) => {
    const admin = await utils.adminSetup();
    const alice = await utils.userSetup(admin.accessToken, {
      name: 'Preference Owner',
      email: 'fl144-preference-owner@example.com',
      password: 'password',
    });
    const bob = await utils.userSetup(admin.accessToken, {
      name: 'Other Account',
      email: 'fl144-other-account@example.com',
      password: 'password',
    });
    for (const user of [alice, bob]) {
      await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(user.accessToken) });
    }

    const aliceHeaders = { headers: asBearerAuth(alice.accessToken) };
    const before = await getMyPreferences(aliceHeaders);
    expect(before.folders.enabled).toBe(true);
    const minimumFaces = before.people.minimumFaces === 7 ? 8 : 7;

    await utils.setAuthCookies(context, alice.accessToken);
    await page.goto('/user-settings?area=preferences&section=feature');
    const folders = page.getByRole('switch', { name: 'Enable folders' });
    await expect(folders).toHaveAttribute('aria-checked', 'true');
    await folders.click();
    await expect(folders).toHaveAttribute('aria-checked', 'false');

    const adminContext = await browser.newContext({ baseURL: baseUrl });
    try {
      await utils.setAuthCookies(adminContext, admin.accessToken);
      const adminPage = await adminContext.newPage();
      await adminPage.goto(`/user-settings?area=users&section=accounts&user=${alice.userId}`);
      await adminPage
        .getByRole('navigation', { name: 'Detail sections' })
        .getByRole('button', { name: 'Features' })
        .click();
      const adminForm = adminPage.locator('form.account-preferences');
      await expect(adminForm).toBeVisible();
      await adminForm.getByLabel('Minimum faces').fill(String(minimumFaces));
      await adminForm.getByRole('button', { name: 'Save preferences' }).click();
      await expect
        .poll(async () => {
          const preferences = await getMyPreferences(aliceHeaders);
          return preferences.people.minimumFaces;
        })
        .toBe(minimumFaces);
    } finally {
      await adminContext.close();
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByText('Your preferences changed elsewhere. Review the latest values before saving.'),
    ).toBeVisible();
    await expect(folders).toHaveAttribute('aria-checked', 'false');
    const afterConflict = await getMyPreferences(aliceHeaders);
    expect(afterConflict.folders.enabled).toBe(true);
    expect(afterConflict.people.minimumFaces).toBe(minimumFaces);

    // Cross accounts while Alice still has the stale, unsaved value on screen.
    await utils.setAuthCookies(context, bob.accessToken);
    page.once('dialog', (dialog) => void dialog.accept());
    await page.reload();
    await expect(folders).toHaveAttribute('aria-checked', 'true');
    await expect(
      page.getByText('Your preferences changed elsewhere. Review the latest values before saving.'),
    ).toHaveCount(0);
    const bobPreferences = await getMyPreferences({ headers: asBearerAuth(bob.accessToken) });
    expect(bobPreferences.folders.enabled).toBe(true);

    await utils.setAuthCookies(context, alice.accessToken);
    await page.reload();
    await expect(page.getByLabel('Minimum faces to display a person')).toHaveValue(String(minimumFaces));
    await expect(folders).toHaveAttribute('aria-checked', 'true');
    await folders.click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => {
        const preferences = await getMyPreferences(aliceHeaders);
        return preferences.folders.enabled;
      })
      .toBe(false);
    await expect(folders).toHaveAttribute('aria-checked', 'false');
  });
});
