import { faker } from '@faker-js/faker';
import { expect, test, type Page } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { CloudMockState, setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';

/**
 * FL-196 (CLD-008): the linked-server tour against a mocked server. It opens by itself for the
 * administrator who links from Settings and, once, for another administrator on their next visit to
 * Settings; never for someone who has seen it or for an account that is not an administrator. Done,
 * Skip tour, Escape and an "Open …" link each record the ending on the server; skipping leaves the
 * "Take the tour again" notice; Account & link and the settings search reopen it; under Reduce Motion
 * the steps crossfade instead of sliding.
 */
const accountPage = '/user-settings?area=cloud&section=cloud-account';
const planPage = '/user-settings?area=cloud&section=cloud-plan';

const tourDialog = (page: Page) => page.locator('dialog.cloud-tour');
/** The tour, once it has opened by itself (the first page load can be slow). */
const openedTour = async (page: Page) => {
  const dialog = tourDialog(page);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  return dialog;
};
const endings = (mock: CloudMockState) =>
  mock.requests
    .filter(({ method, path }) => method === 'PUT' && path === 'admin/cloud/tour')
    .map(({ body }) => (body as { ending: string }).ending);

test.describe.configure({ mode: 'parallel' });
test.describe('Frameleaf Cloud linked-server tour', () => {
  let mock: CloudMockState;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    mock = { state: 'linked', requests: [], tour: { seen: false } };
    await setupCloudMockApiRoutes(context, mock);
    // the bundled prices, as `GET license/products` answers without a store
    await context.route('**/api/license/products', (route) =>
      route.fulfill({
        status: 200,
        json: {
          currency: 'USD',
          licensedDiscount: 0.2,
          pricesVersion: '2026-09-25.1',
          storeUrl: null,
          credit: { minimumUsd: 20, maximumUsd: 500 },
          backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
          products: [
            { id: 'cloud-monthly', kind: 'plan', period: 'month', priceUsd: 6, storeUrl: null },
            { id: 'cloud-annual', kind: 'plan', period: 'year', priceUsd: 60, storeUrl: null },
          ],
        },
      }),
    );
  });

  test('opens for the administrator who links this server from Settings', async ({ page }) => {
    mock.state = 'unlinked';
    await page.goto(accountPage);
    await page.getByRole('button', { name: 'Link to Frameleaf' }).click();
    await expect(page.getByText('BCDF-GHJK')).toBeVisible();
    await expect(tourDialog(page)).toHaveCount(0);

    mock.state = 'linked';
    const dialog = tourDialog(page);
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText('1 of 6');
    await expect(dialog).toContainText('This server is linked to owner@example.test');
    await expect(dialog.getByTestId('cloud-tour-status')).toHaveText('Needs a plan');
    await expect(dialog.getByRole('button', { name: 'Next' })).toBeFocused();
  });

  test('opens once for another administrator on their next visit to Settings, and Done records it', async ({
    page,
  }) => {
    await page.goto(planPage);
    const dialog = await openedTour(page);

    for (const [heading, status] of [
      ['An address of your own', 'Needs a plan'],
      ['Sign in with Frameleaf', 'Available'],
      ['Cloud AI when you choose it', 'Off · $12.50 AI credit'],
      ['Encrypted off-site backup', 'Needs a plan'],
      ['Your plan, and where it all lives', 'No plan'],
    ]) {
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByRole('heading', { name: heading })).toBeFocused();
      await expect(dialog.getByTestId('cloud-tour-status')).toHaveText(status);
    }
    await expect(dialog).toContainText('6 of 6');
    await expect(dialog).toContainText('from $6 a month');
    await expect(dialog.getByRole('button', { name: 'Skip tour' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    expect(endings(mock)).toEqual(['finished']);
    await expect(page.getByText('Take the tour again any time')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(tourDialog(page)).toHaveCount(0);
  });

  test('is not offered to an administrator who has seen it, or before the server is linked', async ({ page }) => {
    mock.tour = { seen: true, ending: 'setup' };
    await page.goto(accountPage);
    await expect(page.getByText('Linked to Frameleaf')).toBeVisible({ timeout: 30_000 });
    await expect(tourDialog(page)).toHaveCount(0);

    mock.tour = { seen: false };
    mock.state = 'unlinked';
    await page.goto(planPage);
    await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('is never shown to an account that is not an administrator', async ({ context, page }) => {
    await context.route('**/api/users/me', (route) =>
      route.fulfill({
        status: 200,
        json: {
          id: faker.string.uuid(),
          email: 'member@example.com',
          name: 'Member',
          profileImagePath: '',
          avatarColor: 'blue',
          profileChangedAt: '2025-01-22T21:31:23.996Z',
          storageLabel: null,
          shouldChangePassword: false,
          isAdmin: false,
          createdAt: '2025-01-22T21:31:23.996Z',
          deletedAt: null,
          updatedAt: '2025-11-14T00:00:00.369Z',
          oauthId: '',
          quotaSizeInBytes: null,
          quotaUsageInBytes: 0,
          status: 'active',
          license: null,
        },
      }),
    );
    await page.goto('/user-settings?area=preferences&tour=cloud');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(mock.requests.some(({ path }) => path === 'admin/cloud/tour')).toBe(false);
  });

  test('Skip tour records it and leaves the notice to take it again', async ({ page }) => {
    await page.goto(planPage);
    const tour = await openedTour(page);
    await tour.getByRole('button', { name: 'Skip tour' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Take the tour again any time from Frameleaf Cloud → Account & link.')).toBeVisible();
    expect(endings(mock)).toEqual(['skipped']);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByText('Take the tour again any time')).toHaveCount(0);
  });

  test('Escape skips it too', async ({ page }) => {
    await page.goto(planPage);
    await openedTour(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Take the tour again any time')).toBeVisible();
    expect(endings(mock)).toEqual(['skipped']);
  });

  test('an "Open …" link closes the tour and opens its settings page', async ({ page }) => {
    await page.goto(planPage);
    const dialog = await openedTour(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('heading', { name: 'Sign in with Frameleaf' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Open Sign in with Frameleaf' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/area=security&section=frameleaf-signin/);
    expect(endings(mock)).toEqual(['opened-settings']);
    await expect(page.getByText('Take the tour again any time')).toHaveCount(0);
  });

  test('Account & link and the settings search reopen it', async ({ page }) => {
    mock.tour = { seen: true, ending: 'finished' };
    await page.goto(planPage);
    await page.getByRole('searchbox', { name: 'Search all settings' }).fill('tour');
    await page
      .locator('.cc-search-results')
      .getByRole('button', { name: /Account & link/ })
      .click();
    await expect(page).toHaveURL(/section=cloud-account/);

    await page.getByRole('button', { name: 'Take the tour' }).click();
    const dialog = await openedTour(page);
    await dialog.getByRole('button', { name: 'Step 5: Encrypted off-site backup' }).click();
    await expect(dialog).toContainText('5 of 6');
    await dialog.getByRole('button', { name: 'Skip tour' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).not.toHaveURL(/tour=cloud/);
    // the first ending is kept on the server
    expect(mock.tour).toEqual({ seen: true, ending: 'finished' });
  });

  test('crossfades between steps under Reduce Motion instead of sliding', async ({ page }) => {
    const keyframes = () =>
      page.evaluate(() =>
        document
          .querySelector('.cloud-tour .ct-body')!
          .getAnimations()
          .map((animation) => JSON.stringify((animation.effect as KeyframeEffect).getKeyframes())),
      );

    await page.goto(planPage);
    const dialog = await openedTour(page);
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect.poll(keyframes).toEqual([expect.stringContaining('translateX(28px)')]);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog).toContainText('3 of 6');
    await expect.poll(keyframes).toEqual([expect.not.stringContaining('translate')]);
  });

  test('is a bottom sheet with 44pt controls on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(planPage);
    const dialog = await openedTour(page);
    // the sheet rises into place: measure it once its entrance has finished, not part way up
    await dialog.evaluate((sheet) =>
      Promise.all(sheet.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );
    const box = (await dialog.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    expect(Math.round(box.width)).toBe(390);
    for (const name of ['Next', 'Open Remote access']) {
      const control = (await dialog.getByRole('button', { name }).boundingBox())!;
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
  });
});
