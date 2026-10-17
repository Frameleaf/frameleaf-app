import { AssetMediaResponseDto, LoginResponseDto } from '@frameleaf/sdk';
import { expect, type Page, test } from '@playwright/test';
import { utils } from 'src/utils.js';

const footerPause = (page: Page) => page.getByTestId('viewer-footer').getByRole('button', { name: 'Pause slideshow' });
const footerPlay = (page: Page) => page.getByTestId('viewer-footer').getByRole('button', { name: 'Play slideshow' });

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
    // Play slideshow is offered once the viewer knows the item it moves to. Opened before that, the
    // More menu grows by that entry while it is open and the entries under the pointer move.
    await expect(page.getByTestId('viewer-footer').getByRole('button', { name: 'Play slideshow' })).toBeEnabled();
    await page.getByRole('button', { name: /^More( actions)?$/ }).click();
    await page.getByRole('menuitem', { name: 'Play slideshow' }).click();
  };

  // VIEWER-P1 (MediaViewer.jsx:1008-1298, 1704-1720): the slideshow keeps the viewer's header and
  // footer; Play turns into Pause.
  test('open slideshow', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);
    await expect(footerPause(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close viewer' })).toBeVisible();
    await expect(page.getByTestId('slideshow-controls')).toHaveCount(0);
  });

  test('Pause and Play toggle the slideshow', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await footerPause(page).click();
    await expect(footerPlay(page)).toBeVisible();
    await footerPlay(page).click();
    await expect(footerPause(page)).toBeVisible();
  });

  // MediaViewer.jsx:744-757: outside full screen, Escape closes the viewer, and the slideshow with it.
  test('Escape closes the viewer and ends the slideshow', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await expect(footerPause(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);

    await page.goto(`/photos/${asset.id}`);
    await expect(footerPlay(page)).toBeVisible();
  });

  // Owner, 2026-10-16: in a full-screen slideshow Escape leaves full screen and ends the slideshow, back
  // in the viewer; the next Escape closes the viewer. One press never does both, whether the browser
  // leaves full screen itself or the page hears the key first.
  test('Escape in full screen leaves full screen and ends the slideshow; the next Escape closes', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);
    const inFullscreen = () => page.evaluate(() => !!document.fullscreenElement);

    await page.getByRole('button', { name: 'Enter full screen' }).click();
    await expect.poll(inFullscreen).toBe(true);
    await expect(footerPause(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect.poll(inFullscreen).toBe(false);
    await expect(footerPlay(page)).toBeVisible();
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();

    // past the moment a key from the exit could still arrive
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
  });

  // FL-36: the settings are the prototype's non-modal panel with the five transitions, Fade by default.
  test('slideshow settings offer the transitions', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    const panel = page.getByRole('region', { name: 'Slideshow' });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // MediaViewer.jsx:510-513: focus starts on Photo duration
    await expect(panel.getByLabel('Photo duration')).toBeFocused();
    // VIEWER-P2: Repeat and the progress bar are checkboxes; there is no Autoplay switch
    await expect(panel.getByRole('checkbox', { name: 'Repeat collection' })).toBeVisible();
    await expect(panel.getByRole('checkbox', { name: 'Show progress bar' })).toBeChecked();
    await expect(panel.getByRole('switch')).toHaveCount(0);
    const transition = panel.getByLabel('Transition');
    await expect(transition).toHaveValue('fade');
    await expect(transition.locator('option')).toHaveText(['None', 'Fade (default)', 'Slide', 'Ken Burns', 'Memories']);

    await transition.selectOption('memories');
    expect(await page.evaluate(() => localStorage.getItem('slideshow-transition'))).toBe('"memories"');

    await panel.getByRole('button', { name: 'Close slideshow settings' }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Slideshow settings' })).toBeFocused();
    await expect(footerPause(page)).toBeVisible();
  });

  // FL-36: the old on/off switch reads back as the transition it meant.
  test('a stored transition switch migrates to None', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await context.addInitScript(() => localStorage.setItem('slideshow-transition', 'false'));
    await openSlideshow(page);

    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    await expect(page.getByRole('region', { name: 'Slideshow' }).getByLabel('Transition')).toHaveValue('none');
  });

  // V-18 (MediaViewer.jsx:254-263): the slideshow plays in the viewer; full screen is a choice.
  test('plays in the viewer without forcing full screen', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await expect(footerPause(page)).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(page.getByRole('button', { name: 'Enter full screen' })).toBeVisible();
  });

  // MediaViewer.jsx:733-747: Escape closes the settings first; the slideshow keeps playing.
  test('Escape closes the settings before anything else', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    const panel = page.getByRole('region', { name: 'Slideshow' });
    await expect(panel).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();
    await expect(footerPause(page)).toBeVisible();
  });

  // VIEWER-P1: no idle hide (the template has none); the chrome stays until a tap on the photo.
  test('keeps the chrome on screen while it plays', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await openSlideshow(page);

    await page.waitForTimeout(3500);
    await expect(page.locator('#immich-asset-viewer')).not.toHaveClass(/chrome-hidden/);
    await expect(footerPause(page)).toBeVisible();
  });
});
