import { LoginResponseDto, updateTag } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-46 (Tags.jsx, Folders.jsx): the Tags and Folders browsers. Counts come only from items the
 * Timeline shows, so an archived item tagged with a subtag (a hidden descendant asset) is never
 * counted, previewed or listed; the trees work from the keyboard; the chosen tag or folder is the
 * address, so browser Back returns to the previous one; and deep links work whether or not the rail
 * shows the destination.
 */
test.describe('Tags and Folders', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    const visible = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'lake.png' },
      fileCreatedAt: '2026-08-02T18:00:00.000Z',
    });
    const hidden = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'hidden.png' },
      fileCreatedAt: '2026-08-03T09:00:00.000Z',
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    await utils.archiveAssets(admin.accessToken, [hidden.id]);

    const [lakes] = await utils.upsertTags(admin.accessToken, ['trips/rockies/lakes']);
    await utils.upsertTags(admin.accessToken, ['family']);
    await utils.tagAssets(admin.accessToken, lakes.id, [visible.id, hidden.id]);
  });

  test('shows tags as cards, walks the list with the keyboard, counts only visible items, and Back returns', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/tags');

    // One card per top-level tag. The hidden (archived) item under trips is neither counted nor a cover.
    const trips = page.getByRole('article', { name: 'trips' });
    await expect(trips.getByRole('link', { name: 'Open trips, 1 item' })).toBeVisible();
    await expect(trips.locator('img')).toHaveCount(1);
    await expect(page.getByRole('article', { name: 'family' }).getByText('No items yet')).toBeVisible();

    // The list is the tree. It opens one level deep; the keyboard opens the rest and chooses a tag.
    await page.getByRole('button', { name: 'List', exact: true }).click();
    const list = page.getByRole('treegrid', { name: 'Tags' });
    const row = (name: string) => list.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
    await expect(row('trips')).toHaveAttribute('aria-expanded', 'true');
    await expect(row('trips').getByRole('gridcell').nth(1)).toHaveText('1');
    await row('trips').focus();
    await page.keyboard.press('ArrowDown');
    await expect(row('rockies')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(row('rockies')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(row('lakes')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/tags\?path=trips%2Frockies%2Flakes/);

    // The tag's page: its count, and the library grid with only the visible item.
    const detail = page.getByRole('region', { name: 'Tag lakes' });
    await expect(detail.getByText('1 item', { exact: true })).toBeVisible();
    await expect(page.locator('[data-testid="frameleaf-asset-tile"]')).toHaveCount(1);

    await detail.getByRole('navigation', { name: 'Tag path' }).getByRole('link', { name: 'rockies' }).click();
    await page.waitForURL(/\/tags\?path=trips%2Frockies(&|$)/);
    const rockies = page.getByRole('region', { name: 'Tag rockies' });
    await expect(
      rockies.getByRole('region', { name: 'Tags inside' }).getByRole('article', { name: 'lakes' }),
    ).toBeVisible();

    await page.goBack();
    await page.waitForURL(/\/tags\?path=trips%2Frockies%2Flakes/);
    await expect(page.getByRole('region', { name: 'Tag lakes' })).toBeVisible();

    // Back again is the index, still as the list it was left as.
    await page.goBack();
    await page.waitForURL(/\/tags$/);
    await expect(page.getByRole('treegrid', { name: 'Tags' })).toBeVisible();
    await page.getByRole('button', { name: 'Cards', exact: true }).click();
  });

  test('renames, moves to the top level and deletes a tag, and a gone tag is not found', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const [scratch] = await utils.upsertTags(admin.accessToken, ['trips/scratch']);
    await page.goto(`/tags?path=${encodeURIComponent('trips/scratch')}`);

    // The name is edited in place; the tag's address follows it.
    await page.getByTitle('Edit tag name').click();
    const name = page.getByRole('textbox', { name: 'Edit tag name' });
    await name.fill('renamed');
    await name.press('Enter');
    await page.waitForURL(/\/tags\?path=trips%2Frenamed/);

    await page.getByRole('button', { name: 'Move', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Move “renamed”' });
    await move.getByRole('combobox', { name: 'Inside' }).selectOption({ label: 'None (top level)' });
    await move.getByRole('button', { name: 'Move' }).click();
    await page.waitForURL(/\/tags\?path=renamed(&|$)/);

    await page.getByRole('button', { name: 'More tag actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete tag' }).click();
    const remove = page.getByRole('dialog', { name: 'Delete tag' });
    await expect(remove).toContainText('No items use this tag.');
    await remove.getByRole('button', { name: 'Delete' }).click();
    // a deleted top-level tag gives way to the index
    await page.waitForURL(/\/tags$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tags' })).toBeVisible();
    await expect(page.getByRole('article', { name: 'renamed' })).toHaveCount(0);

    // the old address of a renamed and then deleted tag is simply not found
    await page.goto(`/tags?path=${encodeURIComponent('trips/scratch')}`);
    await expect(page.getByText('We can’t find that page')).toBeVisible();
    expect(scratch.id).toBeTruthy();
  });

  test('keeps deep links working when the rail hides Tags and Folders', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await utils.updateMyPreferences(admin.accessToken, {
      tags: { enabled: true, sidebarWeb: false },
      folders: { enabled: true, sidebarWeb: false },
    });
    try {
      await page.goto('/tags?path=family');
      await expect(page.getByRole('region', { name: 'Tag family' })).toBeVisible();
      await page.goto('/folders');
      await expect(page.getByRole('heading', { level: 1, name: 'Folders' })).toBeVisible();
    } finally {
      await utils.updateMyPreferences(admin.accessToken, {
        tags: { enabled: true, sidebarWeb: true },
        folders: { enabled: true, sidebarWeb: true },
      });
    }
  });

  test('browses storage folders as cards, lists only visible files, opens one and Back returns', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    // A second visible original, so the library branches and there are folders to walk (FoldersV2.jsx).
    const peak = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'peak.png' },
      fileCreatedAt: '2026-08-04T10:00:00.000Z',
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    const { originalPath } = await utils.getAssetInfo(admin.accessToken, peak.id);
    const peakFolder = originalPath.slice(0, originalPath.lastIndexOf('/'));
    const openFolder = () => new URL(page.url()).searchParams.get('path');

    // lake.png and one peak.png for every attempt at this test; the archived original is never counted.
    const visibleOriginals = 2 + test.info().retry;

    await page.goto('/folders');
    // The browser starts where the tree first branches, never at "/": a card for each folder on the
    // way to a visible original. Each card's link says how many items are under it.
    await expect(page.getByRole('heading', { level: 1, name: 'Folders' })).toBeVisible();
    const cards = page.locator('section.folders article a.cover');
    await expect(cards.first()).toBeVisible();
    const topCards = await cards.count();
    expect(topCards).toBeGreaterThan(1);
    const counted = await cards.evaluateAll((links) =>
      links.map((link) => Number(/, (\d+) items?$/.exec(link.getAttribute('aria-label') ?? '')?.[1])),
    );
    expect(counted.reduce((sum, count) => sum + count, 0)).toBe(visibleOriginals);

    // walk down the cards to the folder that holds peak.png
    for (let step = 0; step < 4 && openFolder() !== peakFolder; step++) {
      const paths = await cards.evaluateAll((links) =>
        links.map((link) => new URL((link as HTMLAnchorElement).href).searchParams.get('path') ?? ''),
      );
      const index = paths.findIndex((path) => peakFolder === path || peakFolder.startsWith(`${path}/`));
      expect(index).toBeGreaterThanOrEqual(0);
      await cards.nth(index).click();
      await page.waitForURL((url) => url.searchParams.get('path') === paths[index]);
    }
    expect(openFolder()).toBe(peakFolder);

    const files = page.locator('section.folders [data-testid="frameleaf-asset-tile"]');
    await expect(files).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 2, name: /^In this folder\s+1 item$/ })).toBeVisible();
    // file names stay off until they are asked for
    await expect(page.locator('section.folders .fl-grid-caption')).toHaveCount(0);
    await page.getByRole('button', { name: 'File names' }).click();
    await expect(page.locator('section.folders .fl-grid-caption')).toContainText('peak.png');
    const folderUrl = page.url();

    await files.first().locator('.fl-tile-open').click();
    await page.waitForURL(/\/folders\/photos\/[\w-]+/);
    // The address changes before the viewer has loaded its item; go back from the open viewer.
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();
    await page.goBack();
    await page.waitForURL(folderUrl);
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(files).toHaveCount(1);

    // the path pills lead back up; browser Back returns to the folder
    await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'All folders' }).click();
    await expect(cards).toHaveCount(topCards);
    await expect(page.getByRole('heading', { level: 1, name: 'Folders' })).toBeVisible();
    await page.goBack();
    await page.waitForURL(folderUrl);
    await expect(files).toHaveCount(1);
  });

  test('changes a tag colour from the colour tile by name', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const [tag] = await utils.upsertTags(admin.accessToken, ['colours']);
    await updateTag({ id: tag.id, tagUpdateDto: { color: '#5794f7' } }, { headers: asBearerAuth(admin.accessToken) });
    await page.goto('/tags?path=colours');
    await page.getByRole('button', { name: 'Change colour' }).click();
    const colours = page.getByRole('dialog', { name: 'Tag colour' });
    await expect(colours.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    await colours.getByRole('radio', { name: 'Pink' }).click();
    await expect(page.getByText('Colour changed to Pink.')).toBeAttached();
    await expect(colours).toHaveCount(0);
  });
});
