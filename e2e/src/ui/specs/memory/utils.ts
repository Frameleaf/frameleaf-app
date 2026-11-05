/* eslint-disable unicorn/no-this-outside-of-class */
import type { AssetResponseDto } from '@frameleaf/sdk';
import { expect, Page } from '@playwright/test';

function getAssetIdFromUrl(url: URL): string | null {
  const pathMatch = url.pathname.match(/\/memories\/[^/]+\/photos\/([^/]+)/);
  if (pathMatch) {
    return pathMatch[1];
  }
  return url.searchParams.get('assetId');
}

export const memoryViewerUtils = {
  locator(page: Page) {
    return page.locator('#memory-viewer');
  },

  async waitForMemoryLoad(page: Page) {
    await expect(this.locator(page)).toBeVisible();
    // A photo shows as an image; a video's poster image gives way to the playing video.
    await expect(page.locator('#memory-viewer').locator('img, video').filter({ visible: true }).first()).toBeVisible();
  },

  async openMemoryPageWithAsset(page: Page, memoryId: string, assetId: string) {
    await page.goto(`/memories/${memoryId}?assetId=${assetId}`);
    await this.waitForMemoryLoad(page);
  },
};

export const memoryGalleryUtils = {
  /** The player's "Show all items" sheet over the stage (UI 22: replaced the gallery under the player). */
  locator(page: Page) {
    return page.getByRole('region', { name: 'All items in this memory' });
  },

  thumbnailWithAssetId(page: Page, assetId: string) {
    return this.locator(page)
      .getByRole('button')
      .filter({ has: page.locator(`img[src*="/api/assets/${assetId}/"]`) });
  },

  async openGallery(page: Page) {
    if (!(await this.locator(page).isVisible())) {
      await page.getByRole('button', { name: 'Show all items' }).click();
    }
    await expect(this.locator(page)).toBeVisible();
  },

  /** Picks the item in the gallery, then opens it in the asset viewer with the player's Open item. */
  async clickThumbnail(page: Page, assetId: string) {
    await this.openGallery(page);
    await this.thumbnailWithAssetId(page, assetId).click();
    await expect(this.locator(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Open item', exact: true }).click();
  },
};

export const memoryAssetViewerUtils = {
  locator(page: Page) {
    return page.locator('#immich-asset-viewer');
  },

  async waitForViewerOpen(page: Page) {
    await expect(this.locator(page)).toBeVisible();
  },

  async waitForAssetLoad(page: Page, asset: AssetResponseDto) {
    const viewer = this.locator(page);
    const imgLocator = viewer.locator(`img[draggable="false"][src*="/api/assets/${asset.id}/thumbnail?size=preview"]`);
    const videoLocator = viewer.locator(`video[poster*="/api/assets/${asset.id}/thumbnail?size=preview"]`);

    await imgLocator.or(videoLocator).waitFor({ timeout: 10_000 });
  },

  nextButton(page: Page) {
    return page.getByLabel('View next asset');
  },

  previousButton(page: Page) {
    return page.getByLabel('View previous asset');
  },

  async expectNextButtonVisible(page: Page) {
    await expect(this.nextButton(page)).toBeVisible();
  },

  async expectNextButtonNotVisible(page: Page) {
    await expect(this.nextButton(page)).toHaveCount(0);
  },

  async expectPreviousButtonVisible(page: Page) {
    await expect(this.previousButton(page)).toBeVisible();
  },

  async expectPreviousButtonNotVisible(page: Page) {
    await expect(this.previousButton(page)).toHaveCount(0);
  },

  async clickNextButton(page: Page) {
    await this.nextButton(page).click();
  },

  async clickPreviousButton(page: Page) {
    await this.previousButton(page).click();
  },

  async closeViewer(page: Page) {
    await page.keyboard.press('Escape');
    await expect(this.locator(page)).not.toBeVisible();
  },

  getCurrentAssetId(page: Page): string | null {
    const url = new URL(page.url());
    return getAssetIdFromUrl(url);
  },

  async expectCurrentAssetId(page: Page, expectedAssetId: string) {
    await expect.poll(() => this.getCurrentAssetId(page)).toBe(expectedAssetId);
  },
};
