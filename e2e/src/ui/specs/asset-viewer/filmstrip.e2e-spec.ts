import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';
import { assetViewerUtils } from '../timeline/utils';

/**
 * LIB-02: the filmstrip opened scrolled to its start, away from the open item, and once it had scrolled to
 * the open item a click on a thumbnail landed on the strip instead (the thumbnails' layers did not scroll
 * with it, so another thumbnail's layer lay over the one under the pointer).
 */
test.describe('viewer filmstrip', () => {
  let adminUserId: string;
  let timeline: TimelineData;
  let month: TimelineAssetConfig[];
  const testContext = new TimelineTestContext();
  const changes: Changes = { albumAdditions: [], assetDeletions: [], assetArchivals: [], assetFavorites: [] };

  test.beforeAll(() => {
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;
    timeline = generateTimelineData({ ...createDefaultTimelineConfig(), ownerId: adminUserId });
    // the fullest month, so the strip is much wider than the window
    month = timeline.buckets
      .values()
      .toArray()
      .toSorted((a, b) => b.length - a.length)[0];
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timeline, changes, testContext);
  });

  test('opens on the open item and a click on a thumbnail opens it', async ({ page }) => {
    expect(month.length).toBeGreaterThan(40);
    const asset = month[Math.floor(month.length * 0.75)];
    await page.goto(`/photos/${asset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, asset);

    await page.getByRole('button', { name: 'Show filmstrip' }).click();
    const strip = page.getByTestId('viewer-filmstrip');
    const current = strip.locator('[aria-current="true"]');
    await expect(current).toBeInViewport({ ratio: 1 });

    const tiles = strip.locator('.fl-strip-tile');
    const index = await tiles.evaluateAll((all) =>
      all.findIndex((tile) => tile.getAttribute('aria-current') === 'true'),
    );
    const next = tiles.nth(index + 1);
    const nextId = await next.locator('[data-asset]').getAttribute('data-asset');
    // the thumbnail is drawn in its own tile, wherever the strip has scrolled
    const tileBox = await next.boundingBox();
    const pictureBox = await next.locator('img').first().boundingBox();
    expect(Math.round(pictureBox!.x)).toBe(Math.round(tileBox!.x));

    await next.click({ timeout: 5000 });
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/photos/${nextId}`);
  });
});
