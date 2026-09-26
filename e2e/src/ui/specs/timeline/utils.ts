import { expect, Page } from '@playwright/test';
import { TimelineAssetConfig } from 'src/ui/generators/timeline.js';

/**
 * Helpers for the Frameleaf library (`LibraryView` + `LibraryTimeline`), built from the prototype's
 * `TimelineLibrary.jsx`, `AssetTile.jsx`, `SelectionBar.jsx` and `shortcuts.mjs`.
 *
 * Browse is the default layout; Timeline shows the sticky day headers with their select-all
 * checkbox. Each tile is an `<article data-asset-id>` holding the open button and a select checkbox.
 */

export const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const padYearMonth = (yearMonth: string) => {
  const [year, month] = yearMonth.split('-', 2);
  return `${year}-${month.padStart(2, '0')}`;
};

export const poll = async <T>(
  page: Page,
  query: () => Promise<T>,
  callback?: (result: Awaited<T> | undefined) => boolean,
) => {
  let result;
  const timeout = Date.now() + 10_000;

  const terminate = callback || ((result: Awaited<T> | undefined) => !!result);
  while (!terminate(result) && Date.now() < timeout) {
    try {
      result = await query();
    } catch {
      // ignore
    }
    if (page.isClosed()) {
      return;
    }
    try {
      await page.waitForTimeout(50);
    } catch {
      return;
    }
  }
  if (!result) {
    // rerun to trigger error if any
    result = await query();
  }
  return result;
};

const TILE = '[data-testid="frameleaf-asset-tile"]';

export const thumbnailUtils = {
  locator(page: Page) {
    return page.locator(`[data-testid="frameleaf-timeline"] ${TILE}`);
  },
  withAssetId(page: Page, assetId: string) {
    return page.locator(`${TILE}[data-asset-id="${assetId}"]`);
  },
  /** The tile's main button: opens the item, or toggles it while a selection is in progress. */
  openButton(page: Page, assetId: string) {
    return thumbnailUtils.withAssetId(page, assetId).locator('button').first();
  },
  selectButton(page: Page, assetId: string) {
    return thumbnailUtils.withAssetId(page, assetId).getByRole('checkbox');
  },
  selectedAsset(page: Page) {
    return page.locator(`${TILE}:has(input[type="checkbox"]:checked)`);
  },
  async clickAssetId(page: Page, assetId: string) {
    await thumbnailUtils.openButton(page, assetId).click();
  },
  /** Tick a tile's checkbox. */
  async selectAssetId(page: Page, assetId: string) {
    await thumbnailUtils.withAssetId(page, assetId).hover();
    await thumbnailUtils.selectButton(page, assetId).click();
  },
  /**
   * Make sure a tile is selected and the selection bar acts on it. The library session keeps its
   * selection after an action, and a destination settles its own selection as it opens, so the item
   * may already be selected, or be deselected once more as the page finishes loading.
   */
  async ensureSelected(page: Page, assetId: string) {
    await expect(async () => {
      if (!(await thumbnailUtils.selectButton(page, assetId).isChecked())) {
        await thumbnailUtils.selectAssetId(page, assetId);
      }
      await expect(thumbnailUtils.selectButton(page, assetId)).toBeChecked({ timeout: 1000 });
      await expect(selectionBarUtils.locator(page)).toContainText(/[1-9]\d* selected/, { timeout: 1000 });
      await page.waitForTimeout(250);
      await expect(thumbnailUtils.selectButton(page, assetId)).toBeChecked({ timeout: 100 });
    }).toPass();
  },
  /** Asset ids of the tiles that intersect the timeline's scroll area, in DOM order. */
  async idsInViewport(page: Page) {
    return await timelineUtils.locator(page).evaluate((scroller, selector) => {
      const box = scroller.getBoundingClientRect();
      return [...scroller.querySelectorAll<HTMLElement>(selector)]
        .filter((tile) => {
          const rect = tile.getBoundingClientRect();
          return rect.bottom > box.top && rect.top < box.bottom && rect.height > 0;
        })
        .map((tile) => tile.dataset.assetId!);
    }, TILE);
  },
  /** The favorite badge, not the hover action that shares its tooltip (`AssetTile.jsx` `.at-actions`). */
  favoriteBadge(page: Page, assetId: string) {
    return thumbnailUtils.withAssetId(page, assetId).locator('.fl-tile-badges').getByTitle('Favorite', { exact: true });
  },
  async expectThumbnailIsFavorite(page: Page, assetId: string) {
    await expect(thumbnailUtils.favoriteBadge(page, assetId)).toHaveCount(1);
  },
  async expectThumbnailIsNotFavorite(page: Page, assetId: string) {
    await expect(thumbnailUtils.favoriteBadge(page, assetId)).toHaveCount(0);
  },
  /** Whether any tile in the timeline's scroll area satisfies `predicate`. */
  async someInViewport(page: Page, predicate: (assetId: string) => boolean) {
    const ids = await thumbnailUtils.idsInViewport(page);
    return ids.some((assetId) => predicate(assetId));
  },
  /** The asset whose tile holds keyboard focus. */
  activeAssetId(page: Page) {
    return page.evaluate(() => {
      const element = document.activeElement;
      const tile = element ? element.closest<HTMLElement>('[data-asset-id]') : null;
      return tile ? tile.dataset.assetId : undefined;
    });
  },
  async expectTimelineHasOnScreenAssets(page: Page) {
    await expect.poll(() => thumbnailUtils.someInViewport(page, () => true)).toBe(true);
  },
  async expectInViewport(page: Page, assetId: string) {
    await expect.poll(() => thumbnailUtils.someInViewport(page, (id) => id === assetId)).toBe(true);
  },
  /** The tile's bottom edge is the scroll area's bottom edge: it was scrolled no further than needed. */
  async expectBottomIsTimelineBottom(page: Page, assetId: string) {
    await expect
      .poll(async () => {
        const box = await thumbnailUtils.withAssetId(page, assetId).boundingBox();
        const gridBox = await timelineUtils.locator(page).boundingBox();
        return Math.abs(box!.y + box!.height - (gridBox!.y + gridBox!.height));
      })
      .toBeLessThan(2);
  },
  /**
   * The tile's top edge is the top of the visible scroll area — just below the sticky results
   * toolbar (apple-style.css "#3 materials") — so it was scrolled no further than needed.
   */
  async expectTopIsTimelineTop(page: Page, assetId: string) {
    await expect
      .poll(async () => {
        // The toolbar's real bottom edge, not --fl-sticky-offset: the app positions tiles by that value.
        const box = await thumbnailUtils.withAssetId(page, assetId).boundingBox();
        const toolbarBox = await page.getByTestId('frameleaf-results-toolbar').boundingBox();
        return Math.abs(box!.y - (toolbarBox!.y + toolbarBox!.height));
      })
      .toBeLessThan(2);
  },
};

export const timelineUtils = {
  /** The timeline's scroll area. */
  locator(page: Page) {
    return page.locator('[data-testid="frameleaf-timeline"] .fl-timeline-scroll');
  },
  async waitForTimelineLoad(page: Page) {
    await expect(timelineUtils.locator(page)).toHaveCount(1);
    await expect(timelineUtils.locator(page)).toBeInViewport();
    await expect.poll(() => thumbnailUtils.locator(page).count()).toBeGreaterThan(0);
  },
  async getScrollTop(page: Page) {
    const queryTop = () => timelineUtils.locator(page).evaluate((element) => element.scrollTop);
    await expect.poll(queryTop).toBeGreaterThan(0);
    return await queryTop();
  },
  layoutButton(page: Page, layout: 'Timeline' | 'Browse' | 'Work') {
    return page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: layout, exact: true });
  },
  async setLayout(page: Page, layout: 'Timeline' | 'Browse' | 'Work') {
    await timelineUtils.layoutButton(page, layout).click();
    await expect(timelineUtils.layoutButton(page, layout)).toHaveAttribute('aria-pressed', 'true');
  },
  /** The grouping carried in the portable view state (`?fl=`). */
  grouping(page: Page) {
    const raw = new URL(page.url()).searchParams.get('fl');
    return raw ? (JSON.parse(raw) as { grouping?: string }).grouping : undefined;
  },
};

/**
 * The Timeline layout's grouping (prototype `TimelineLibrary.jsx`): the Years / Months / Days / All
 * control, ⌘/Ctrl+wheel and pinch. Days draw a header per day; the coarser modes draw one sticky
 * header per month, year or for everything, over the group's tiles.
 */
export const groupingUtils = {
  button(page: Page, mode: 'Years' | 'Months' | 'Days' | 'All') {
    return page.getByRole('group', { name: 'Timeline grouping' }).getByRole('button', { name: mode, exact: true });
  },
  async choose(page: Page, mode: 'Years' | 'Months' | 'Days' | 'All') {
    await groupingUtils.button(page, mode).click();
    await groupingUtils.expectMode(page, mode);
  },
  async expectMode(page: Page, mode: 'Years' | 'Months' | 'Days' | 'All') {
    await expect(groupingUtils.button(page, mode)).toHaveAttribute('aria-pressed', 'true');
  },
  /** The month, year or "all" group headers. */
  groupHeadings(page: Page) {
    return page.getByTestId('frameleaf-group').getByRole('heading', { level: 2 });
  },
  /** The curated Years or Months cards (FL-33). */
  cards(page: Page) {
    return page.getByTestId('frameleaf-timeline-cards').getByRole('listitem');
  },
  /** The per-day headers of the Days grouping. */
  dayHeadings(page: Page) {
    return page.getByTestId('frameleaf-day-group').getByRole('heading', { level: 2 });
  },
  /**
   * Every tile in the scroll area paired with the title of the nearest header above it, read from
   * the rendered geometry: a tile belongs to the group whose header it is drawn under.
   */
  async tilesUnderHeadings(page: Page, headingSelector: string) {
    return await timelineUtils.locator(page).evaluate(
      (scroller, { tile, heading }) => {
        const box = scroller.getBoundingClientRect();
        const headings = [...scroller.querySelectorAll<HTMLElement>(heading)]
          .map((element) => ({ title: element.textContent?.trim() ?? '', rect: element.getBoundingClientRect() }))
          .filter(({ rect }) => rect.height > 0)
          .toSorted((a, b) => a.rect.top - b.rect.top);
        return [...scroller.querySelectorAll<HTMLElement>(tile)]
          .map((element) => ({ id: element.dataset.assetId!, rect: element.getBoundingClientRect() }))
          .filter(({ rect }) => rect.bottom > box.top && rect.top < box.bottom && rect.height > 0)
          .map(({ id, rect }) => ({
            id,
            heading: headings.findLast((candidate) => candidate.rect.bottom <= rect.top + 1)?.title,
          }));
      },
      { tile: TILE, heading: headingSelector },
    );
  },
};

/**
 * Years and All justify a whole group as one flow (prototype `TimelineLibrary.jsx` justifiedRows over
 * `group.assets`, FL-143), read from the rendered geometry.
 */
export const flowUtils = {
  /**
   * The rows of tiles wholly inside the scroll area, top to bottom and each left to right. A row is
   * the tiles that share a top edge.
   */
  async rowsOnScreen(page: Page) {
    return await timelineUtils.locator(page).evaluate((scroller, tile) => {
      const box = scroller.getBoundingClientRect();
      const rows = new Map<number, { id: string; left: number; right: number }[]>();
      for (const element of scroller.querySelectorAll<HTMLElement>(tile)) {
        const rect = element.getBoundingClientRect();
        if (rect.height === 0 || rect.top < box.top || rect.bottom > box.bottom) {
          continue;
        }
        const top = Math.round(rect.top);
        const row = rows.get(top) ?? [];
        row.push({ id: element.dataset.assetId!, left: rect.left, right: rect.right });
        rows.set(top, row);
      }
      return [...rows.entries()]
        .toSorted(([a], [b]) => a - b)
        .map(([, row]) => row.toSorted((a, b) => a.left - b.left));
    }, TILE);
  },
  /** Where each tile wholly inside the scroll area sits, relative to the scroll area. */
  async placesOnScreen(page: Page) {
    return await timelineUtils.locator(page).evaluate((scroller, tile) => {
      const box = scroller.getBoundingClientRect();
      const places: Record<string, { top: number; left: number; width: number }> = {};
      for (const element of scroller.querySelectorAll<HTMLElement>(tile)) {
        const rect = element.getBoundingClientRect();
        if (rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom) {
          places[element.dataset.assetId!] = { top: rect.top - box.top, left: rect.left, width: rect.width };
        }
      }
      return places;
    }, TILE);
  },
  /**
   * Month placeholders still showing in the scroll area or just past its edges. A month's last row
   * only runs on into the next month once that month has loaded, so rows at an edge are read after
   * the neighbour beyond it has loaded too.
   */
  async skeletonsOnScreen(page: Page) {
    return await timelineUtils.locator(page).evaluate((scroller) => {
      const box = scroller.getBoundingClientRect();
      return [...scroller.querySelectorAll<HTMLElement>('[data-skeleton]')].filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.bottom >= box.top - 50 && rect.top <= box.bottom + 50;
      }).length;
    });
  },
};

export const scrubberUtils = {
  slider(page: Page) {
    return page.getByRole('slider', { name: 'Jump to a month' });
  },
  tick(page: Page, yearMonth: string) {
    return page.locator(`[data-testid="frameleaf-year-scrubber"] [data-year-month="${yearMonth}"]`);
  },
  /** Press on the track at a month's tick, which scrolls the timeline into that month. */
  async clickMonth(page: Page, yearMonth: string) {
    const track = (await scrubberUtils.slider(page).boundingBox())!;
    const tick = (await scrubberUtils.tick(page, yearMonth).boundingBox())!;
    await page.mouse.click(track.x + track.width / 2, tick.y + tick.height / 2);
  },
};

export const assetViewerUtils = {
  locator(page: Page) {
    return page.locator('#immich-asset-viewer');
  },
  async waitForViewerLoad(page: Page, asset: TimelineAssetConfig) {
    await page
      .locator(
        `img[draggable="false"][src="/api/assets/${asset.id}/thumbnail?size=preview&c=${asset.thumbhash}&edited=true"]`,
      )
      .or(
        page.locator(`video[poster="/api/assets/${asset.id}/thumbnail?size=preview&c=${asset.thumbhash}&edited=true"]`),
      )
      .waitFor();
  },
  /** The asset whose tile holds keyboard focus. */
  async expectActiveAssetToBe(page: Page, assetId: string) {
    await expect(
      poll(
        page,
        () => thumbnailUtils.activeAssetId(page),
        (result) => result === assetId,
      ),
    ).resolves.toBe(assetId);
  },
};

export const selectionBarUtils = {
  locator(page: Page) {
    return page.getByRole('region', { name: 'Selected items' });
  },
  action(page: Page, name: string) {
    return selectionBarUtils.locator(page).getByRole('button', { name, exact: true });
  },
  async menuAction(page: Page, name: string) {
    // SelectionBar.jsx: the overflow button and its menu are both named "More actions".
    await selectionBarUtils.action(page, 'More actions').click();
    await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name, exact: true }).click();
  },
};

export const pageUtils = {
  async deepLinkPhotosPage(page: Page, assetId: string) {
    await page.goto(`/photos?at=${assetId}`);
    await timelineUtils.waitForTimelineLoad(page);
  },
  async openPhotosPage(page: Page) {
    await page.goto(`/photos`);
    await timelineUtils.waitForTimelineLoad(page);
  },
  async openFavorites(page: Page) {
    await page.goto(`/favorites`);
    await timelineUtils.waitForTimelineLoad(page);
  },
  async openAlbumPage(page: Page, albumId: string) {
    await page.goto(`/albums/${albumId}`);
    await timelineUtils.waitForTimelineLoad(page);
  },
  async openArchivePage(page: Page) {
    await page.goto(`/archive`);
    await timelineUtils.waitForTimelineLoad(page);
  },
  async deepLinkAlbumPage(page: Page, albumId: string, assetId: string) {
    await page.goto(`/albums/${albumId}?at=${assetId}`);
    await timelineUtils.waitForTimelineLoad(page);
  },
  /** Tick a day's select-all checkbox. Day headers show in the Timeline and Work layouts. */
  async selectDay(page: Page, day: string) {
    const section = page.getByRole('region', { name: day, exact: true });
    await section.hover();
    await section.getByRole('checkbox', { name: `Select all in ${day}` }).click();
  },
  async pauseTestDebug() {
    console.log('NOTE: pausing test indefinitely for debug');
    await new Promise(() => void 0);
  },
};
