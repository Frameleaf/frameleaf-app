import { expect, Page, test } from '@playwright/test';
import { randomPreview } from 'src/ui/generators/timeline';
import { assetViewerUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

/**
 * FL-1832: on an iPad a tap on the photo during a slideshow hides the header, footer and arrows, and
 * a second tap or a swipe down brings them back. The `ui` project runs this in Chromium with touch on;
 * `PLAYWRIGHT_IPAD_WEBKIT=1 … --project=ui-ipad-webkit` runs it in WebKit with an iPad profile.
 * Playwright cannot make iPadOS's own gesture handling, so the touches iPadOS ends differently (a
 * `pointercancel` for a still finger, a finger that drifts a few points) are dispatched directly.
 */
test.use({ viewport: { width: 834, height: 1194 }, hasTouch: true });

const viewer = (page: Page) => page.locator('#immich-asset-viewer');
const middle = (page: Page) => {
  const { width, height } = page.viewportSize()!;
  return { x: width / 2, y: height / 2 };
};

/** One touch on the photo, ended the way iPadOS may end it. */
const touch = (page: Page, path: { x: number; y: number }[], end: 'pointerup' | 'pointercancel') =>
  page.evaluate(
    ({ path, end }) => {
      const [first] = path;
      const target = document.elementFromPoint(first.x, first.y)!;
      const init = { bubbles: true, cancelable: true, pointerId: 1832, pointerType: 'touch', isPrimary: true };
      target.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: first.x, clientY: first.y }));
      for (const point of path.slice(1)) {
        target.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: point.x, clientY: point.y }));
      }
      const last = path.at(-1)!;
      // iPadOS's cancel carries no position
      const at = end === 'pointercancel' ? { clientX: 0, clientY: 0 } : { clientX: last.x, clientY: last.y };
      target.dispatchEvent(new PointerEvent(end, { ...init, ...at }));
    },
    { path, end },
  );

test.describe('slideshow on a touch tablet', () => {
  const fixture = setupAssetViewerFixture(1832);

  test.beforeEach(async ({ context }) => {
    // The WebKit lane blocks the service worker, so the page asks for the images itself.
    await context.route('**/api/assets/*/thumbnail?size=*', async (route) =>
      route.fulfill({ status: 200, contentType: 'image/jpeg', body: await randomPreview(route.request().url(), 1.5) }),
    );
    // A minute per photo, so the slideshow stays on one item while the test taps.
    await context.addInitScript(() => localStorage.setItem('slideshow-delay', '60'));
  });

  const startSlideshow = async (page: Page) => {
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await page.getByTestId('viewer-footer').getByRole('button', { name: 'Play slideshow' }).tap();
    await expect(page.getByTestId('viewer-footer').getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  };

  test('a tap hides the controls, a second tap or a swipe down shows them', async ({ page }) => {
    await startSlideshow(page);
    const { x, y } = middle(page);

    await page.evaluate(() =>
      document.addEventListener('pointerdown', (e) => (document.body.dataset.pointerType = e.pointerType), {
        once: true,
      }),
    );
    await page.touchscreen.tap(x, y);
    // the lane really sends touch input, not mouse events
    await expect(page.locator('body')).toHaveAttribute('data-pointer-type', 'touch');
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
    await expect(page.locator('[data-viewer-footer]')).toHaveCSS('opacity', '0');
    await expect(page.locator('[data-viewer-chrome="header"]')).toHaveCSS('opacity', '0');

    // taps 100 px apart, so the photo's double-tap zoom (32 px, 300 ms) never takes them
    await page.touchscreen.tap(x, y - 100);
    await expect(viewer(page)).not.toHaveClass(/chrome-hidden/);

    await page.touchscreen.tap(x, y + 100);
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
    await touch(
      page,
      [
        { x, y },
        { x, y: y + 40 },
        { x, y: y + 90 },
      ],
      'pointerup',
    );
    await expect(viewer(page)).not.toHaveClass(/chrome-hidden/);
    // the slideshow keeps playing throughout
    await expect(page.getByTestId('viewer-footer').getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  });

  test('a still touch that iPadOS ends with pointercancel is still a tap', async ({ page }) => {
    await startSlideshow(page);
    const { x, y } = middle(page);
    await touch(page, [{ x, y }], 'pointercancel');
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
    // a touch that moved before the cancel was a gesture, not a tap
    await touch(
      page,
      [
        { x, y },
        { x: x + 30, y },
      ],
      'pointercancel',
    );
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
  });

  test("a finger's few points of drift still taps; a drag does not", async ({ page }) => {
    await startSlideshow(page);
    const { x, y } = middle(page);
    await touch(
      page,
      [
        { x, y },
        { x: x + 5, y: y + 5 },
      ],
      'pointerup',
    );
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
    await touch(
      page,
      [
        { x, y },
        { x: x + 25, y },
      ],
      'pointerup',
    );
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
  });

  test('a mouse click on the photo still toggles', async ({ page }) => {
    await startSlideshow(page);
    const { x, y } = middle(page);
    await page.mouse.click(x, y);
    await expect(viewer(page)).toHaveClass(/chrome-hidden/);
    await page.mouse.click(x, y);
    await expect(viewer(page)).not.toHaveClass(/chrome-hidden/);
  });
});
