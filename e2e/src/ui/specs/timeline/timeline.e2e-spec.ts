import { faker } from '@faker-js/faker';
import { expect, Page, test } from '@playwright/test';
import { DateTime } from 'luxon';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  getAsset,
  SeededRandom,
  selectRandom,
  selectRandomMultiple,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import {
  pageRoutePromise,
  setupTimelineMockApiRoutes,
  setupTrashMockApiRoutes,
  TimelineTestContext,
} from 'src/ui/mock-network/timeline-network';
import { utils } from 'src/utils.js';
import {
  assetViewerUtils,
  padYearMonth,
  pageUtils,
  poll,
  scrubberUtils,
  selectionBarUtils,
  thumbnailUtils,
  timelineUtils,
} from './utils';

/**
 * The library timeline as the prototype defines it (`TimelineLibrary.jsx`, `App.jsx` layouts and
 * key handling, `shortcuts.mjs`, `SelectionBar.jsx`): Browse is the default layout, D/M/Y group by
 * day, month or year, G goes to a date through the month scrubber, the arrow keys move focus
 * between tiles, and bulk actions run from the selection bar.
 */
test.describe.configure({ mode: 'parallel' });
test.describe('Timeline', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  const assets: TimelineAssetConfig[] = [];
  const yearMonths: string[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = {
    albumAdditions: [],
    assetDeletions: [],
    assetArchivals: [],
    assetFavorites: [],
  };

  test.beforeAll(async () => {
    test.fail(
      process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS !== '1',
      'This test requires env var: PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1',
    );
    utils.initSdk();
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timelineRestData = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    for (const timeBucket of timelineRestData.buckets.values()) {
      assets.push(...timeBucket);
    }
    for (const yearMonth of timelineRestData.buckets.keys()) {
      const [year, month] = yearMonth.split('-', 2);
      yearMonths.push(`${year}-${Number(month)}`);
    }
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
    await setupTrashMockApiRoutes(context, timelineRestData, changes);
  });

  test.afterEach(() => {
    testContext.slowBucket = false;
    changes.albumAdditions = [];
    changes.assetDeletions = [];
    changes.assetArchivals = [];
    changes.assetFavorites = [];
  });

  const assetsInMonth = (yearMonth: string) => assets.filter((asset) => getYearMonth(assets, asset.id) === yearMonth);

  /** Assets deep enough in the library that showing one always scrolls the timeline. */
  const deepAssets = () => assets.slice(100);

  const trashFromSelection = async (page: Page, assetId: string) => {
    await thumbnailUtils.ensureSelected(page, assetId);
    const deleteRequest = pageRoutePromise(page, '**/api/assets', async (route, request) => {
      const requestJson = request.postDataJSON();
      changes.assetDeletions.push(...requestJson.ids);
      await route.fulfill({ status: 204 });
    });
    await selectionBarUtils.action(page, 'Delete').click();
    await expect(deleteRequest).resolves.toEqual({ force: false, ids: [assetId] });
  };

  const restoreFromTrash = async (page: Page, assetId: string) => {
    const row = page.locator('article', { has: page.locator(`img[src*="${assetId}"]`) });
    await expect(row).toBeVisible();
    const restoreRequest = pageRoutePromise(page, '**/api/trash/apply', async (route, request) => {
      const requestJson = request.postDataJSON();
      changes.assetDeletions = changes.assetDeletions.filter((id) => !requestJson.ids.includes(id));
      await route.fulfill({ json: { count: requestJson.ids.length } });
    });
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(restoreRequest).resolves.toEqual({ action: 'restore', ids: [assetId], token: 'review' });
    await expect(row).toHaveCount(0);
  };

  const archiveRequest = (page: Page, visibility: 'archive' | 'timeline') =>
    pageRoutePromise(page, '**/api/assets', async (route, request) => {
      const requestJson = request.postDataJSON();
      if (requestJson.visibility !== visibility) {
        return await route.fallback();
      }
      if (visibility === 'archive') {
        changes.assetArchivals.push(...requestJson.ids);
      } else {
        changes.assetArchivals = changes.assetArchivals.filter((id) => !requestJson.ids.includes(id));
      }
      await route.fulfill({ status: 204 });
    });

  const favoriteRequest = (page: Page) =>
    pageRoutePromise(page, '**/api/assets', async (route, request) => {
      const requestJson = request.postDataJSON();
      if (requestJson.isFavorite === undefined) {
        return await route.fallback();
      }
      if (requestJson.isFavorite) {
        changes.assetFavorites.push(...requestJson.ids);
      } else {
        changes.assetFavorites = changes.assetFavorites.filter((id) => !requestJson.ids.includes(id));
      }
      await route.fulfill({ status: 204 });
    });

  test.describe('/photos', () => {
    test('Persists the initial library view only after the router is ready', async ({ page }) => {
      const routingErrors: string[] = [];
      page.on('pageerror', (error) => {
        if (error.message.includes('before router is initialized')) {
          routingErrors.push(error.message);
        }
      });
      await page.goto('/photos');
      await expect(page.getByRole('button', { name: 'Browse', exact: true })).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.has('fl')).toBe(true);
      await expect(page.getByTestId('frameleaf-show-more')).toHaveCount(0);
      expect(routingErrors).toEqual([]);
    });

    test('Open /photos', async ({ page }) => {
      await page.goto(`/photos`);
      await timelineUtils.waitForTimelineLoad(page);
      // Browse is the default layout (prototype `App.jsx` session.layout).
      await expect(timelineUtils.layoutButton(page, 'Browse')).toHaveAttribute('aria-pressed', 'true');
      await thumbnailUtils.expectTimelineHasOnScreenAssets(page);
    });

    test('Deep link to last photo', async ({ page }) => {
      const lastAsset = assets.at(-1)!;
      await pageUtils.deepLinkPhotosPage(page, lastAsset.id);
      await thumbnailUtils.expectTimelineHasOnScreenAssets(page);
      await thumbnailUtils.expectInViewport(page, lastAsset.id);
      // The linked item takes keyboard focus, so the arrow keys continue from it.
      await assetViewerUtils.expectActiveAssetToBe(page, lastAsset.id);
    });

    const rng = new SeededRandom(529);
    for (let i = 0; i < 10; i++) {
      test('Deep link to random asset ' + i, async ({ page }) => {
        const asset = selectRandom(assets, rng);
        await pageUtils.deepLinkPhotosPage(page, asset.id);
        await thumbnailUtils.expectTimelineHasOnScreenAssets(page);
        await thumbnailUtils.expectInViewport(page, asset.id);
      });
    }

    test('Open /photos, open asset-viewer, browser back', async ({ page }) => {
      const rng = new SeededRandom(22);
      const asset = selectRandom(deepAssets(), rng);
      await pageUtils.deepLinkPhotosPage(page, asset.id);
      const scrollTopBefore = await timelineUtils.getScrollTop(page);
      await thumbnailUtils.clickAssetId(page, asset.id);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page.goBack();
      await timelineUtils.waitForTimelineLoad(page);
      await expect.poll(() => timelineUtils.getScrollTop(page)).toBe(scrollTopBefore);
    });

    test('Open /photos, open asset-viewer, next photo, browser back, back', async ({ page }) => {
      const rng = new SeededRandom(49);
      const asset = selectRandom(deepAssets(), rng);
      const nextAsset = assets[assets.indexOf(asset) + 1];
      await pageUtils.deepLinkPhotosPage(page, asset.id);
      const scrollTopBefore = await timelineUtils.getScrollTop(page);
      await thumbnailUtils.clickAssetId(page, asset.id);
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${asset.id}`);
      await page.getByLabel('View next asset').click();
      await assetViewerUtils.waitForViewerLoad(page, nextAsset);
      await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${nextAsset.id}`);
      await page.goBack();
      await assetViewerUtils.waitForViewerLoad(page, asset);
      await page.goBack();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
      await timelineUtils.waitForTimelineLoad(page);
      await expect
        .poll(async () => Math.abs((await timelineUtils.getScrollTop(page)) - scrollTopBefore))
        .toBeLessThan(5);
    });

    test('Open /photos, open asset-viewer, next photo 15x, backwardsArrow', async ({ page }) => {
      await pageUtils.deepLinkPhotosPage(page, assets[0].id);
      await thumbnailUtils.clickAssetId(page, assets[0].id);
      await assetViewerUtils.waitForViewerLoad(page, assets[0]);
      for (let i = 1; i <= 15; i++) {
        await page.getByLabel('View next asset').click();
        await assetViewerUtils.waitForViewerLoad(page, assets[i]);
      }
      await page.getByRole('button', { name: /^(Go back|Close viewer \(Escape\))$/ }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
      await thumbnailUtils.expectInViewport(page, assets[15].id);
      await thumbnailUtils.expectBottomIsTimelineBottom(page, assets[15].id);
    });

    test('Open /photos, open asset-viewer, previous photo 15x, backwardsArrow', async ({ page }) => {
      const lastAsset = assets.at(-1)!;
      await pageUtils.deepLinkPhotosPage(page, lastAsset.id);
      await thumbnailUtils.clickAssetId(page, lastAsset.id);
      await assetViewerUtils.waitForViewerLoad(page, lastAsset);
      for (let i = 1; i <= 15; i++) {
        await page.getByLabel('View previous asset').click();
        await assetViewerUtils.waitForViewerLoad(page, assets.at(-1 - i)!);
      }
      await page.getByRole('button', { name: /^(Go back|Close viewer \(Escape\))$/ }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
      await thumbnailUtils.expectInViewport(page, assets.at(-1 - 15)!.id);
      await thumbnailUtils.expectTopIsTimelineTop(page, assets.at(-1 - 15)!.id);
    });

    test('Layout switch keeps the anchored item in view, and reload restores the layout', async ({ page }) => {
      const rng = new SeededRandom(311);
      const asset = selectRandom(deepAssets(), rng);
      await pageUtils.deepLinkPhotosPage(page, asset.id);
      await thumbnailUtils.expectInViewport(page, asset.id);
      for (const layout of ['Timeline', 'Work', 'Browse'] as const) {
        await timelineUtils.setLayout(page, layout);
        await thumbnailUtils.expectInViewport(page, asset.id);
      }
      await timelineUtils.setLayout(page, 'Timeline');
      await page.reload();
      await timelineUtils.waitForTimelineLoad(page);
      // Layout is device-local and survives a reload (prototype `App.jsx` saved session.layout).
      await expect(timelineUtils.layoutButton(page, 'Timeline')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  test.describe('keyboard', () => {
    /**
     * Arrow keys move focus between tiles (prototype `App.jsx` focus-previous / focus-next) and the
     * focused tile is scrolled the minimum amount: moving forward it lands on the bottom row of the
     * scroll area, moving back on the top row.
     */
    test('Next/previous asset - ArrowRight/ArrowLeft', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.openButton(page, assets[0].id).focus();
      for (let i = 1; i < 15; i++) {
        await page.keyboard.press('ArrowRight');
        await assetViewerUtils.expectActiveAssetToBe(page, assets[i].id);
      }
      for (let i = 15; i <= 20; i++) {
        await page.keyboard.press('ArrowRight');
        await assetViewerUtils.expectActiveAssetToBe(page, assets[i].id);
        await thumbnailUtils.expectBottomIsTimelineBottom(page, assets[i].id);
      }
      for (let i = 19; i >= 15; i--) {
        await page.keyboard.press('ArrowLeft');
        await assetViewerUtils.expectActiveAssetToBe(page, assets[i].id);
      }
      for (let i = 14; i > 0; i--) {
        await page.keyboard.press('ArrowLeft');
        await assetViewerUtils.expectActiveAssetToBe(page, assets[i].id);
      }
      await thumbnailUtils.expectTopIsTimelineTop(page, assets[1].id);
    });

    test('Next/previous row - ArrowDown/ArrowUp', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.openButton(page, assets[0].id).focus();
      const activeIndex = async () => {
        const id = await thumbnailUtils.activeAssetId(page);
        return assets.findIndex((asset) => asset.id === id);
      };
      // Down lands in a later row and up in an earlier one (prototype focus-down / focus-up).
      let index = await activeIndex();
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('ArrowDown');
        const previous = index;
        await expect.poll(activeIndex).toBeGreaterThan(previous);
        index = await activeIndex();
        await thumbnailUtils.expectInViewport(page, assets[index].id);
      }
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('ArrowUp');
        const previous = index;
        await expect.poll(activeIndex).toBeLessThan(previous);
        index = await activeIndex();
        await thumbnailUtils.expectInViewport(page, assets[index].id);
      }
      expect(index).toBe(0);
    });

    test('Next/previous asset - Tab/Shift+Tab', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.openButton(page, assets[0].id).focus();
      const activeId = () => thumbnailUtils.activeAssetId(page);
      // Each tile holds two stops, its open button and its select checkbox; Tab visits tiles in order.
      const walk = async (key: string, count: number) => {
        const seen: string[] = [];
        let last = await activeId();
        while (seen.length < count) {
          await page.keyboard.press(key);
          const id = await activeId();
          if (id && id !== last) {
            seen.push(id);
          }
          last = id;
        }
        return seen;
      };
      expect(await walk('Tab', 20)).toEqual(assets.slice(1, 21).map((asset) => asset.id));
      expect(await walk('Shift+Tab', 20)).toEqual(
        assets
          .slice(0, 20)
          .map((asset) => asset.id)
          .toReversed(),
      );
    });

    for (const [key, grouping] of [
      ['d', 'days'],
      ['m', 'months'],
      ['y', 'years'],
    ] as const) {
      test(`Group by ${grouping} - ${key.toUpperCase()}`, async ({ page }) => {
        await pageUtils.openPhotosPage(page);
        await expect(timelineUtils.layoutButton(page, 'Browse')).toHaveAttribute('aria-pressed', 'true');
        await timelineUtils.locator(page).hover();
        await page.keyboard.press(key);
        // Prototype `App.jsx` jump(): the Timeline layout, grouped by the key's unit.
        await expect(timelineUtils.layoutButton(page, 'Timeline')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => timelineUtils.grouping(page)).toBe(grouping);
        await thumbnailUtils.expectTimelineHasOnScreenAssets(page);
      });
    }

    test('Go to a date - G', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.locator(page).hover();
      await page.keyboard.press('g');
      // Prototype `App.jsx` go-to-date: the Timeline layout, then the month scrubber takes focus.
      await expect(timelineUtils.layoutButton(page, 'Timeline')).toHaveAttribute('aria-pressed', 'true');
      await expect(scrubberUtils.slider(page)).toBeFocused();
      await page.keyboard.press('End');
      await expect
        .poll(() => thumbnailUtils.someInViewport(page, (id) => getYearMonth(assets, id) === yearMonths.at(-1)))
        .toBe(true);
      await page.keyboard.press('Home');
      await thumbnailUtils.expectInViewport(page, assets[0].id);
      const rng = new SeededRandom(4782);
      for (const index of selectRandomMultiple(
        Array.from({ length: 20 }, (_, index) => index),
        4,
        rng,
      ).toSorted((a, b) => a - b)) {
        await page.keyboard.press('Home');
        await expect(scrubberUtils.slider(page)).toHaveAttribute('aria-valuenow', '0');
        for (let step = 1; step <= index; step++) {
          await page.keyboard.press('ArrowDown');
          await expect(scrubberUtils.slider(page)).toHaveAttribute('aria-valuenow', String(step));
        }
        await thumbnailUtils.expectInViewport(page, assetsInMonth(yearMonths[index])[0].id);
      }
    });
  });

  test.describe('selection', () => {
    test('Select day, unselect day', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      // Day headers and their select-all live in the Timeline layout.
      await timelineUtils.setLayout(page, 'Timeline');
      await pageUtils.selectDay(page, 'Wed, Dec 11, 2024');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(4);
      await pageUtils.selectDay(page, 'Wed, Dec 11, 2024');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(0);
    });

    test('Select asset, click asset to select', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.selectAssetId(page, assets[1].id);
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(1);
      // While a selection is in progress, a click selects instead of opening.
      await thumbnailUtils.clickAssetId(page, assets[2].id);
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(2);
    });

    test('Select asset, click unselect asset', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.selectAssetId(page, assets[1].id);
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(1);
      await thumbnailUtils.clickAssetId(page, assets[1].id);
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(0);
    });

    test('Select asset, shift-click end', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.selectAssetId(page, assets[0].id);
      await page.keyboard.down('Shift');
      await thumbnailUtils.selectButton(page, assets[2].id).click();
      await page.keyboard.up('Shift');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(3);
    });

    test('Add multiple to selection - Select asset, click, shift-click end', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.selectAssetId(page, assets[0].id);
      await thumbnailUtils.clickAssetId(page, assets[2].id);
      await page.keyboard.down('Shift');
      await thumbnailUtils.clickAssetId(page, assets[4].id);
      await page.keyboard.up('Shift');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(4);
    });

    test('Select focused asset - X', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.openButton(page, assets[0].id).focus();
      await page.keyboard.press('ArrowRight');
      await assetViewerUtils.expectActiveAssetToBe(page, assets[1].id);
      await page.keyboard.press('x');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(1);
      await expect(thumbnailUtils.selectButton(page, assets[1].id)).toBeChecked();
      await page.keyboard.press('x');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(0);
    });
  });

  test.describe('scroll', () => {
    test('Open /photos, random click scrubber 20x', async ({ page }) => {
      test.slow();
      await pageUtils.openPhotosPage(page);
      const rng = new SeededRandom(6637);
      const selectedMonths = selectRandomMultiple(yearMonths, 20, rng);
      for (const month of selectedMonths) {
        await scrubberUtils.clickMonth(page, month);
        await expect
          .poll(() => thumbnailUtils.someInViewport(page, (assetId) => getYearMonth(assets, assetId) === month))
          .toBe(true);
      }
    });

    test('Deep link to last photo, scroll up', async ({ page }) => {
      const lastAsset = assets.at(-1)!;
      await pageUtils.deepLinkPhotosPage(page, lastAsset.id);
      const lastMonth = yearMonths.at(-1)!;
      await timelineUtils.locator(page).hover();
      for (let i = 0; i < 100; i++) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(25);
      }
      // Scrolling loads the newer months above: loaded tiles, all newer than where we started.
      await expect
        .poll(async () => {
          const ids = await thumbnailUtils.idsInViewport(page);
          return ids.length > 0 && ids.every((id) => getYearMonth(assets, id) !== lastMonth);
        })
        .toBe(true);
    });

    test('Deep link to first bucket, scroll down', async ({ page }) => {
      await pageUtils.deepLinkPhotosPage(page, assets[0].id);
      await timelineUtils.locator(page).hover();
      for (let i = 0; i < 100; i++) {
        await page.mouse.wheel(0, 100);
        await page.waitForTimeout(25);
      }
      await expect
        .poll(async () => {
          const ids = await thumbnailUtils.idsInViewport(page);
          return ids.length > 0 && ids.every((id) => getYearMonth(assets, id) !== yearMonths[0]);
        })
        .toBe(true);
    });

    test('Deep link to last photo, drag scrubber to scroll up', async ({ page }) => {
      const lastAsset = assets.at(-1)!;
      await pageUtils.deepLinkPhotosPage(page, lastAsset.id);
      const track = (await scrubberUtils.slider(page).boundingBox())!;
      const x = track.x + track.width / 2;
      await page.mouse.move(x, track.y + track.height - 1);
      await page.mouse.down();
      // Past the end of the track: the pointer is captured, so the position clamps to the newest month.
      await page.mouse.move(x, track.y - 20, { steps: 100 });
      await page.mouse.up();
      await thumbnailUtils.expectInViewport(page, assets[0].id);
    });

    test('Deep link to first bucket, drag scrubber to scroll down', async ({ page }) => {
      await pageUtils.deepLinkPhotosPage(page, assets[0].id);
      const track = (await scrubberUtils.slider(page).boundingBox())!;
      const x = track.x + track.width / 2;
      await page.mouse.move(x, track.y + 1);
      await page.mouse.down();
      await page.mouse.move(x, track.y + track.height + 20, { steps: 100 });
      await page.mouse.up();
      await thumbnailUtils.expectInViewport(page, assets.at(-1)!.id);
    });

    test('Buckets cancel on scroll', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      testContext.slowBucket = true;
      const failedUris: string[] = [];
      page.on('requestfailed', (request) => {
        failedUris.push(request.url());
      });
      await scrubberUtils.clickMonth(page, yearMonths[12]);
      await scrubberUtils.clickMonth(page, yearMonths.at(-1)!);
      const uris = await poll(page, async () => (failedUris.length > 0 ? failedUris : null));
      expect(uris).toEqual(expect.arrayContaining([expect.stringContaining(padYearMonth(yearMonths[12]))]));
    });
  });

  test.describe('/albums', () => {
    test('Open album', async ({ page }) => {
      const album = timelineRestData.album;
      await pageUtils.openAlbumPage(page, album.id);
      await thumbnailUtils.expectInViewport(page, album.assetIds[0]);
    });

    test('Deep link to last photo', async ({ page }) => {
      const album = timelineRestData.album;
      const lastAsset = album.assetIds.at(-1)!;
      await pageUtils.deepLinkAlbumPage(page, album.id, lastAsset);
      await thumbnailUtils.expectInViewport(page, lastAsset);
      await thumbnailUtils.expectBottomIsTimelineBottom(page, lastAsset);
    });
  });

  test.describe('/trash', () => {
    test('open /photos, trash photo, open /trash, restore', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      const assetToTrash = assets[0];
      await trashFromSelection(page, assetToTrash.id);
      await expect(thumbnailUtils.withAssetId(page, assetToTrash.id)).toHaveCount(0);
      await railLink(page, 'Trash').click();
      await restoreFromTrash(page, assetToTrash.id);
      await railLink(page, 'Library').click();
      await thumbnailUtils.expectInViewport(page, assetToTrash.id);
    });

    test('open album, trash photo, open /trash, restore', async ({ page }) => {
      const album = timelineRestData.album;
      await pageUtils.openAlbumPage(page, album.id);
      const assetToTrash = getAsset(timelineRestData, album.assetIds[0])!;
      await trashFromSelection(page, assetToTrash.id);
      await expect(thumbnailUtils.withAssetId(page, assetToTrash.id)).toHaveCount(0);
      await page.goto('/trash');
      await restoreFromTrash(page, assetToTrash.id);
      await pageUtils.openAlbumPage(page, album.id);
      await thumbnailUtils.expectInViewport(page, assetToTrash.id);
    });
  });

  test.describe('/archive', () => {
    test('open /photos, archive photo, open /archive, unarchive', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      const assetToArchive = assets[0];
      await thumbnailUtils.ensureSelected(page, assetToArchive.id);
      const archive = archiveRequest(page, 'archive');
      await selectionBarUtils.menuAction(page, 'Archive');
      await expect(archive).resolves.toEqual({ visibility: 'archive', ids: [assetToArchive.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToArchive.id)).toHaveCount(0);
      await railLink(page, 'Archive').click();
      await timelineUtils.waitForTimelineLoad(page);
      await thumbnailUtils.expectInViewport(page, assetToArchive.id);
      await thumbnailUtils.ensureSelected(page, assetToArchive.id);
      const unarchive = archiveRequest(page, 'timeline');
      await selectionBarUtils.menuAction(page, 'Unarchive');
      await expect(unarchive).resolves.toEqual({ visibility: 'timeline', ids: [assetToArchive.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToArchive.id)).toHaveCount(0);
      await railLink(page, 'Library').click();
      await thumbnailUtils.expectInViewport(page, assetToArchive.id);
    });

    test('open /archive, favorite photo, unfavorite', async ({ page }) => {
      const assetToFavorite = assets[0];
      changes.assetArchivals.push(assetToFavorite.id);
      await pageUtils.openArchivePage(page);
      const favorite = pageRoutePromise(page, '**/api/assets', async (route, request) => {
        const requestJson = request.postDataJSON();
        if (requestJson.isFavorite === undefined) {
          return await route.fallback();
        }
        if (requestJson.isFavorite) {
          changes.assetFavorites.push(...requestJson.ids);
        }
        await route.fulfill({ status: 204 });
      });
      await thumbnailUtils.ensureSelected(page, assetToFavorite.id);
      await selectionBarUtils.action(page, 'Favorite').click();
      await expect(favorite).resolves.toEqual({ isFavorite: true, ids: [assetToFavorite.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToFavorite.id)).toHaveCount(1);
      await thumbnailUtils.expectThumbnailIsFavorite(page, assetToFavorite.id);
      // The selection stays after an action, and the bar now offers the reverse.
      const unFavoriteRequest = pageRoutePromise(page, '**/api/assets', async (route, request) => {
        const requestJson = request.postDataJSON();
        if (requestJson.isFavorite === undefined) {
          return await route.fallback();
        }
        changes.assetFavorites = changes.assetFavorites.filter((id) => !requestJson.ids.includes(id));
        await route.fulfill({ status: 204 });
      });
      await selectionBarUtils.action(page, 'Remove from favorites').click();
      await expect(unFavoriteRequest).resolves.toEqual({ isFavorite: false, ids: [assetToFavorite.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToFavorite.id)).toHaveCount(1);
      await thumbnailUtils.expectThumbnailIsNotFavorite(page, assetToFavorite.id);
    });

    test('open album, archive photo, open /archive, unarchive', async ({ page }) => {
      const album = timelineRestData.album;
      await pageUtils.openAlbumPage(page, album.id);
      const assetToArchive = getAsset(timelineRestData, album.assetIds[0])!;
      await thumbnailUtils.ensureSelected(page, assetToArchive.id);
      const archive = archiveRequest(page, 'archive');
      await selectionBarUtils.menuAction(page, 'Archive');
      await expect(archive).resolves.toEqual({ visibility: 'archive', ids: [assetToArchive.id] });
      // An archived item stays in its album.
      await expect(thumbnailUtils.withAssetId(page, assetToArchive.id)).toHaveCount(1);
      await page.goto('/archive');
      await timelineUtils.waitForTimelineLoad(page);
      await thumbnailUtils.expectInViewport(page, assetToArchive.id);
      await thumbnailUtils.ensureSelected(page, assetToArchive.id);
      const unarchive = archiveRequest(page, 'timeline');
      await selectionBarUtils.menuAction(page, 'Unarchive');
      await expect(unarchive).resolves.toEqual({ visibility: 'timeline', ids: [assetToArchive.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToArchive.id)).toHaveCount(0);
      await pageUtils.openAlbumPage(page, album.id);
      await thumbnailUtils.expectInViewport(page, assetToArchive.id);
    });
  });

  test.describe('/favorite', () => {
    test('open /photos, favorite photo, open /favorites, remove favorite, open /photos', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      const assetToFavorite = assets[0];
      await thumbnailUtils.ensureSelected(page, assetToFavorite.id);
      const favorite = favoriteRequest(page);
      await selectionBarUtils.action(page, 'Favorite').click();
      await expect(favorite).resolves.toEqual({ isFavorite: true, ids: [assetToFavorite.id] });
      // The tile stays and shows the favorite badge.
      await thumbnailUtils.expectThumbnailIsFavorite(page, assetToFavorite.id);
      await railLink(page, 'Favorites').click();
      await timelineUtils.waitForTimelineLoad(page);
      await thumbnailUtils.expectInViewport(page, assetToFavorite.id);
      await thumbnailUtils.ensureSelected(page, assetToFavorite.id);
      const unFavorite = favoriteRequest(page);
      await selectionBarUtils.action(page, 'Remove from favorites').click();
      await expect(unFavorite).resolves.toEqual({ isFavorite: false, ids: [assetToFavorite.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToFavorite.id)).toHaveCount(0);
      await railLink(page, 'Library').click();
      await thumbnailUtils.expectInViewport(page, assetToFavorite.id);
    });

    test('open /favorites, archive photo, unarchive photo', async ({ page }) => {
      const assetToArchive = assets[0];
      changes.assetFavorites.push(assetToArchive.id);
      await pageUtils.openFavorites(page);
      await thumbnailUtils.ensureSelected(page, assetToArchive.id);
      const archive = pageRoutePromise(page, '**/api/assets', async (route, request) => {
        const requestJson = request.postDataJSON();
        if (requestJson.visibility !== 'archive') {
          return await route.fallback();
        }
        changes.assetArchivals.push(...requestJson.ids);
        await route.fulfill({ status: 204 });
      });
      await selectionBarUtils.menuAction(page, 'Archive');
      await expect(archive).resolves.toEqual({ visibility: 'archive', ids: [assetToArchive.id] });
      await railLink(page, 'Archive').click();
      await timelineUtils.waitForTimelineLoad(page);
      await thumbnailUtils.expectInViewport(page, assetToArchive.id);
      await thumbnailUtils.expectThumbnailIsFavorite(page, assetToArchive.id);
      await thumbnailUtils.ensureSelected(page, assetToArchive.id);
      const unarchive = pageRoutePromise(page, '**/api/assets', async (route, request) => {
        const requestJson = request.postDataJSON();
        if (requestJson.visibility !== 'timeline') {
          return await route.fallback();
        }
        changes.assetArchivals = changes.assetArchivals.filter((id) => !requestJson.ids.includes(id));
        await route.fulfill({ status: 204 });
      });
      await selectionBarUtils.menuAction(page, 'Unarchive');
      await expect(unarchive).resolves.toEqual({ visibility: 'timeline', ids: [assetToArchive.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToArchive.id)).toHaveCount(0);
      await railLink(page, 'Favorites').click();
      await thumbnailUtils.expectInViewport(page, assetToArchive.id);
    });

    test('Open album, favorite photo, open /favorites, remove favorite, Open album', async ({ page }) => {
      const album = timelineRestData.album;
      await pageUtils.openAlbumPage(page, album.id);
      const assetToFavorite = getAsset(timelineRestData, album.assetIds[0])!;
      await thumbnailUtils.ensureSelected(page, assetToFavorite.id);
      const favorite = favoriteRequest(page);
      await selectionBarUtils.action(page, 'Favorite').click();
      await expect(favorite).resolves.toEqual({ isFavorite: true, ids: [assetToFavorite.id] });
      await thumbnailUtils.expectThumbnailIsFavorite(page, assetToFavorite.id);
      await page.goto(`/favorites?at=${assetToFavorite.id}`);
      await timelineUtils.waitForTimelineLoad(page);
      await thumbnailUtils.expectInViewport(page, assetToFavorite.id);
      await thumbnailUtils.ensureSelected(page, assetToFavorite.id);
      const unFavorite = favoriteRequest(page);
      await selectionBarUtils.action(page, 'Remove from favorites').click();
      await expect(unFavorite).resolves.toEqual({ isFavorite: false, ids: [assetToFavorite.id] });
      await expect(thumbnailUtils.withAssetId(page, assetToFavorite.id)).toHaveCount(0);
      await pageUtils.openAlbumPage(page, album.id);
      await thumbnailUtils.expectInViewport(page, assetToFavorite.id);
      await thumbnailUtils.expectThumbnailIsNotFavorite(page, assetToFavorite.id);
    });
  });
});

/** A destination in the library rail (prototype `LibraryRail.jsx`). */
const railLink = (page: Page, name: string) =>
  page.getByTestId('sidebar-parent').getByRole('link', { name, exact: true });

const getYearMonth = (assets: TimelineAssetConfig[], assetId: string) => {
  const mockAsset = assets.find((mockAsset) => mockAsset.id === assetId)!;
  const dateTime = DateTime.fromISO(mockAsset.fileCreatedAt!, { zone: 'utc' });
  return dateTime.year + '-' + dateTime.month;
};
