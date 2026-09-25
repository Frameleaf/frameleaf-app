import { AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
import { BrowserContext, expect, test } from '@playwright/test';
import { SeededRandom, selectRandom, toAssetResponseDto } from 'src/ui/generators/timeline';
import { setupSocketMock } from 'src/ui/mock-network/socket-network.js';
import { assetViewerUtils } from '../timeline/utils';
import { enableTagsPreference, setupAssetViewerFixture } from './utils';

/**
 * FL-35: the viewer's media sources over the mocked API (not run locally; the lead runs the stack):
 * a Live Photo, a panorama, a video's original or encoded rendition, an unavailable original, and the
 * September 24 More menu, rating and tag keys. Each case serves the open item with the fields that make
 * it that kind of item.
 */
const serveAsset = async (context: BrowserContext, dto: AssetResponseDto) => {
  await context.route(`**/api/assets/${dto.id}`, async (route, request) => {
    if (request.method() !== 'GET') {
      return route.fallback();
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: dto });
  });
};

const enableRatings = async (context: BrowserContext) => {
  await context.route('**/users/me/preferences', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    return route.fulfill({ response, json: { ...json, ratings: { enabled: true } } });
  });
};

test.describe.configure({ mode: 'parallel' });
test.describe('viewer media sources', () => {
  const fixture = setupAssetViewerFixture(3517);
  const rng = new SeededRandom(3517);

  test('a Live Photo plays from the on-photo badge (V-16)', async ({ context, page }) => {
    const dto = { ...fixture.primaryAssetDto, livePhotoVideoId: fixture.assets.find((a) => a.isVideo)?.id ?? null };
    await serveAsset(context, dto);
    await page.goto(`/photos/${dto.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);

    const badge = page.getByTestId('viewer-live-badge');
    await expect(badge).toHaveAccessibleName('Play live clip');
    await expect(page.getByTestId('asset-viewer-navbar-actions').getByLabel('Play Motion Photo')).toHaveCount(0);
    await badge.click();
    await expect(badge).toHaveAttribute('aria-pressed', 'true');
  });

  test('a panorama offers Look around and Fit in the footer', async ({ context, page }) => {
    const dto = {
      ...fixture.primaryAssetDto,
      exifInfo: { ...fixture.primaryAssetDto.exifInfo, projectionType: 'EQUIRECTANGULAR' },
    };
    await serveAsset(context, dto);
    await page.goto(`/photos/${dto.id}`);
    const footer = page.getByTestId('viewer-footer');
    await expect(footer.getByRole('button', { name: /panorama/i })).toBeVisible();
  });

  test('a video switches between its original and encoded rendition', async ({ page }) => {
    const video = selectRandom(
      fixture.assets.filter((asset) => asset.isVideo),
      rng,
    );
    await page.goto(`/photos/${video.id}`);
    await assetViewerUtils.waitForViewerLoad(page, video);
    const source = page.getByTestId('viewer-footer').getByRole('group', { name: 'Video source' });
    await expect(source.getByRole('button', { name: 'Play encoded' })).toHaveAttribute('aria-pressed', 'true');
    await source.getByRole('button', { name: 'Play original' }).click();
    await expect(source.getByRole('button', { name: 'Play original' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('an unavailable original says so and offers the relink route', async ({ context, page }) => {
    const dto = { ...fixture.primaryAssetDto, isOffline: true };
    await serveAsset(context, dto);
    await page.goto(`/photos/${dto.id}`);
    await expect(page.getByText('Original file unavailable')).toBeVisible();
  });

  test('the More menu follows the template (V-7, V-11)', async ({ page }) => {
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await page.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu');
    for (const heading of ['Download', 'Organize', 'Go to', 'Jobs', 'Viewer']) {
      await expect(menu.getByText(heading, { exact: true })).toBeVisible();
    }
    await expect(menu.getByRole('menuitem', { name: 'Find similar' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Slideshow settings' })).toBeVisible();
    // tagging and the video source live in the information panel and the footer
    await expect(menu.getByRole('menuitem', { name: 'Add tag' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: /Play (original|transcoded) video/ })).toHaveCount(0);
  });

  test('a still offers no video jobs and a video offers both encode jobs', async ({ page }) => {
    const video = selectRandom(
      fixture.assets.filter((asset) => asset.isVideo),
      rng,
    );
    await page.goto(`/photos/${video.id}`);
    await assetViewerUtils.waitForViewerLoad(page, video);
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Refresh encoded video' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Transcode video' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Refresh faces' })).toHaveCount(0);
  });

  test('the top row rates the item (V-3)', async ({ context, page }) => {
    await enableRatings(context);
    let sent: unknown;
    await context.route(`**/api/assets/${fixture.primaryAsset.id}`, async (route, request) => {
      if (request.method() === 'PUT') {
        sent = request.postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', json: fixture.primaryAssetDto });
      }
      return route.fallback();
    });
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await page.getByTestId('viewer-rating-button').click();
    const stars = page.getByRole('group', { name: 'Rate this item' });
    await stars.getByRole('button', { name: 'Rate 3 stars' }).click();
    await expect.poll(() => sent).toEqual({ rating: 3 });
    await expect(stars).toHaveCount(0);
  });

  test('T opens the information panel on the tag box (V-15, V-25)', async ({ context, page }) => {
    await enableTagsPreference(context);
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await page.keyboard.press('t');
    await expect(page.getByRole('combobox', { name: 'Add a tag' })).toBeFocused();
  });

  test('Space plays the slideshow unless a control has focus (V-15)', async ({ page }) => {
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
    await page.getByRole('button', { name: 'More actions' }).focus();
    await page.keyboard.press(' ');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#immich-asset-viewer').focus();
    await page.keyboard.press(' ');
    await expect(page.getByTestId('viewer-footer').getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  });

  test('a video item is never offered as a Live Photo', async ({ page }) => {
    const video = selectRandom(
      fixture.assets.filter((asset) => asset.isVideo),
      rng,
    );
    const dto = toAssetResponseDto(video);
    expect(dto.type).toBe(AssetTypeEnum.Video);
    await page.goto(`/photos/${video.id}`);
    await assetViewerUtils.waitForViewerLoad(page, video);
    await expect(page.getByTestId('viewer-live-badge')).toHaveCount(0);
  });

  /**
   * FL-35: an item locked or removed elsewhere while a slideshow plays gives way to an authorized
   * neighbour. The slideshow waits a minute per item here, so only the event can move the viewer.
   */
  for (const [name, send] of [
    [
      'locked elsewhere',
      (socket: Awaited<ReturnType<typeof setupSocketMock>>, dto: AssetResponseDto) =>
        socket.emit('on_asset_update', { ...dto, visibility: 'locked' }),
    ],
    [
      'moved to the trash elsewhere',
      (socket: Awaited<ReturnType<typeof setupSocketMock>>, dto: AssetResponseDto) =>
        socket.emit('on_asset_trash', [dto.id]),
    ],
  ] as const) {
    test(`a slideshow moves on when its item is ${name}`, async ({ context, page }) => {
      await context.addInitScript(() => localStorage.setItem('slideshow-delay', '60'));
      const socket = await setupSocketMock(context);
      const index = fixture.assets.indexOf(fixture.primaryAsset);
      await page.goto(`/photos/${fixture.primaryAsset.id}`);
      await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);
      await expect.poll(() => socket.connected()).toBe(1);
      await page.locator('#immich-asset-viewer').focus();
      await page.keyboard.press('s');
      await expect(page.getByTestId('viewer-footer').getByRole('button', { name: 'Pause slideshow' })).toBeVisible();

      send(socket, fixture.primaryAssetDto);

      await assetViewerUtils.waitForViewerLoad(page, fixture.assets[index + 1] ?? fixture.assets[index - 1]);
    });
  }
});
