import { expect, Page, test } from '@playwright/test';
import { assetViewerUtils, pageUtils, thumbnailUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

/**
 * FL-1833: the slideshow's keys and states from the audit. S and Space pause and resume a running
 * slideshow (the photo viewer's own S and Space used to take the key first), an item reached while
 * paused is shown rather than held at the transparent first frame of its transition, and closing
 * the viewer ends the slideshow.
 */
const footer = (page: Page) => page.getByTestId('viewer-footer');

test.describe('slideshow keys and states', () => {
  const fixture = setupAssetViewerFixture(1833);

  test.beforeEach(async ({ context }) => {
    // A minute per photo, so only the test moves the slideshow.
    await context.addInitScript(() => localStorage.setItem('slideshow-delay', '60'));
  });

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

  // FL-1834: Ascending from the top begins at the last item; Repeat goes back to the collection's start.
  const openFromTimeline = async (page: Page, assetId: string) => {
    const asset = fixture.assets.find((candidate) => candidate.id === assetId)!;
    await pageUtils.deepLinkPhotosPage(page, assetId);
    await thumbnailUtils.clickAssetId(page, assetId);
    await assetViewerUtils.waitForViewerLoad(page, asset);
    await expect(footer(page).getByRole('button', { name: 'Play slideshow' })).toBeEnabled();
  };

  test('an Ascending slideshow started on the first item begins at the last', async ({ context, page }) => {
    await context.addInitScript(() => localStorage.setItem('slideshow-navigation', JSON.stringify('ascending-order')));
    const first = fixture.assets[0];
    const last = fixture.assets.at(-1)!;
    await openFromTimeline(page, first.id);
    await page.keyboard.press('s');
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', last.id, { timeout: 15_000 });
    await expect(footer(page).getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  });

  test('Repeat goes back to the first item of the collection, not the item it started on', async ({
    context,
    page,
  }) => {
    await context.addInitScript(() => {
      localStorage.setItem('slideshow-delay', '1');
      localStorage.setItem('slideshow-repeat', 'true');
      localStorage.setItem('slideshow-navigation', JSON.stringify('descending-order'));
    });
    const first = fixture.assets[0];
    const last = fixture.assets.at(-1)!;
    await openFromTimeline(page, last.id);
    await page.keyboard.press('s');
    await expect(page.locator('#immich-asset-viewer')).toHaveAttribute('data-asset-id', first.id, { timeout: 15_000 });
    await expect(footer(page).getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  });
});
