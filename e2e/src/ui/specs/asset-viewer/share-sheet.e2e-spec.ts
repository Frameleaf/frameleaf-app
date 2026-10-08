import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { setupAssetViewerFixture } from './utils';

const fixture = setupAssetViewerFixture(3517);

test.beforeEach(async ({ context, page }) => {
  await context.addInitScript(() => localStorage.setItem('immich-ui-theme', JSON.stringify('dark')));
  await context.route(`**/api/assets/${fixture.primaryAssetDto.id}`, (route) =>
    route.fulfill({ json: { ...fixture.primaryAssetDto, originalFileName: 'Hiking with Jamie.jpg' } }),
  );
  await context.route('**/api/assets/*/thumbnail*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: readFileSync(new URL('../../../fixtures/frameleaf-media/hiking.png', import.meta.url)),
    }),
  );
  await context.route('**/api/users/*/profile-image*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: readFileSync(
        new URL(
          `../../../fixtures/frameleaf-media/avatar-${route.request().url().includes('jamie') ? 'jamie' : 'emma'}.png`,
          import.meta.url,
        ),
      ),
    }),
  );
  await context.route('**/api/users', (route) =>
    route.fulfill({
      json: [
        { id: 'jamie', name: 'Jamie', avatarColor: 'blue', profileImagePath: 'profile.png' },
        { id: 'emma', name: 'Emma', avatarColor: 'pink', profileImagePath: 'profile.png' },
      ],
    }),
  );
  await context.route('**/api/item-shares/query', (route) => route.fulfill({ json: [] }));
  await context.route('**/api/shared-spaces/recipient-groups', (route) => route.fulfill({ json: [] }));
  await page.goto(`/photos/${fixture.primaryAssetDto.id}`);
  await page.getByTestId('asset-viewer-navbar-actions').getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('group', { name: 'People to share with' })).toBeVisible();
  await page.getByRole('dialog').evaluate(async (dialog) => {
    await document.fonts.ready;
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  });
});

test.describe('compact desktop share sheet', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('keeps approved compact controls and two-line descriptions without losing keyboard selection', async ({
    page,
  }) => {
    const sheet = page.getByRole('dialog');
    // The sheet is titled by what is shared, not by a file name.
    await expect(sheet).toHaveAccessibleName('Share 1 photo');
    await expect
      .poll(() =>
        sheet
          .locator('.ss-option small')
          .evaluateAll((elements) =>
            elements.map((element) =>
              Math.round(
                element.getBoundingClientRect().height / Number(getComputedStyle(element).lineHeight.replace('px', '')),
              ),
            ),
          ),
      )
      .toEqual([2, 2]);
    for (const button of [
      sheet.getByRole('button', { name: 'Close', exact: true }),
      sheet.getByRole('button', { name: 'Download', exact: true }),
      sheet.getByRole('button', { name: 'Cancel', exact: true }),
      sheet.getByRole('button', { name: 'Save sharing', exact: true }),
    ]) {
      const height = await button.evaluate((element) => element.getBoundingClientRect().height);
      expect(height).toBeGreaterThanOrEqual(34);
      expect(height).toBeLessThan(38);
    }
    await sheet.getByRole('radio', { name: /Share with people/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(sheet.getByRole('radio', { name: /Create a public link/ })).toBeFocused();
    await expect(sheet.getByRole('radio', { name: /Create a public link/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowLeft');
    const jamie = sheet.getByRole('button', { name: 'Jamie', exact: true });
    await jamie.focus();
    await page.keyboard.press('Space');
    await expect(jamie).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByRole('button', { name: 'Share with Jamie', exact: true })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
  });
});

test.describe('touch share sheet', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('retains coarse-pointer targets and usable recipient selection', async ({ page }) => {
    const sheet = page.getByRole('dialog');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const targets = await sheet.locator('button').evaluateAll((buttons) =>
        buttons.map((button) => ({
          width: button.getBoundingClientRect().width,
          height: button.getBoundingClientRect().height,
        })),
      );
      for (const target of targets) {
        expect(target.height).toBeGreaterThanOrEqual(48);
        expect(target.width).toBeGreaterThanOrEqual(48);
      }
    }
    await sheet.getByRole('button', { name: 'Jamie', exact: true }).tap();
    await expect(sheet.getByRole('button', { name: 'Jamie', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(sheet.getByRole('button', { name: 'Share with Jamie', exact: true })).toBeEnabled();
  });
});
