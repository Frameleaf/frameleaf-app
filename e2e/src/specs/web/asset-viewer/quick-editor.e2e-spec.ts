import {
  AssetDevelopRevisionStatus,
  AssetMediaResponseDto,
  getAssetDevelop,
  getDevelopPresets,
  lockAuthSession,
  LoginResponseDto,
  setupPinCode,
  unlockAuthSession,
} from '@frameleaf/sdk';
import { expect } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';
import { test, withAssetReadySetup } from 'src/web-test.js';

/**
 * FL-113 (VID-105): the full-screen photo quick editor against a real server.
 * Hold-to-compare (`\` primary, Y kept), the Versions top-bar menu, and Save version, which
 * stores a new revision, closes the editor and never changes the original.
 * Design: design/frameleaf/template/src/Editor.jsx (September 24, 2026).
 */
test.describe('Quick editor', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(
    withAssetReadySetup(async (signal) => {
      utils.initSdk();
      await utils.resetDatabase();
      admin = await utils.adminSetup();
      asset = await utils.createAsset(admin.accessToken);
      await utils.waitForAssetReady(admin.accessToken, asset.id, { signal });
    }),
  );

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
  test('saves a named preset and reapplies it to another photo after reload (FL-64)', async ({ page, assetReady }) => {
    const headers = asBearerAuth(admin.accessToken);
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByRole('slider', { name: 'Exposure' }).fill('0.75');
    await editor.getByRole('slider', { name: 'Contrast' }).fill('25');
    await editor.getByRole('tab', { name: 'Presets', exact: true }).click();
    await editor.getByRole('textbox', { name: 'Preset name' }).fill('Soft daylight');
    await editor.getByRole('button', { name: 'Save as preset', exact: true }).click();
    await expect(
      editor.getByRole('list', { name: 'Your presets' }).getByRole('button', { name: 'Soft daylight', exact: true }),
    ).toBeVisible();
    expect(await getDevelopPresets({ headers })).toEqual([
      expect.objectContaining({
        name: 'Soft daylight',
        settings: expect.objectContaining({ exposure: 0.75, contrast: 25 }),
      }),
    ]);
    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(editor).toBeHidden();

    const other = await utils.createAsset(admin.accessToken);
    await utils.waitForAssetReady(admin.accessToken, other.id, { signal: assetReady.signal });
    await page.goto(`/photos/${other.id}`);
    await page.reload();
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
    await page.keyboard.press('e');
    await expect(editor.getByRole('slider', { name: 'Exposure' })).toHaveValue('0');
    await expect(editor.getByRole('slider', { name: 'Contrast' })).toHaveValue('0');
    await editor.getByRole('tab', { name: 'Presets', exact: true }).click();
    const preset = editor
      .getByRole('list', { name: 'Your presets' })
      .getByRole('button', { name: 'Soft daylight', exact: true });
    await expect(preset).toHaveAttribute('aria-pressed', 'false');
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
    await editor.getByRole('tab', { name: 'Adjust', exact: true }).click();
    await expect(editor.getByRole('slider', { name: 'Exposure' })).toHaveValue('0.75');
    await expect(editor.getByRole('slider', { name: 'Contrast' })).toHaveValue('25');
    const unsaved = await getAssetDevelop({ id: other.id }, { headers });
    expect(unsaved.revisions).toHaveLength(0);

    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(editor).toBeHidden();
    const saved = await getAssetDevelop({ id: other.id }, { headers });
    expect(saved.revisions).toHaveLength(1);
    expect(saved.revisions[0].recipe).toMatchObject({ exposure: 0.75, contrast: 25 });
    const savedRevisionId = saved.revisions[0].id;
    let pendingRead: ReturnType<typeof getAssetDevelop> | undefined;
    assetReady.onCleanup(async () => {
      try {
        await pendingRead;
      } catch {
        // The assertion owns read failure; teardown joins cancellation before releasing its context.
      }
    });
    // Save queues rendering; reopening uses the published current recipe, not merely a saved row.
    await expect
      .poll(async () => {
        assetReady.signal.throwIfAborted();
        pendingRead = getAssetDevelop({ id: other.id }, { headers, signal: assetReady.signal });
        const state = await pendingRead;
        return {
          currentRevisionId: state.currentRevisionId,
          revision: state.revisions.find((revision) => revision.id === savedRevisionId),
        };
      })
      .toMatchObject({
        currentRevisionId: savedRevisionId,
        revision: {
          id: savedRevisionId,
          status: AssetDevelopRevisionStatus.Rendered,
          isCurrent: true,
          recipe: { exposure: 0.75, contrast: 25 },
        },
      });
    await page.reload();
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
    await page.keyboard.press('e');
    await expect(editor.getByRole('slider', { name: 'Exposure' })).toHaveValue('0.75');
    await expect(editor.getByRole('slider', { name: 'Contrast' })).toHaveValue('25');
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

  test.beforeAll(
    withAssetReadySetup(async (signal) => {
      utils.initSdk();
      await utils.resetDatabase();
      admin = await utils.adminSetup();
      asset = await utils.createAsset(admin.accessToken);
      await utils.waitForAssetReady(admin.accessToken, asset.id, { signal });
    }),
  );

  test('keeps the draft across Studio and back', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/photos/${asset.id}`);
    // E is the viewer's shortcut, so it only works once the viewer has loaded the item.
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
    await page.keyboard.press('e');
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByRole('slider', { name: 'Exposure' }).fill('0.5');

    // With unsaved edits the More menu offers Studio with or without them; the draft is kept either way.
    await editor.getByRole('button', { name: 'More actions', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Open in Studio without these edits', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(String.raw`/studio\?assets=${asset.id}&from=${asset.id}`));

    // The waiting-draft notice and the Studio header both offer the same return action.
    await page
      .getByTestId('studio-quick-edit-waiting')
      .getByRole('button', { name: 'Back to quick edit', exact: true })
      .click();
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
    // `clip.mp4` is a PNG. Some Chromium builds parse it as a ~0.04 s clip and clamp every seek to
    // that, others reject it; refuse playback so the editor always uses its still-preview transport.
    await page.route(`**/api/assets/${clip.id}/video/playback**`, (route) => route.fulfill({ status: 404 }));
    await page.goto(`/photos/${clip.id}`);
    // E is the viewer's shortcut, so it only works once the viewer has loaded the item and its actions.
    await expect(
      page.getByRole('toolbar', { name: 'Media actions' }).getByRole('button', { name: 'Edit', exact: true }),
    ).toBeVisible();
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

  test('restores a video draft and playhead after reload, then clears both when the session locks', async ({
    page,
  }) => {
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await editor.getByRole('tab', { name: 'Audio' }).click();
    await editor.getByRole('switch', { name: 'Mute clip' }).click();
    await editor.getByRole('slider', { name: 'Playhead' }).fill('6');
    await expect(editor.getByRole('switch', { name: 'Mute clip' })).toHaveAttribute('aria-checked', 'true');
    await expect(editor.locator('.ed-timecode')).toHaveText('00:06.0 / 00:24.0');

    const draftKey = `frameleaf.editor.continuity.${clip.id}`;
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).not.toBeNull();
    await page.reload();
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('tab', { name: 'Audio' })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.getByRole('switch', { name: 'Mute clip' })).toHaveAttribute('aria-checked', 'true');
    await expect(editor.getByRole('slider', { name: 'Playhead' })).toHaveValue('6');
    await expect(editor.locator('.ed-timecode')).toHaveText('00:06.0 / 00:24.0');

    const headers = asBearerAuth(admin.accessToken);
    const pinCode = '246810';
    await setupPinCode({ pinCodeSetupDto: { pinCode } }, { headers });
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    await page.reload();
    await expect(editor.getByRole('slider', { name: 'Playhead' })).toHaveValue('6');
    await expect(page.getByRole('button', { name: 'Hide Locked content', includeHidden: true }).first()).toBeAttached();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('frameleaf:session:elevated-tab'))).toBe('1');

    await lockAuthSession({ headers });
    await expect(page).toHaveURL(/\/photos(?:\?|$)/);
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
    await page.goto(`/photos/${clip.id}`);
    await expect(
      page.getByRole('toolbar', { name: 'Media actions' }).getByRole('button', { name: 'Edit', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Edit/ })).toHaveCount(0);
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
  });
});
