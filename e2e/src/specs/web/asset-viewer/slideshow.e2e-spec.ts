import { AssetMediaResponseDto, LoginResponseDto } from '@immich/sdk';
import { expect, type Page, test } from '@playwright/test';
import { utils } from 'src/utils.js';

test.describe('Slideshow', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
    // MediaViewer.jsx offers Play slideshow only when there is another item to move to.
    await utils.createAsset(admin.accessToken);
  });

  const openSlideshow = async (page: Page) => {
    await page.goto(`/photos/${asset.id}`);
    await page.waitForSelector('#immich-asset-viewer');
    await page.getByRole('button', { name: /^More( actions)?$/ }).click();
    await page.getByRole('menuitem', { name: 'Play slideshow' }).click();
  };

  test('open slideshow', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);
    await expect(page.getByRole('button', { name: 'Exit Slideshow' })).toBeVisible();
  });

  test('exit slideshow with button', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    const exitButton = page.getByRole('button', { name: 'Exit Slideshow' });
    await exitButton.click();
    await expect(exitButton).not.toBeVisible();
  });

  test('exit slideshow with shortcut', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    const exitButton = page.getByRole('button', { name: 'Exit Slideshow' });
    await expect(exitButton).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(exitButton).not.toBeVisible();
  });

  test('favorite shortcut is disabled', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await expect(page.getByRole('button', { name: 'Exit Slideshow' })).toBeVisible();
    await page.keyboard.press('f');
    await expect(page.getByText('Added to favorites')).not.toBeVisible();
  });

  // FL-36: the settings are the prototype's non-modal panel with the five transitions, Fade by default.
  test('slideshow settings offer the transitions', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await page.mouse.move(200, 200);
    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    const panel = page.getByRole('region', { name: 'Slideshow' });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // MediaViewer.jsx:499-502: focus starts on Photo duration
    await expect(panel.getByLabel('Photo duration')).toBeFocused();
    // source behaviour retained: the Autoplay preference stays reachable
    await expect(panel.getByRole('switch', { name: 'Autoplay slideshow' })).toBeVisible();
    const transition = panel.getByLabel('Transition');
    await expect(transition).toHaveValue('fade');
    await expect(transition.locator('option')).toHaveText(['None', 'Fade (default)', 'Slide', 'Ken Burns', 'Memories']);

    await transition.selectOption('memories');
    expect(await page.evaluate(() => localStorage.getItem('slideshow-transition'))).toBe('"memories"');

    await panel.getByRole('button', { name: 'Close slideshow settings' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Slideshow settings' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Exit Slideshow' })).toBeVisible();
  });

  // FL-36: the old on/off switch reads back as the transition it meant.
  test('a stored transition switch migrates to None', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await context.addInitScript(() => localStorage.setItem('slideshow-transition', 'false'));
    await openSlideshow(page);

    await page.mouse.move(200, 200);
    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    await expect(page.getByRole('region', { name: 'Slideshow' }).getByLabel('Transition')).toHaveValue('none');
  });

  // V-18 (MediaViewer.jsx:254-263): the slideshow plays in the viewer; full screen is a choice.
  test('plays in the viewer without forcing full screen', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await expect(page.getByRole('toolbar', { name: 'Slideshow' })).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(page.getByRole('button', { name: 'Enter full screen' })).toBeVisible();
  });

  // MediaViewer.jsx:733-747: Escape closes the settings first, then ends the slideshow.
  test('Escape closes the settings before it ends the slideshow', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await page.mouse.move(200, 200);
    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    const panel = page.getByRole('region', { name: 'Slideshow' });
    await expect(panel).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    const exitButton = page.getByRole('button', { name: 'Exit Slideshow' });
    await expect(exitButton).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(exitButton).not.toBeVisible();
  });

  // Source behaviour: the controls and the pointer hide after 2.5 s idle; moving the pointer shows them.
  test('hides the controls when idle and shows them on movement', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    const controls = page.getByRole('toolbar', { name: 'Slideshow' });
    await expect(controls).toHaveClass(/chrome-hidden/, { timeout: 5000 });
    await page.mouse.move(300, 300);
    await expect(controls).not.toHaveClass(/chrome-hidden/);
  });
});
