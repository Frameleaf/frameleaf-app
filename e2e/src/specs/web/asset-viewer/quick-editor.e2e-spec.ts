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

/**
 * FL-113 (VID-105): quick editor ↔ Studio continuity. "Open in Studio" carries the unsaved draft
 * (and, for a clip, the playhead) to Studio; "Back to quick edit" returns to the same item with the
 * same draft. Not run locally (the lead runs the e2e stack).
 */
test.describe('Quick editor and Studio continuity', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
  });

  test('keeps the draft across Studio and back', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    await page.keyboard.press('e');
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByRole('slider', { name: 'Exposure' }).fill('0.5');

    await editor.getByRole('button', { name: 'Open in Studio' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/studio\\?assets=${asset.id}&from=${asset.id}`));

    await page.getByRole('button', { name: 'Back to quick edit' }).click();
    await expect(page).toHaveURL(new RegExp(`/photos/${asset.id}$`));
    const back = page.getByRole('dialog', { name: /Edit/ });
    await expect(back.getByRole('slider', { name: 'Exposure' })).toHaveValue('0.5');
    await expect(page.getByText('Your unsaved edits are back where you left them.')).toBeVisible();

    // Nothing was saved on the way: the original is untouched until Save version.
    const develop = await getAssetDevelop({ id: asset.id }, { headers: asBearerAuth(admin.accessToken) });
    expect(develop.revisions).toHaveLength(0);
  });
});

/**
 * FL-113 VE-1 … VE-12: the video half of the same editor. The clip's original metadata and the
 * saved recipe are answered by the test so the spec does not depend on a decodable fixture; the
 * page, the editor and the request it sends are real.
 */
test.describe('Video quick editor', () => {
  let admin: LoginResponseDto;
  let clip: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    clip = await utils.createAsset(admin.accessToken, { assetData: { filename: 'clip.mp4' } });
  });

  test.beforeEach(async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.route(`**/api/assets/${clip.id}/edits`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: { assetId: clip.id, edits: [], originalVideo: { width: 1920, height: 1080, durationMs: 24_000 } },
        });
        return;
      }
      await route.fulfill({ json: { assetId: clip.id, edits: route.request().postDataJSON().edits } });
    });
    await page.goto(`/photos/${clip.id}`);
    await page.keyboard.press('e');
    await expect(page.getByRole('dialog', { name: /Edit/ })).toBeVisible();
  });

  test('opens on Trim with the transport and filmstrip, and the prototype tools', async ({ page }) => {
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await expect(editor.getByRole('tab', { name: 'Trim' })).toHaveAttribute('aria-selected', 'true');
    for (const tool of ['Speed', 'Adjust', 'Crop', 'Audio', 'Text', 'Enhance', 'Presets']) {
      await expect(editor.getByRole('tab', { name: tool })).toBeVisible();
    }
    await expect(editor.getByRole('slider', { name: 'Trim in' })).toBeVisible();
    await expect(editor.getByRole('slider', { name: 'Playhead' })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Save version' })).toBeEnabled();
  });

  test('saves trim, speed and a title as one version', async ({ page }) => {
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByLabel('In (seconds)').fill('2');
    await editor.getByLabel('In (seconds)').blur();
    await editor.getByRole('tab', { name: 'Speed' }).click();
    await editor.getByRole('radio', { name: '2×' }).first().click();
    await editor.getByRole('tab', { name: 'Text' }).click();
    await editor.getByRole('button', { name: 'Add text' }).click();
    await editor.getByRole('radio', { name: 'Top left' }).click();

    const saved = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith(`/api/assets/${clip.id}/edits`),
    );
    await editor.getByRole('button', { name: 'Save version' }).click();
    const request = await saved;
    const { edits } = request.postDataJSON();
    expect(edits).toEqual(
      expect.arrayContaining([
        { action: 'trim', parameters: { startMs: 2000, endMs: 24_000 } },
        { action: 'speed', parameters: { rate: 2 } },
        expect.objectContaining({
          action: 'textOverlay',
          parameters: expect.objectContaining({ text: 'Title', position: 'top-left', shadow: true }),
        }),
      ]),
    );
    await expect(editor).toBeHidden();
  });

  test('undoes with the keyboard and marks the in point with I', async ({ page }) => {
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByRole('tab', { name: 'Audio' }).click();
    const mute = editor.getByRole('switch', { name: 'Mute clip' });
    await mute.click();
    await expect(mute).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(mute).toHaveAttribute('aria-checked', 'false');
    await editor.getByRole('tab', { name: 'Trim' }).click();
    await page.keyboard.press('i');
    await expect(editor.getByRole('status').last()).toHaveText(/In point 00:00\.0/);
  });
});
