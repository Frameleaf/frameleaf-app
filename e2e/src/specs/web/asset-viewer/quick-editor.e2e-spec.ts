import { AssetMediaResponseDto, getAssetDevelop, LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-113 (VID-105): the full-screen photo quick editor against a real server.
 * Hold-to-compare (`\` primary, Y kept), the Versions top-bar menu, and Save version, which
 * stores a new revision, closes the editor and never changes the original.
 * Design: design/frameleaf/template/src/Editor.jsx (September 24, 2026).
 */
test.describe('Quick editor', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
  });

  test.beforeEach(async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
    await page.keyboard.press('e');
    await expect(page.getByRole('dialog', { name: /Edit/ })).toBeVisible();
  });

  test('opens on Adjust and holds the original on backslash', async ({ page }) => {
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await expect(editor.getByRole('tab', { name: 'Adjust' })).toHaveAttribute('aria-selected', 'true');

    const contrast = editor.getByRole('slider', { name: 'Contrast' });
    await contrast.focus();
    await page.keyboard.press('ArrowRight');

    // Compare works while the slider still has focus.
    await page.keyboard.down('\\');
    await expect(editor.locator('.ed-badge.ed-original')).toHaveText('Original');
    await expect(editor.getByRole('button', { name: String.raw`Hold to show the original (\ or Y)` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.up('\\');
    await expect(editor.locator('.ed-badge.ed-original')).toHaveCount(0);
  });

  test('keeps Versions in the top bar and saves a new version without touching the original', async ({ page }) => {
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByRole('button', { name: 'Versions' }).click();
    await expect(editor.getByRole('menuitemradio', { name: /Original/ })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    await editor.getByRole('slider', { name: 'Exposure' }).fill('0.5');
    await editor.getByRole('button', { name: 'Save version' }).click();
    await expect(editor).toBeHidden();

    const develop = await getAssetDevelop({ id: asset.id }, { headers: asBearerAuth(admin.accessToken) });
    expect(develop.revisions).toHaveLength(1);
    expect(develop.revisions[0].recipe).toMatchObject({ exposure: 0.5 });

    // The new version is listed when the editor opens again.
    await page.keyboard.press('e');
    const reopened = page.getByRole('dialog', { name: /Edit/ });
    await reopened.getByRole('button', { name: 'Versions' }).click();
    await expect(reopened.getByRole('menuitemradio', { name: /Version 1/ })).toBeVisible();
  });
});
