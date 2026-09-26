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
  flowUtils,
  groupingUtils,
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
    // beforeAll can run more than once in a worker (a repeat or a new suite run); start from empty
    // lists so the assets and months of an earlier run are not listed twice
    assets.length = 0;
    yearMonths.length = 0;
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

  /** Group titles as the prototype writes them (`explore-timeline.mjs` `timelineGroups`). */
  const monthTitle = (assetId: string) =>
    captured(assets, assetId).setLocale('en').toLocaleString({ month: 'long', year: 'numeric' });
  const yearTitle = (assetId: string) => String(captured(assets, assetId).year);
  const newestYear = () => captured(assets, assets[0].id).year;
  const inYear = (year: number) => assets.filter((asset) => captured(assets, asset.id).year === year).length;

  /** Assets deep enough in the library that showing one always scrolls the timeline. */
  const deepAssets = () => assets.slice(100);

  /**
   * FL-143: scroll down the library and check that every row on screen is full — a row runs on from
   * one month into the next, so only the library's last row may end short — and that at least one
   * row holds the end of one month and the start of the next.
   *
   * The steps are small and every month the timeline has requested (within 500px) is loaded before
   * the next step, so a month always loads while the row it finishes is still below the viewport,
   * whatever order or timing the bucket responses have.
   */
  const expectRowsRunOn = async (page: Page) => {
    const lastId = assets.at(-1)!.id;
    let crossing = 0;
    let checked = 0;
    for (let step = 0; step < 120 && (crossing === 0 || step < 8); step++) {
      await expect.poll(() => flowUtils.skeletonsNear(page, 480)).toBe(0);
      const rows = await flowUtils.rowsOnScreen(page);
      const right = Math.max(...rows.map((row) => row.at(-1)!.right));
      for (const row of rows.filter((candidate) => !candidate.some(({ id }) => id === lastId))) {
        expect(row.at(-1)!.right).toBeGreaterThan(right - 2);
        checked++;
        if (new Set(row.map(({ id }) => getYearMonth(assets, id))).size > 1) {
          crossing++;
        }
      }
      await timelineUtils.locator(page).evaluate((scroller) => scroller.scrollBy(0, 100));
    }
    expect(checked).toBeGreaterThan(0);
    // At least one row holds the end of one month and the start of the next.
    expect(crossing).toBeGreaterThan(0);
  };

  /**
   * FL-143: land in a month with the month above it held back, then let that month load. Nothing on
   * screen may move; once that stretch has been scrolled away, the month above ends in a full row.
   */
  const expectNothingMovesWhenTheMonthAboveLoads = async (page: Page, open: () => Promise<void>) => {
    // The month the scrubber lands on, deep enough that the month above it is not loaded from the
    // top of the library, and the month above it, whose bucket is held back until released.
    const index = yearMonths.findIndex(
      (yearMonth, position) =>
        position >= 2 &&
        assets.indexOf(assetsInMonth(yearMonths[position - 1])[0]) >= 150 &&
        assetsInMonth(yearMonth).length >= 10,
    );
    expect(index).toBeGreaterThan(0);
    const target = yearMonths[index];
    const above = yearMonths[index - 1];
    const heldBucket = padYearMonth(above);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let requested = false;
    await page.route('**/api/timeline/bucket?*', async (route, request) => {
      if (new URL(request.url()).searchParams.get('timeBucket')?.startsWith(heldBucket)) {
        requested = true;
        await released;
      }
      await route.fallback();
    });

    // The page's clock decides when rows on screen have settled (300 ms); the test moves it on
    // instead of waiting.
    await page.clock.install();
    await open();
    await scrubberUtils.clickMonth(page, target);
    await expect
      .poll(() => thumbnailUtils.someInViewport(page, (assetId) => getYearMonth(assets, assetId) === target))
      .toBe(true);
    // The scrubber lands inside the month; move up until the month above comes near enough to load.
    for (let step = 0; step < 60 && !requested; step++) {
      await timelineUtils.locator(page).evaluate((scroller) => scroller.scrollBy(0, -200));
      await page.waitForTimeout(100);
    }
    expect(requested).toBe(true);
    await expect
      .poll(() => thumbnailUtils.someInViewport(page, (assetId) => getYearMonth(assets, assetId) === target))
      .toBe(true);
    // Past the moment rows that load together may still join up: what is on screen has settled.
    await page.clock.fastForward(1000);
    const before = await flowUtils.placesOnScreen(page);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    release();
    const lastAbove = assetsInMonth(above).at(-1)!;
    await expect(thumbnailUtils.withAssetId(page, lastAbove.id)).toHaveCount(1);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await flowUtils.placesOnScreen(page);
    for (const [id, place] of Object.entries(before)) {
      expect(after[id], id).toBeDefined();
      expect(Math.abs(after[id].top - place.top), id).toBeLessThanOrEqual(1);
      expect(Math.abs(after[id].left - place.left), id).toBeLessThanOrEqual(1);
      expect(Math.abs(after[id].width - place.width), id).toBeLessThanOrEqual(1);
    }

    // Once that stretch is off screen the rows run on: the month above ends in a full row.
    await timelineUtils.locator(page).evaluate((scroller) => scroller.scrollTo({ top: 0 }));
    await expect.poll(() => timelineUtils.locator(page).evaluate((scroller) => scroller.scrollTop)).toBe(0);
    await scrubberUtils.clickMonth(page, target);
    await thumbnailUtils.expectTimelineHasOnScreenAssets(page);
    for (let step = 0; step < 60 && (await thumbnailUtils.withAssetId(page, lastAbove.id).count()) === 0; step++) {
      await timelineUtils.locator(page).evaluate((scroller) => scroller.scrollBy(0, -200));
      await page.waitForTimeout(100);
    }
    await thumbnailUtils.withAssetId(page, lastAbove.id).scrollIntoViewIfNeeded();
    await expect.poll(() => flowUtils.skeletonsNear(page)).toBe(0);
    const rows = await flowUtils.rowsOnScreen(page);
    const right = Math.max(...rows.map((row) => row.at(-1)!.right));
    const boundaryRow = rows.find((row) => row.some(({ id }) => id === lastAbove.id));
    expect(boundaryRow).toBeDefined();
    expect(boundaryRow!.at(-1)!.right).toBeGreaterThan(right - 2);
  };

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
      // Browse's dense grid shows many items at once: step past everything on screen, at least 15.
      const onScreen = new Set(await thumbnailUtils.idsInViewport(page));
      await thumbnailUtils.clickAssetId(page, assets[0].id);
      await assetViewerUtils.waitForViewerLoad(page, assets[0]);
      let index = 0;
      while (index < 15 || onScreen.has(assets[index].id)) {
        index++;
        await page.getByLabel('View next asset').click();
        await assetViewerUtils.waitForViewerLoad(page, assets[index]);
      }
      await page.getByRole('button', { name: /^(Go back|Close viewer)$/ }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
      await thumbnailUtils.expectInViewport(page, assets[index].id);
      await thumbnailUtils.expectBottomIsTimelineBottom(page, assets[index].id);
    });

    test('Open /photos, open asset-viewer, previous photo 15x, backwardsArrow', async ({ page }) => {
      const lastAsset = assets.at(-1)!;
      await pageUtils.deepLinkPhotosPage(page, lastAsset.id);
      // Browse's dense grid shows many items at once: step past everything on screen, at least 15.
      const onScreen = new Set(await thumbnailUtils.idsInViewport(page));
      await thumbnailUtils.clickAssetId(page, lastAsset.id);
      await assetViewerUtils.waitForViewerLoad(page, lastAsset);
      let back = 0;
      while (back < 15 || onScreen.has(assets.at(-1 - back)!.id)) {
        back++;
        await page.getByLabel('View previous asset').click();
        await assetViewerUtils.waitForViewerLoad(page, assets.at(-1 - back)!);
      }
      await page.getByRole('button', { name: /^(Go back|Close viewer)$/ }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
      await thumbnailUtils.expectInViewport(page, assets.at(-1 - back)!.id);
      await thumbnailUtils.expectTopIsTimelineTop(page, assets.at(-1 - back)!.id);
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

  test.describe('library session (FL-31, FL-33)', () => {
    test('Layout switches keep the selection', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.ensureSelected(page, assets[0].id);
      await thumbnailUtils.ensureSelected(page, assets[1].id);
      await expect(selectionBarUtils.locator(page)).toContainText('2 selected');
      for (const layout of ['Timeline', 'Work', 'Browse'] as const) {
        await timelineUtils.setLayout(page, layout);
        await expect(selectionBarUtils.locator(page)).toContainText('2 selected');
      }
    });

    test('A link to an item that is gone opens the library without it', async ({ page }) => {
      const gone = assets[3];
      await page.route(`**/api/assets/${gone.id}`, (route) =>
        route.fulfill({ status: 404, json: { message: 'Not found', statusCode: 404 } }),
      );
      await page.goto(`/photos/${gone.id}`);
      await expect(page).toHaveURL(/\/photos(?:\?|$)/);
      await timelineUtils.waitForTimelineLoad(page);
      await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    });

    test('Favorites with nothing in it shows the Frameleaf empty state', async ({ page }) => {
      await page.route('**/api/timeline/buckets?*', (route, request) =>
        new URL(request.url()).searchParams.get('isFavorite') === 'true'
          ? route.fulfill({ json: [] })
          : route.fallback(),
      );
      await page.goto('/favorites');
      await expect(page.getByText('No photos or videos in this view.')).toBeVisible();
    });
  });

  test.describe('September 24 chrome', () => {
    for (const layout of ['Timeline', 'Browse', 'Work'] as const) {
      test(`${layout}: rows start right below the header content, not a header height lower`, async ({ page }) => {
        await pageUtils.openPhotosPage(page);
        await timelineUtils.setLayout(page, layout);
        const end = page.locator('.fl-timeline-top-end');
        const month = page.locator('.fl-month').first();
        await expect(month).toBeVisible();
        // Months are placed by their transform from the body's top, just below where the header
        // content ends; the header block itself spans the scroll height for the sticky toolbar.
        await expect
          .poll(async () => {
            const [endBox, monthBox] = await Promise.all([end.boundingBox(), month.boundingBox()]);
            return Math.abs(Math.round((monthBox?.y ?? Infinity) - (endBox?.y ?? 0)));
          })
          .toBeLessThanOrEqual(24);
      });
    }

    test('the frosted results toolbar stays at the top while the photos scroll', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      const scroller = page.locator('.fl-timeline-scroll');
      const toolbar = page.getByTestId('frameleaf-results-toolbar');
      const before = await toolbar.boundingBox();
      await scroller.evaluate((element) => element.scrollBy(0, 3000));
      await expect(toolbar).toBeInViewport();
      const [after, scrollerBox] = await Promise.all([toolbar.boundingBox(), scroller.boundingBox()]);
      expect(after!.y).toBeLessThanOrEqual(before!.y);
      expect(Math.abs(after!.y - scrollerBox!.y)).toBeLessThanOrEqual(1);
      // The group headers stick below it, not under it.
      const offset = await page
        .getByTestId('frameleaf-library')
        .evaluate((element) =>
          Number(getComputedStyle(element).getPropertyValue('--fl-sticky-offset').replace('px', '')),
        );
      expect(offset).toBeGreaterThan(0);
    });

    test('on a phone the drawer ends above the tab bar and its footer stays reachable', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await pageUtils.openPhotosPage(page);
      const tabBar = page.getByRole('navigation', { name: 'Sections' });
      await expect(tabBar).toBeVisible();
      await page.getByRole('button', { name: 'Main menu' }).click();
      // The tab bar stays; the drawer stops above it (template `.sidebar.mobile-open`).
      await expect(tabBar).toBeVisible();
      const [drawer, bar] = await Promise.all([page.getByTestId('sidebar-parent').boundingBox(), tabBar.boundingBox()]);
      expect(drawer!.y + drawer!.height).toBeLessThanOrEqual(bar!.y);
      const care = railLink(page, 'Library Care');
      await care.scrollIntoViewIfNeeded();
      await care.click();
      await expect(page).toHaveURL(/area=care/);
    });

    test('Timeline: only the results toolbar stays; the grouping row scrolls away', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.setLayout(page, 'Timeline');
      const grouping = page.getByRole('group', { name: 'Timeline grouping' });
      await expect(grouping).toBeVisible();
      await page.locator('.fl-timeline-scroll').evaluate((element) => element.scrollBy(0, 2000));
      const toolbar = page.getByTestId('frameleaf-results-toolbar');
      await expect(toolbar).toBeInViewport();
      // timeline-library.css: `.tl-toolbar` is not sticky; it has scrolled out above the toolbar.
      const scrollerBox = await page.locator('.fl-timeline-scroll').boundingBox();
      const groupingBox = await grouping.boundingBox();
      expect(groupingBox!.y + groupingBox!.height).toBeLessThanOrEqual(scrollerBox!.y);
    });
  });

  /**
   * FL-30 / FL-33 library chrome (prototype `App.jsx` `.results-toolbar`, `ShortcutsHelp.jsx`,
   * `AssetTile.jsx` `.at-actions`, the library keydown): the toolbar's count, Filter with its
   * chevron menu, Slideshow, the information panel, Sort and "More library actions"; the "?" sheet;
   * tile quick actions and the action keys on /photos; no memory strip above the library.
   */
  test.describe('library chrome', () => {
    test('the results toolbar carries the prototype controls', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      const toolbar = page.getByTestId('frameleaf-results-toolbar');
      await expect(toolbar.getByTestId('frameleaf-result-count')).toHaveText(/items$/);
      await expect(toolbar.getByRole('button', { name: 'Filter', exact: true })).toBeVisible();
      await toolbar.getByRole('button', { name: 'Choose a filter' }).click();
      await expect(page.getByRole('menu', { name: 'Choose a filter' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu', { name: 'Choose a filter' })).toBeHidden();
      await expect(toolbar.getByRole('button', { name: 'Slideshow' })).toBeEnabled();
      await expect(toolbar.getByRole('combobox', { name: 'Sort assets' })).toHaveValue('captured-desc');

      await toolbar.getByRole('button', { name: 'Show information panel' }).click();
      await expect(page.getByTestId('frameleaf-work-inspector')).toBeVisible();

      await toolbar.getByRole('button', { name: 'More library actions' }).click();
      const actions = page.getByRole('dialog', { name: 'Collection actions' });
      await expect(actions).toBeVisible();
      await expect(actions.getByRole('button', { name: 'Compare selected items' })).toBeDisabled();
    });

    test('Browse sorts by file name through the flat order, and List shows rows (S-15)', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.setLayout(page, 'Browse');
      const toolbar = page.getByTestId('frameleaf-results-toolbar');
      const ordered = page.waitForRequest((request) => request.url().includes('/api/timeline/ordered'));
      await toolbar.getByRole('combobox', { name: 'Sort assets' }).selectOption('filename');
      await ordered;
      const first = assets.map((asset) => asset.id).toSorted((a, b) => a.localeCompare(b))[0];
      await expect(page.locator('[data-testid="frameleaf-asset-tile"]').first()).toHaveAttribute(
        'data-asset-id',
        first,
      );

      await toolbar.getByRole('button', { name: 'List view' }).click();
      await expect(page.locator('[data-testid="frameleaf-asset-tile"]').first()).toHaveAttribute('data-layout', 'list');
      await toolbar.getByRole('button', { name: 'Grid view' }).click();
      await toolbar.getByRole('combobox', { name: 'Sort assets' }).selectOption('captured-desc');

      // The Timeline keeps its dates: only newest-first and oldest-first are offered there.
      await timelineUtils.setLayout(page, 'Timeline');
      // Filename is offered but not choosable here: check the option's own `disabled` property directly.
      await expect(toolbar.getByRole('option', { name: 'Filename' })).toHaveJSProperty('disabled', true);
      await expect(toolbar.getByRole('button', { name: 'List view' })).toHaveCount(0);
    });

    test('? opens the Frameleaf shortcuts sheet, closed with Done', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.locator(page).hover();
      await page.keyboard.press('Shift+?');
      const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText('Move focus left or right')).toBeVisible();
      await expect(sheet.getByText(/Shortcuts pause while you type in a field/)).toBeVisible();
      await sheet.getByRole('button', { name: 'Done' }).click();
      await expect(sheet).toBeHidden();
    });

    test('a tile offers its quick actions on hover, and F favorites the focused item', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      const asset = assets.slice(0, 10).find((item) => !item.isFavorite) ?? assets[0];
      await thumbnailUtils.withAssetId(page, asset.id).hover();
      const quick = thumbnailUtils.withAssetId(page, asset.id).getByRole('group', { name: /^Actions for / });
      await expect(quick).toBeVisible();
      await expect(quick.getByRole('button')).toHaveCount(4);

      const favorite = favoriteRequest(page);
      await thumbnailUtils.openButton(page, asset.id).focus();
      await page.keyboard.press('f');
      await expect(favorite).resolves.toEqual({ isFavorite: !asset.isFavorite, ids: [asset.id] });
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
        // Years and Months are curated cards (September 24); Days shows the tiles.
        if (grouping === 'days') {
          await thumbnailUtils.expectTimelineHasOnScreenAssets(page);
        } else {
          await expect(groupingUtils.cards(page).first()).toBeVisible();
        }
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

  /**
   * Prototype `TimelineLibrary.jsx`, `timeline-highlights.mjs` and the September 24 decisions: Years
   * and Months are curated cards (key photo, count, top places; months add a highlight strip) and a
   * card steps into the next level; Days keeps its day headers and All one sticky header over
   * everything. ⌘/Ctrl+wheel steps between the modes.
   */
  test.describe('grouping', () => {
    const ALL_TITLE = 'All photos and videos';

    test('Group by month and by year from the grouping control, then back to days', async ({ page }) => {
      await openTimeline(page);
      const dayTitles = await groupingUtils.dayHeadings(page).allTextContents();

      await groupingUtils.choose(page, 'Months');
      await expect.poll(() => timelineUtils.grouping(page)).toBe('months');
      await expect(page.getByRole('status').filter({ hasText: 'Grouped by months' })).toHaveCount(1);
      await expect(groupingUtils.dayHeadings(page)).toHaveCount(0);
      const month = groupingUtils.cards(page).first();
      await expect(month.locator('.fl-tl-card-title')).toHaveText(monthTitle(assets[0].id));
      await expect(month).toContainText(new RegExp(String.raw`\b${assetsInMonth(yearMonths[0]).length} items`));
      // Months add a strip of highlights under the key photo.
      await expect(month.locator('.fl-tl-card-strip img').first()).toBeVisible();

      await groupingUtils.choose(page, 'Years');
      await expect.poll(() => timelineUtils.grouping(page)).toBe('years');
      await expect(groupingUtils.dayHeadings(page)).toHaveCount(0);
      const year = groupingUtils.cards(page).first();
      await expect(year.locator('.fl-tl-card-title')).toHaveText(yearTitle(assets[0].id));
      await expect(year).toContainText(new RegExp(String.raw`\b${inYear(newestYear())} items`));
      await expect(year.locator('.fl-tl-card-strip')).toHaveCount(0);

      await groupingUtils.choose(page, 'Days');
      await expect.poll(() => timelineUtils.grouping(page)).toBe('days');
      await expect(groupingUtils.cards(page)).toHaveCount(0);
      await expect(groupingUtils.dayHeadings(page).first()).toBeVisible();
      expect(await groupingUtils.dayHeadings(page).allTextContents()).toEqual(dayTitles);
    });

    test('A year card opens its months, and a month card opens its days', async ({ page }) => {
      await openTimeline(page);
      await groupingUtils.choose(page, 'Years');
      const olderYear = Number(
        yearMonths.find((yearMonth) => !yearMonth.startsWith(`${newestYear()}-`))!.split('-', 1)[0],
      );
      await groupingUtils
        .cards(page)
        .filter({ hasText: String(olderYear) })
        .getByRole('button')
        .click();
      await groupingUtils.expectMode(page, 'Months');
      // The year's newest month card is brought to the top.
      const olderMonth = yearMonths.find((yearMonth) => yearMonth.startsWith(`${olderYear}-`))!;
      const monthCard = page.locator(`[data-group-id="${olderMonth.replace(/-(\d)$/, '-0$1')}"]`);
      await expect(monthCard).toBeInViewport();
      await monthCard.getByRole('button').click();
      await groupingUtils.expectMode(page, 'Days');
      await expect
        .poll(() => thumbnailUtils.someInViewport(page, (assetId) => getYearMonth(assets, assetId) === olderMonth))
        .toBe(true);
    });

    test('The scrubber stays beside the cards and jumps to a month card', async ({ page }) => {
      await openTimeline(page);
      await groupingUtils.choose(page, 'Months');
      await expect(scrubberUtils.slider(page)).toBeVisible();
      const olderMonth = yearMonths.find((yearMonth) => !yearMonth.startsWith(`${newestYear()}-`))!;
      await scrubberUtils.clickMonth(page, olderMonth);
      await expect(page.locator(`[data-group-id="${olderMonth.replace(/-(\d)$/, '-0$1')}"]`)).toBeInViewport();
    });

    test('Days, then Years, then Days comes back to the same place', async ({ page }) => {
      await openTimeline(page);
      const target = deepAssets()[0];
      await scrubberUtils.clickMonth(page, getYearMonth(assets, target.id));
      await expect.poll(() => thumbnailUtils.idsInViewport(page)).not.toEqual([]);
      const before = await thumbnailUtils.idsInViewport(page);
      // Y and D switch where the timeline is; the grouping buttons sit above the photos, so reaching
      // them scrolls to the top first and the top is where Days then comes back to.
      await timelineUtils.locator(page).hover();
      await page.keyboard.press('y');
      await groupingUtils.expectMode(page, 'Years');
      await expect(groupingUtils.cards(page).first()).toBeVisible();
      await page.keyboard.press('d');
      await groupingUtils.expectMode(page, 'Days');
      await expect.poll(() => thumbnailUtils.idsInViewport(page)).toContain(before[0]);
    });

    test('The All header comes before its tiles, in reading and Tab order, and names them', async ({ page }) => {
      // Prototype `TimelineLibrary.jsx`: <section aria-labelledby={headingId}> opens with the header.
      await openTimeline(page);
      await groupingUtils.choose(page, 'All');
      const heading = groupingUtils.groupHeadings(page).filter({ hasText: ALL_TITLE });
      const tile = thumbnailUtils.withAssetId(page, assets[0].id);
      await expect(
        page.getByRole('region', { name: ALL_TITLE, exact: true }).locator(`[data-asset-id="${assets[0].id}"]`),
      ).toHaveCount(1);
      const headingFirst = await heading.evaluate((element, id) => {
        const target = document.querySelector(
          `[data-testid="frameleaf-asset-tile"][data-asset-id="${CSS.escape(id)}"]`,
        )!;
        return Boolean(element.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, assets[0].id);
      expect(headingFirst).toBe(true);
      // From the group's checkbox, Tab moves on to the group's first tile.
      await page.getByRole('checkbox', { name: `Select all in ${ALL_TITLE}` }).focus();
      await page.keyboard.press('Tab');
      await assetViewerUtils.expectActiveAssetToBe(page, assets[0].id);
      await expect(tile).toBeVisible();
    });

    test('A focused All checkbox keeps focus as the header moves down the library', async ({ page }) => {
      await openTimeline(page);
      await groupingUtils.choose(page, 'All');
      const checkbox = page.getByRole('checkbox', { name: `Select all in ${ALL_TITLE}` });
      await checkbox.focus();
      await expect(checkbox).toBeFocused();
      const firstHeader = await page.getByTestId('frameleaf-group').first().elementHandle();
      await expect
        .poll(
          async () => {
            await timelineUtils.locator(page).evaluate((scroller) => scroller.scrollBy(0, 1000));
            return firstHeader!.evaluate((element) => element.isConnected);
          },
          { intervals: [100], timeout: 15_000 },
        )
        .toBe(false);
      const ids = await thumbnailUtils.idsInViewport(page);
      expect(ids.length).toBeGreaterThan(0);
      await expect(checkbox).toBeFocused();
    });

    test('The All header selects everything, months not yet loaded included', async ({ page }) => {
      await openTimeline(page);
      await groupingUtils.choose(page, 'All');
      const header = page.getByTestId('frameleaf-group').first();
      await header.getByRole('heading').hover();
      const checkbox = header.getByRole('checkbox', { name: `Select all in ${ALL_TITLE}` });
      await checkbox.click();
      // Every month of the library is loaded one at a time before the selection is made.
      await expect(selectionBarUtils.locator(page)).toContainText(`${assets.length.toLocaleString('en')} selected`, {
        timeout: 30_000,
      });
      await expect(checkbox).toBeChecked();
      await checkbox.click();
      await expect(checkbox).not.toBeChecked();
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(0);
    });

    /**
     * FL-143: the prototype justifies the whole All group as one flow (`TimelineLibrary.jsx`
     * justifiedRows over `group.assets`), so a row runs on from one month into the next and only the
     * library's last row may end short.
     */
    test('All lays the library out as one flow: rows run on across month boundaries', async ({ page }) => {
      await openTimeline(page);
      await groupingUtils.choose(page, 'All');
      await expectRowsRunOn(page);
    });

    test('All: a month loading above what is on screen does not move it', async ({ page }) => {
      await expectNothingMovesWhenTheMonthAboveLoads(page, async () => {
        await openTimeline(page);
        await groupingUtils.choose(page, 'All');
      });
    });

    test('Ctrl+wheel steps the grouping coarser and finer', async ({ page }) => {
      // The step cooldown reads Date.now(); the test moves the clock instead of waiting.
      await page.clock.install();
      await openTimeline(page);
      await timelineUtils.locator(page).hover();
      const scrollTop = await timelineUtils.locator(page).evaluate((element) => element.scrollTop);
      const step = async (deltaY: number, mode: 'Years' | 'Months' | 'Days') => {
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, deltaY);
        await page.keyboard.up('Control');
        await groupingUtils.expectMode(page, mode);
        // The prototype takes no further step for 300 ms after one.
        await page.clock.fastForward(300);
      };
      // Scrolling down with the modifier held groups more coarsely, scrolling up more finely.
      await step(120, 'Months');
      await expect(groupingUtils.cards(page).first().locator('.fl-tl-card-title')).toHaveText(monthTitle(assets[0].id));
      await step(120, 'Years');
      await expect(groupingUtils.cards(page).first().locator('.fl-tl-card-title')).toHaveText(yearTitle(assets[0].id));
      await step(-120, 'Months');
      await step(-120, 'Days');
      await expect(groupingUtils.cards(page)).toHaveCount(0);
      await expect(groupingUtils.dayHeadings(page).first()).toBeVisible();
      // The modified wheel changes the grouping instead of scrolling the timeline.
      expect(await timelineUtils.locator(page).evaluate((element) => element.scrollTop)).toBe(scrollTop);
    });

    test('M and Y show the Months and Years cards, and D brings the day headers back', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.locator(page).hover();
      await page.keyboard.press('m');
      await groupingUtils.expectMode(page, 'Months');
      await expect(groupingUtils.cards(page).first().locator('.fl-tl-card-title')).toHaveText(monthTitle(assets[0].id));
      await page.keyboard.press('y');
      await groupingUtils.expectMode(page, 'Years');
      await expect(groupingUtils.cards(page).first().locator('.fl-tl-card-title')).toHaveText(yearTitle(assets[0].id));
      await page.keyboard.press('d');
      await groupingUtils.expectMode(page, 'Days');
      await expect(groupingUtils.cards(page)).toHaveCount(0);
      await expect(groupingUtils.dayHeadings(page).first()).toBeVisible();
    });
  });

  /**
   * September 24 grids (`apple-style.css` "grids per tab", `App.jsx` zoomGrid): Browse is a dense
   * square grid, Work a 3:2 grid with ratings and an optional file name, and + / − step the
   * per-device Thumbnail size without ever taking ⌘/Ctrl + or −.
   */
  test.describe('Browse and Work grids', () => {
    test('Browse draws square tiles that + and − resize', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await expect(timelineUtils.layoutButton(page, 'Browse')).toHaveAttribute('aria-pressed', 'true');
      const before = await tileBox(page, assets[0].id);
      expect(Math.abs(before.width - before.height)).toBeLessThanOrEqual(1);
      await timelineUtils.locator(page).hover();
      // Columns are minmax(size × 0.8, 1fr), as in the template: one step may keep the same column
      // count, so step to the largest size, then to the smallest.
      for (let step = 0; step < 3; step++) {
        await page.keyboard.press('+');
      }
      await expect.poll(() => tileWidth(page, assets[0].id)).toBeGreaterThan(before.width);
      for (let step = 0; step < 5; step++) {
        await page.keyboard.press('-');
      }
      await expect.poll(() => tileWidth(page, assets[0].id)).toBeLessThan(before.width);
      // The reflow animation has finished (interactions.js animateGridChange runs 420 ms).
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-asset-id]')].every((tile) => tile.getAnimations().length === 0),
      );
      // Browser zoom keeps Ctrl + and Ctrl −.
      const settled = await tileWidth(page, assets[0].id);
      await page.keyboard.press('Control+Minus');
      expect(await tileWidth(page, assets[0].id)).toBe(settled);
    });

    /**
     * FL-143: the template's Browse and Work are one `.media-grid` over everything, so a month that
     * ends part-way along a row is followed straight on by the next month's cells.
     */
    test('Browse lays the library out as one grid: rows run on across month boundaries', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await expect(timelineUtils.layoutButton(page, 'Browse')).toHaveAttribute('aria-pressed', 'true');
      await expectRowsRunOn(page);
    });

    test('Work lays the library out as one grid: rows run on across month boundaries', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.setLayout(page, 'Work');
      await expectRowsRunOn(page);
    });

    test('Browse: a month loading above what is on screen does not move it', async ({ page }) => {
      await expectNothingMovesWhenTheMonthAboveLoads(page, async () => {
        await pageUtils.openPhotosPage(page);
        await expect(timelineUtils.layoutButton(page, 'Browse')).toHaveAttribute('aria-pressed', 'true');
      });
    });

    test('Work offers a file-name toggle remembered on this device', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await timelineUtils.setLayout(page, 'Work');
      const show = page.getByRole('button', { name: 'Show file names' });
      await expect(show).toHaveAttribute('aria-pressed', 'false');
      await show.click();
      await expect(page.getByRole('button', { name: 'Hide file names' })).toHaveAttribute('aria-pressed', 'true');
      await page.reload();
      await expect(page.getByRole('button', { name: 'Hide file names' })).toHaveAttribute('aria-pressed', 'true');
      await timelineUtils.setLayout(page, 'Browse');
      await expect(page.getByRole('button', { name: /file names/ })).toHaveCount(0);
    });
  });

  test.describe('selection', () => {
    test('Select day, unselect day', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      // Day headers and their select-all live in the Timeline layout.
      await timelineUtils.setLayout(page, 'Timeline');
      await pageUtils.selectDay(page, 'Wednesday, December 11, 2024');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(4);
      await pageUtils.selectDay(page, 'Wednesday, December 11, 2024');
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

    test('Chained shift-clicks all range from the first anchor', async ({ page }) => {
      await pageUtils.openPhotosPage(page);
      await thumbnailUtils.selectAssetId(page, assets[2].id);
      await page.keyboard.down('Shift');
      await thumbnailUtils.selectButton(page, assets[4].id).click();
      await page.keyboard.up('Shift');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(3);
      // Deselecting inside the range keeps the anchor on the first item (prototype `nextAnchor`).
      await thumbnailUtils.clickAssetId(page, assets[3].id);
      await expect(thumbnailUtils.selectButton(page, assets[3].id)).not.toBeChecked();
      // A shift-click never moves the anchor (prototype `App.jsx` toggleSelect), so this range runs
      // from the first item again and brings the deselected one back.
      await page.keyboard.down('Shift');
      await thumbnailUtils.selectButton(page, assets[5].id).click();
      await page.keyboard.up('Shift');
      await expect(thumbnailUtils.selectedAsset(page)).toHaveCount(4);
      for (const asset of assets.slice(2, 6)) {
        await expect(thumbnailUtils.selectButton(page, asset.id)).toBeChecked();
      }
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
      // FL-71: Trash is a Command Center section, a full-screen settings screen without the
      // library rail; the prototype returns through its "Back to library" link.
      await page.getByRole('link', { name: 'Back to library', exact: true }).click();
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

/** A tile's on-screen box. */
const tileBox = async (page: Page, assetId: string) => {
  const box = await thumbnailUtils.withAssetId(page, assetId).boundingBox();
  return box!;
};

const tileWidth = async (page: Page, assetId: string) => {
  const box = await tileBox(page, assetId);
  return box.width;
};

/** The library in the Timeline layout, grouped by day as it opens. */
const openTimeline = async (page: Page) => {
  await pageUtils.openPhotosPage(page);
  await timelineUtils.setLayout(page, 'Timeline');
  await groupingUtils.expectMode(page, 'Days');
  await expect(groupingUtils.dayHeadings(page).first()).toBeVisible();
};

/** When an asset was captured, as the timeline files it. */
const captured = (assets: TimelineAssetConfig[], assetId: string) => {
  const mockAsset = assets.find((mockAsset) => mockAsset.id === assetId)!;
  return DateTime.fromISO(mockAsset.fileCreatedAt!, { zone: 'utc' });
};

const getYearMonth = (assets: TimelineAssetConfig[], assetId: string) => {
  const dateTime = captured(assets, assetId);
  return dateTime.year + '-' + dateTime.month;
};
