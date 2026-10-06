import { faker } from '@faker-js/faker';
import { AssetTypeEnum, type MemoryResponseDto } from '@frameleaf/sdk';
import { expect, test, type Page } from '@playwright/test';
import { generateMemoriesFromTimeline } from 'src/ui/generators/memory.js';
import {
  Changes,
  createDefaultTimelineConfig,
  generateTimelineData,
  TimelineAssetConfig,
  TimelineData,
} from 'src/ui/generators/timeline';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { MemoryChanges, setupMemoryMockApiRoutes } from 'src/ui/mock-network/memory-network.js';
import { setupTimelineMockApiRoutes, TimelineTestContext } from 'src/ui/mock-network/timeline-network.js';
import { memoryAssetViewerUtils, memoryGalleryUtils, memoryViewerUtils } from './utils';

test.describe.configure({ mode: 'parallel' });

/**
 * The last item of a memory whose last item is a photo, paused there: a video's own end (the
 * first memory's last item is a clip that ends in a moment) or a photo's timer would reach the
 * end card on its own, and a Next pressed after that goes on to the next memory.
 */
const openLastItemPaused = async (page: Page, list: MemoryResponseDto[]) => {
  const memory = list.find(({ assets }) => assets.at(-1)!.type === AssetTypeEnum.Image)!;
  const lastAsset = memory.assets.at(-1)!;
  await memoryViewerUtils.openMemoryPageWithAsset(page, memory.id, lastAsset.id);
  const progress = memoryViewerUtils.locator(page).getByRole('group', { name: 'Memory progress' });
  await progress.getByRole('button', { name: 'Pause' }).click();
  await expect(progress.getByRole('button', { name: 'Play' })).toBeVisible();
  return { memory, lastAsset };
};

test.describe('Memory Viewer - Gallery Asset Viewer Navigation', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  let memories: MemoryResponseDto[];
  const assets: TimelineAssetConfig[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = {
    albumAdditions: [],
    assetDeletions: [],
    assetArchivals: [],
    assetFavorites: [],
  };
  const memoryChanges: MemoryChanges = {
    memoryDeletions: [],
    assetRemovals: new Map(),
  };

  test.beforeAll(async () => {
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;

    timelineRestData = generateTimelineData({
      ...createDefaultTimelineConfig(),
      ownerId: adminUserId,
    });

    for (const timeBucket of timelineRestData.buckets.values()) {
      assets.push(...timeBucket);
    }

    memories = generateMemoriesFromTimeline(
      assets,
      adminUserId,
      [
        { year: 2024, assetCount: 3 },
        { year: 2023, assetCount: 2 },
        { year: 2022, assetCount: 4 },
      ],
      42,
    );
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
    await setupMemoryMockApiRoutes(context, memories, memoryChanges);
  });

  test.afterEach(() => {
    testContext.slowBucket = false;
    changes.albumAdditions = [];
    changes.assetDeletions = [];
    changes.assetArchivals = [];
    changes.assetFavorites = [];
    memoryChanges.memoryDeletions = [];
    memoryChanges.assetRemovals.clear();
    memoryChanges.hiddenMemories = [];
    memoryChanges.curations?.clear();
    memoryChanges.exports = [];
    memoryChanges.holdExports = false;
    memoryChanges.savedHighlights = [];
  });

  test.describe('Asset viewer navigation from gallery', () => {
    test('shows both prev/next buttons for middle asset within a memory', async ({ page }) => {
      const firstMemory = memories[0];
      const middleAsset = firstMemory.assets[1];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, middleAsset.id);
      await memoryGalleryUtils.clickThumbnail(page, middleAsset.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, middleAsset);

      await memoryAssetViewerUtils.expectPreviousButtonVisible(page);
      await memoryAssetViewerUtils.expectNextButtonVisible(page);
    });

    test('shows next button when at last asset of first memory (next memory exists)', async ({ page }) => {
      const firstMemory = memories[0];
      const lastAssetOfFirstMemory = firstMemory.assets.at(-1)!;

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, lastAssetOfFirstMemory.id);
      await memoryGalleryUtils.clickThumbnail(page, lastAssetOfFirstMemory.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, lastAssetOfFirstMemory);

      await memoryAssetViewerUtils.expectNextButtonVisible(page);
      await memoryAssetViewerUtils.expectPreviousButtonVisible(page);
    });

    test('shows prev button when at first asset of last memory (prev memory exists)', async ({ page }) => {
      const lastMemory = memories.at(-1)!;
      const firstAssetOfLastMemory = lastMemory.assets[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, lastMemory.id, firstAssetOfLastMemory.id);
      await memoryGalleryUtils.clickThumbnail(page, firstAssetOfLastMemory.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, firstAssetOfLastMemory);

      await memoryAssetViewerUtils.expectPreviousButtonVisible(page);
      await memoryAssetViewerUtils.expectNextButtonVisible(page);
    });

    test('can navigate from last asset of memory to first asset of next memory', async ({ page }) => {
      const firstMemory = memories[0];
      const secondMemory = memories[1];
      const lastAssetOfFirst = firstMemory.assets.at(-1)!;
      const firstAssetOfSecond = secondMemory.assets[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, lastAssetOfFirst.id);
      await memoryGalleryUtils.clickThumbnail(page, lastAssetOfFirst.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, lastAssetOfFirst);

      await memoryAssetViewerUtils.clickNextButton(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, firstAssetOfSecond);

      await memoryAssetViewerUtils.expectCurrentAssetId(page, firstAssetOfSecond.id);
    });

    test('can navigate from first asset of memory to last asset of previous memory', async ({ page }) => {
      const firstMemory = memories[0];
      const secondMemory = memories[1];
      const lastAssetOfFirst = firstMemory.assets.at(-1)!;
      const firstAssetOfSecond = secondMemory.assets[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, secondMemory.id, firstAssetOfSecond.id);
      await memoryGalleryUtils.clickThumbnail(page, firstAssetOfSecond.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, firstAssetOfSecond);

      await memoryAssetViewerUtils.clickPreviousButton(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, lastAssetOfFirst);
    });

    test('hides prev button at very first asset (first memory, first asset, no prev memory)', async ({ page }) => {
      const firstMemory = memories[0];
      const veryFirstAsset = firstMemory.assets[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, veryFirstAsset.id);
      await memoryGalleryUtils.clickThumbnail(page, veryFirstAsset.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, veryFirstAsset);

      await memoryAssetViewerUtils.expectPreviousButtonNotVisible(page);
      await memoryAssetViewerUtils.expectNextButtonVisible(page);
    });

    test('hides next button at very last asset (last memory, last asset, no next memory)', async ({ page }) => {
      const lastMemory = memories.at(-1)!;
      const veryLastAsset = lastMemory.assets.at(-1)!;

      await memoryViewerUtils.openMemoryPageWithAsset(page, lastMemory.id, veryLastAsset.id);
      await memoryGalleryUtils.clickThumbnail(page, veryLastAsset.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, veryLastAsset);

      await memoryAssetViewerUtils.expectNextButtonNotVisible(page);
      await memoryAssetViewerUtils.expectPreviousButtonVisible(page);
    });
  });

  test.describe('Keyboard navigation', () => {
    test('ArrowLeft navigates to previous asset across memory boundary', async ({ page }) => {
      const firstMemory = memories[0];
      const secondMemory = memories[1];
      const lastAssetOfFirst = firstMemory.assets.at(-1)!;
      const firstAssetOfSecond = secondMemory.assets[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, secondMemory.id, firstAssetOfSecond.id);
      await memoryGalleryUtils.clickThumbnail(page, firstAssetOfSecond.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, firstAssetOfSecond);

      await page.keyboard.press('ArrowLeft');
      await memoryAssetViewerUtils.waitForAssetLoad(page, lastAssetOfFirst);
    });

    test('ArrowRight navigates to next asset across memory boundary', async ({ page }) => {
      const firstMemory = memories[0];
      const secondMemory = memories[1];
      const lastAssetOfFirst = firstMemory.assets.at(-1)!;
      const firstAssetOfSecond = secondMemory.assets[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, lastAssetOfFirst.id);
      await memoryGalleryUtils.clickThumbnail(page, lastAssetOfFirst.id);

      await memoryAssetViewerUtils.waitForViewerOpen(page);
      await memoryAssetViewerUtils.waitForAssetLoad(page, lastAssetOfFirst);

      await page.keyboard.press('ArrowRight');
      await memoryAssetViewerUtils.waitForAssetLoad(page, firstAssetOfSecond);
    });
  });

  // FL-62: the shared Memories engine opens a memory with its title card, then shows the lower third.
  test.describe('Memories engine', () => {
    test('opens with the title card and plays on from it', async ({ page }) => {
      const firstMemory = memories[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[0].id);

      const viewer = memoryViewerUtils.locator(page);
      const titleCard = viewer.locator('.fmp-title-card');
      await expect(titleCard).toBeVisible();
      await expect(titleCard.getByText('Memory', { exact: true })).toBeVisible();
      await expect(titleCard.getByText(`${firstMemory.assets.length} items`)).toBeVisible();
      // data-initial-focus (MemoryPlayer.jsx:343)
      await expect(titleCard.getByRole('button', { name: 'Play' })).toBeFocused();

      await titleCard.getByRole('button', { name: 'Play' }).click();
      await expect(titleCard).toHaveCount(0);
      await expect(viewer.locator('.fmp-lower-third')).toBeVisible();
    });

    test('Previous from the first item returns to the title card', async ({ page }) => {
      const firstMemory = memories[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[0].id);
      const titleCard = memoryViewerUtils.locator(page).locator('.fmp-title-card');
      await titleCard.getByRole('button', { name: 'Play' }).click();
      await expect(titleCard).toHaveCount(0);

      await page.keyboard.press('ArrowLeft');
      await expect(titleCard).toBeVisible();
      await expect(titleCard.locator('img.fmp-title-bg')).toHaveCount(1);
    });

    // MPY-4 (MemoryPlayer.jsx:403-446): the end card closes the memory after its last item.
    test('ends a memory on its end card, and Previous returns to the last item', async ({ page }) => {
      const { lastAsset } = await openLastItemPaused(page, memories);
      const viewer = memoryViewerUtils.locator(page);
      await page.keyboard.press('ArrowRight');

      const endCard = viewer.locator('.fmp-end-card');
      await expect(endCard).toBeVisible();
      await expect(endCard.getByText('That was', { exact: true })).toBeVisible();
      // data-initial-focus (MemoryPlayer.jsx:414)
      await expect(endCard.getByRole('button', { name: 'Play again' })).toBeFocused();
      await expect(endCard.getByRole('button', { name: 'Back to memories' })).toBeVisible();
      await expect(endCard.getByRole('button', { name: /^Next memory: / })).toBeVisible();
      await memoryAssetViewerUtils.expectCurrentAssetId(page, lastAsset.id);

      await page.keyboard.press('ArrowLeft');
      await expect(endCard).toHaveCount(0);
      await memoryAssetViewerUtils.expectCurrentAssetId(page, lastAsset.id);
    });

    test('Play again starts the memory from its first item', async ({ page }) => {
      const { memory } = await openLastItemPaused(page, memories);
      await page.keyboard.press('ArrowRight');
      await memoryViewerUtils
        .locator(page)
        .locator('.fmp-end-card')
        .getByRole('button', { name: 'Play again' })
        .click();

      await memoryAssetViewerUtils.expectCurrentAssetId(page, memory.assets[0].id);
    });

    test('does not show the title card when opened part way through', async ({ page }) => {
      const firstMemory = memories[0];

      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[1].id);

      await expect(memoryViewerUtils.locator(page).locator('.fmp-title-card')).toHaveCount(0);
    });
  });

  // FL-62 (MPY-5..MPY-10): the template's header, gallery, keys, Open item and Make a movie.
  test.describe('Memory player controls', () => {
    test('names each progress segment and shows all items with G', async ({ page }) => {
      const firstMemory = memories[0];
      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[1].id);

      const progress = page.getByRole('group', { name: 'Memory progress' });
      await expect(
        progress.getByRole('link', { name: `Go to item 2 of ${firstMemory.assets.length}` }),
      ).toHaveAttribute('aria-current', 'true');

      await page.keyboard.press('g');
      const gallery = page.getByRole('region', { name: 'All items in this memory' });
      await expect(gallery).toBeVisible();
      await gallery.getByRole('button', { name: new RegExp(`^Item 1: `) }).click();
      await expect(gallery).toHaveCount(0);
      await memoryAssetViewerUtils.expectCurrentAssetId(page, firstMemory.assets[0].id);
    });

    test('Home returns to the title card and End goes to the last item', async ({ page }) => {
      const firstMemory = memories[0];
      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[1].id);

      await page.keyboard.press('End');
      await memoryAssetViewerUtils.expectCurrentAssetId(page, firstMemory.assets.at(-1)!.id);

      await page.keyboard.press('Home');
      await expect(memoryViewerUtils.locator(page).locator('.fmp-title-card')).toBeVisible();
      await memoryAssetViewerUtils.expectCurrentAssetId(page, firstMemory.assets[0].id);
    });

    test('M toggles the soundtrack', async ({ page }) => {
      const firstMemory = memories[0];
      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[1].id);

      await page.keyboard.press('m');
      await expect(page.getByRole('button', { name: 'Mute soundtrack' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('Make a movie opens Studio with the memory items', async ({ page }) => {
      const firstMemory = memories[0];
      await memoryViewerUtils.openMemoryPageWithAsset(page, firstMemory.id, firstMemory.assets[1].id);

      await page.getByRole('button', { name: 'Make a movie in Studio' }).click();
      await expect(page).toHaveURL(new RegExp(String.raw`/studio\?.*${firstMemory.assets[0].id}`));
    });
  });

  // FL-62 acceptance: edit, reorder and save a memory, and find it that way when it is reopened.
  test.describe('Memory curation', () => {
    test('renames, reorders and favorites a memory, and keeps them when reopened', async ({ page }) => {
      const memory = memories[2];
      const [first, second] = memory.assets;
      await memoryViewerUtils.openMemoryPageWithAsset(page, memory.id, second.id);

      await page.keyboard.press('g');
      const gallery = page.getByRole('region', { name: 'All items in this memory' });
      await gallery.getByRole('button', { name: 'Rename memory' }).click();
      await page.getByRole('textbox', { name: 'Title' }).fill('Lake weekend');
      await page.getByRole('button', { name: 'Save', exact: true }).click();

      await gallery.getByRole('button', { name: 'Reorder' }).click();
      await gallery.getByRole('button', { name: `Move ${first.originalFileName} later` }).click();
      await expect(gallery.getByRole('button', { name: new RegExp('^Item 1: ') })).toHaveAccessibleName(
        new RegExp(second.originalFileName.replaceAll('.', String.raw`\.`)),
      );
      await gallery.getByRole('button', { name: 'Favorite memory' }).click();

      await page.reload();
      await memoryViewerUtils.waitForMemoryLoad(page);
      await expect(memoryViewerUtils.locator(page).locator('.fmp-heading strong')).toHaveText('Lake weekend');
      await page.keyboard.press('g');
      const reopened = page.getByRole('region', { name: 'All items in this memory' });
      await expect(reopened.getByRole('button', { name: new RegExp('^Item 1: ') })).toHaveAccessibleName(
        new RegExp(second.originalFileName.replaceAll('.', String.raw`\.`)),
      );
      await expect(reopened.getByRole('button', { name: 'Remove memory from favorites' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });

  // FL-62 acceptance: the private export is a job the owner starts, can cancel and retry, then downloads.
  test.describe('Private highlight export', () => {
    test('starts, cancels, retries and downloads an export only when asked', async ({ page }) => {
      const memory = memories[0];
      memoryChanges.holdExports = true;
      await memoryViewerUtils.openMemoryPageWithAsset(page, memory.id, memory.assets[1].id);
      // nothing is exported until the owner asks
      expect(memoryChanges.exports ?? []).toHaveLength(0);

      await page.getByRole('button', { name: 'Export this memory' }).click();
      await expect(page.getByRole('status', { name: `Exporting 1 of ${memory.assets.length}` })).toBeVisible();

      await page.getByRole('button', { name: 'Cancel export' }).click();
      await expect(page.getByRole('button', { name: 'Export this memory' })).toBeVisible();

      memoryChanges.holdExports = false;
      await page.getByRole('button', { name: 'Export this memory' }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download export' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('Memory.zip');
      expect(memoryChanges.exports!.map((run) => run.status)).toEqual(['ready', 'cancelled']);
    });
  });

  // FL-194 acceptance: a highlight video rendered from the memory — options, progress, cancel and
  // retry, then download and save to the library, nothing rendered or saved until the owner asks.
  test.describe('Highlight video', () => {
    test('renders a highlight with the chosen options, cancels, retries, downloads and saves it', async ({ page }) => {
      const memory = memories[0];
      memoryChanges.holdExports = true;
      await memoryViewerUtils.openMemoryPageWithAsset(page, memory.id, memory.assets[1].id);
      expect(memoryChanges.exports ?? []).toHaveLength(0);

      await page.getByRole('button', { name: 'Highlight video', exact: true }).click();
      const dialog = page.getByTestId('memory-highlight-dialog');
      await expect(dialog.getByLabel('Length')).toHaveValue('60');
      await expect(dialog.getByLabel('Resolution')).toHaveValue('2160p');
      await dialog.getByLabel('Length').selectOption('30');
      await dialog.getByLabel('Resolution').selectOption('1080p');
      await dialog.getByLabel('Sound').selectOption('silent');
      await dialog.getByRole('button', { name: 'Render' }).click();

      await expect(page.getByRole('status', { name: 'Rendering highlight video, 30%' })).toBeVisible();
      expect(memoryChanges.exports![0]).toMatchObject({
        format: 'highlight',
        highlight: { lengthSeconds: 30, resolution: '1080p', audio: 'silent', destination: 'local' },
      });

      await page.getByRole('button', { name: 'Stop the highlight video' }).click();
      await page.getByRole('button', { name: 'Try the highlight video again' }).click();
      // a retry opens with the settings the owner chose before
      await expect(dialog.getByLabel('Length')).toHaveValue('30');
      memoryChanges.holdExports = false;
      await dialog.getByRole('button', { name: 'Render' }).click();

      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download highlight video' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('Memory.mp4');
      expect(memoryChanges.savedHighlights ?? []).toHaveLength(0);

      await page.getByRole('button', { name: 'Save highlight video to library' }).click();
      await expect(page.getByRole('link', { name: 'Open the highlight video in your library' })).toBeVisible();
      expect(memoryChanges.savedHighlights).toHaveLength(1);
      expect(memoryChanges.exports!.map((run) => run.status)).toEqual(['ready', 'cancelled']);
    });
  });

  // FL-62 (MI-1): Hide memory replaces deletion, and Restore brings it back.
  test.describe('Memories index', () => {
    test('hides a memory and restores it from Hidden memories', async ({ page }) => {
      await page.goto('/memories');
      const firstCardMenu = page.getByRole('button', { name: /^More actions for / }).first();
      await firstCardMenu.click();
      await page.getByRole('menuitem', { name: 'Hide memory' }).click();

      const hidden = page.getByRole('region', { name: 'Hidden memories' });
      await expect(hidden).toBeVisible();
      await hidden.getByRole('button', { name: /^Show 1/ }).click();
      await hidden.getByRole('button', { name: 'Restore' }).click();
      await expect(hidden).toHaveCount(0);
    });
  });
});

test.describe('Memory Viewer - Single Asset Memory Edge Cases', () => {
  let adminUserId: string;
  let timelineRestData: TimelineData;
  let memories: MemoryResponseDto[];
  const assets: TimelineAssetConfig[] = [];
  const testContext = new TimelineTestContext();
  const changes: Changes = {
    albumAdditions: [],
    assetDeletions: [],
    assetArchivals: [],
    assetFavorites: [],
  };
  const memoryChanges: MemoryChanges = {
    memoryDeletions: [],
    assetRemovals: new Map(),
  };

  test.beforeAll(async () => {
    adminUserId = faker.string.uuid();
    testContext.adminId = adminUserId;

    timelineRestData = generateTimelineData({
      ...createDefaultTimelineConfig(),
      ownerId: adminUserId,
    });

    for (const timeBucket of timelineRestData.buckets.values()) {
      assets.push(...timeBucket);
    }

    memories = generateMemoriesFromTimeline(
      assets,
      adminUserId,
      [
        { year: 2024, assetCount: 2 },
        { year: 2023, assetCount: 1 },
        { year: 2022, assetCount: 2 },
      ],
      123,
    );
  });

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, adminUserId);
    await setupTimelineMockApiRoutes(context, timelineRestData, changes, testContext);
    await setupMemoryMockApiRoutes(context, memories, memoryChanges);
  });

  test.afterEach(() => {
    testContext.slowBucket = false;
    changes.albumAdditions = [];
    changes.assetDeletions = [];
    changes.assetArchivals = [];
    changes.assetFavorites = [];
    memoryChanges.memoryDeletions = [];
    memoryChanges.assetRemovals.clear();
    memoryChanges.hiddenMemories = [];
  });

  test('single asset memory shows both prev/next when surrounded by other memories', async ({ page }) => {
    const singleAssetMemory = memories[1];
    const singleAsset = singleAssetMemory.assets[0];

    await memoryViewerUtils.openMemoryPageWithAsset(page, singleAssetMemory.id, singleAsset.id);
    await memoryGalleryUtils.clickThumbnail(page, singleAsset.id);

    await memoryAssetViewerUtils.waitForViewerOpen(page);
    await memoryAssetViewerUtils.waitForAssetLoad(page, singleAsset);

    await memoryAssetViewerUtils.expectPreviousButtonVisible(page);
    await memoryAssetViewerUtils.expectNextButtonVisible(page);
  });
});
