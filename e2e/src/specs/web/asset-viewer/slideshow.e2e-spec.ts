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

    await page.mouse.move(10, 10);
    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    const panel = page.getByRole('region', { name: 'Slideshow' });
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
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

    await page.mouse.move(10, 10);
    await page.getByRole('button', { name: 'Slideshow settings' }).click();
    await expect(page.getByRole('region', { name: 'Slideshow' }).getByLabel('Transition')).toHaveValue('none');
  });
});
