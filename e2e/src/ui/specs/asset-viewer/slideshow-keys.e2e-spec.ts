import { expect, Page, test } from '@playwright/test';
import { assetViewerUtils, pageUtils, thumbnailUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

/**
 * FL-1833: the slideshow's keys and states from the audit. S and Space pause and resume a running
 * slideshow (the photo viewer's own S and Space used to take the key first), an item reached while
 * paused is shown rather than held at the transparent first frame of its transition, and closing
 * the viewer ends the slideshow.
 */
test.describe('slideshow keys and states', () => {
  const fixture = setupAssetViewerFixture(1833);

  test.beforeEach(async ({ context }) => {
    // A minute per photo, so only the test moves the slideshow.
    await context.addInitScript(() => localStorage.setItem('slideshow-delay', '60'));
  });

  const footer = (page: Page) => page.getByTestId('viewer-footer');
  const openPhoto = async (page: Page) => {
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    // S plays only once the neighbours are known, as the footer's Play does
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeEnabled();
  };

  test('S and Space pause and resume a slideshow started with S', async ({ page }) => {
    await openPhoto(page);
    await page.keyboard.press('s');
    await expect(footer(page).getByRole('button', { name: 'Pause slideshow' })).toBeVisible();

    await page.keyboard.press('s');
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeVisible();
    await page.keyboard.press('s');
    await expect(footer(page).getByRole('button', { name: 'Pause slideshow' })).toBeVisible();

    await page.keyboard.press(' ');
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeVisible();
    await page.keyboard.press(' ');
    await expect(footer(page).getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  });

  test('an item reached while paused is shown at once', async ({ page }) => {
    await openPhoto(page);
    await page.keyboard.press('s');
    await page.keyboard.press(' ');
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeVisible();
    const id = await page.locator('#immich-asset-viewer').getAttribute('data-asset-id');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#immich-asset-viewer')).not.toHaveAttribute('data-asset-id', id!);
    // the fade-in is finished, not held at its transparent first frame
    await expect(page.locator('.fl-viewer-stage')).toHaveCSS('opacity', '1');
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeVisible();
  });

  test('closing the viewer ends the slideshow', async ({ page }) => {
    // in-app navigation, as on an iPad: open from the timeline, start, then go back with the browser
    await pageUtils.deepLinkPhotosPage(page, fixture.primaryAsset.id);
    await thumbnailUtils.clickAssetId(page, fixture.primaryAsset.id);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeEnabled();
    await page.keyboard.press('s');
    await expect(page.getByTestId('slideshow-progress')).toBeAttached();

    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);

    await thumbnailUtils.clickAssetId(page, fixture.primaryAsset.id);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeVisible();
    await expect(page.getByTestId('slideshow-progress')).toHaveCount(0);
  });
});
