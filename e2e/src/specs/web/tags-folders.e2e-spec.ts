import { LoginResponseDto, updateTag } from '@immich/sdk';
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

  test('walks the tag tree with the keyboard, counts only visible items, and Back returns', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/tags');

    const tree = page.getByRole('tree', { name: 'Tags' });
    const trips = tree.getByRole('treeitem', { name: /^trips/ });
    // the hidden (archived) descendant item is not counted anywhere up the tree
    await expect(trips.locator(':scope > .dv-tree-row small')).toHaveText('1');

    await trips.focus();
    await page.keyboard.press('ArrowRight');
    await expect(trips).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/tags\?path=trips%2Frockies%2Flakes/);

    const detail = page.getByRole('region', { name: 'Tag lakes' });
    await expect(detail.getByRole('button', { name: 'Show all 1 item' })).toBeEnabled();
    await expect(detail.locator('.dv-strip img')).toHaveCount(1);

    await tree.getByRole('treeitem', { name: /^family/ }).click();
    await page.waitForURL(/\/tags\?path=family/);
    await expect(page.getByRole('region', { name: 'Tag family' })).toBeVisible();

    await page.goBack();
    await page.waitForURL(/\/tags\?path=trips%2Frockies%2Flakes/);
    await expect(page.getByRole('region', { name: 'Tag lakes' })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: /^lakes/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('renames, moves to the top level and deletes a tag, and a gone tag is not found', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const [scratch] = await utils.upsertTags(admin.accessToken, ['trips/scratch']);
    await page.goto(`/tags?path=${encodeURIComponent('trips/scratch')}`);

    await page.getByRole('button', { name: 'Rename' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename tag' });
    await rename.getByRole('textbox', { name: 'Name' }).fill('renamed');
    await rename.getByRole('button', { name: 'Save' }).click();
    await page.waitForURL(/\/tags\?path=trips%2Frenamed/);

    await page.getByRole('button', { name: 'More tag actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to top level' }).click();
    await page.waitForURL(/\/tags\?path=renamed$/);

    await page.getByRole('button', { name: 'More tag actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete tag' }).click();
    const remove = page.getByRole('dialog', { name: 'Delete tag' });
    await expect(remove).toContainText('No items use this tag.');
    await remove.getByRole('button', { name: 'Delete' }).click();
    await page.waitForURL(/\/tags$/);
    await expect(page.getByRole('heading', { name: 'Choose a tag' })).toBeVisible();

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

  test('browses a storage folder, lists only visible files, opens one and Back returns', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/folders');

    const folderTree = page.getByRole('tree', { name: 'Folders' });
    await expect(folderTree.getByRole('treeitem').first()).toContainText('All folders');
    // walk down to the deepest folder with the keyboard: the one holding the files
    const chosen = folderTree.locator('[role="treeitem"][aria-selected="true"]');
    await chosen.focus();
    for (let step = 0; step < 12; step++) {
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Enter');

    const files = page.locator('.dv-file-grid-host [data-testid="frameleaf-asset-tile"]');
    await expect(files).toHaveCount(1);
    await expect(page.locator('.dv-file-grid-host .fl-grid-caption')).toContainText('lake.png');
    await expect(page.getByRole('contentinfo')).toContainText('1 file');
    const folderUrl = page.url();

    await files.first().locator('.fl-tile-open').click();
    await page.waitForURL(/\/folders\/photos\/[\w-]+/);
    await page.goBack();
    await page.waitForURL(folderUrl);
    await expect(files).toHaveCount(1);

    await page.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'All folders' }).click();
    await page.waitForURL(/\/folders\?path=%2F$/);
    await page.goBack();
    await page.waitForURL(folderUrl);
  });

  test('changes a tag colour from the colour menu by name', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    const [tag] = await utils.upsertTags(admin.accessToken, ['colours']);
    await updateTag({ id: tag.id, tagUpdateDto: { color: '#5794f7' } }, { headers: asBearerAuth(admin.accessToken) });
    await page.goto('/tags?path=colours');
    await page.getByRole('button', { name: 'Change colour' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemcheckbox', { name: 'Pink' }).click();
    await expect(page.getByText('Colour changed to Pink.')).toBeAttached();
  });
});
