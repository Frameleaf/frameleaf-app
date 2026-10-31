import { expect, Locator, test } from '@playwright/test';
import { assetViewerUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

/**
 * The video quick editor draws the clip (and the split view's before canvas) centred in its
 * `.ed-media` box, as the photo editor draws its image. Only the img was positioned, so the video
 * and canvas showed their bottom-right quarter only.
 */
const expectCentred = async (media: Locator) => {
  const box = await media.boundingBox();
  const parent = await media.locator('xpath=..').boundingBox();
  expect(box && parent).toBeTruthy();
  expect(Math.abs(box!.x + box!.width / 2 - (parent!.x + parent!.width / 2))).toBeLessThan(1);
  expect(Math.abs(box!.y + box!.height / 2 - (parent!.y + parent!.height / 2))).toBeLessThan(1);
};

test.describe('video quick editor layout', () => {
  const fixture = setupAssetViewerFixture(4113);

  test('centres the clip and the split view canvas in the frame', async ({ page }) => {
    const video = fixture.assets.find((asset) => asset.isVideo)!;
    await page.route(`**/api/assets/${video.id}/edits`, (route) =>
      route.fulfill({
        json: { assetId: video.id, edits: [], originalVideo: { width: 1920, height: 1080, durationMs: 24_000 } },
      }),
    );
    // Playback never answers, so the editor keeps its <video> (a load error swaps in the poster image).
    await page.route(`**/api/assets/${video.id}/video/playback**`, () => {});
    await page.goto(`/photos/${video.id}`);
    await assetViewerUtils.waitForViewerLoad(page, video);
    await page.keyboard.press('e');
    const editor = page.getByRole('dialog', { name: /Edit/ });
    await expect(editor).toBeVisible();

    await expectCentred(editor.locator('.ed-media > video'));
    await editor.getByRole('button', { name: 'Split view before and after' }).click();
    await expectCentred(editor.locator('.ed-media > canvas'));
    await expectCentred(editor.locator('.ed-media > video'));
  });
});
