import { expect, test } from '@playwright/test';
import { assetViewerUtils, thumbnailUtils, timelineUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

test.describe('FL-40 tab session after reload', () => {
  const fixture = setupAssetViewerFixture(4040);

  test('restores selection in this tab without selecting in a new tab', async ({ context, page }) => {
    await page.goto('/photos');
    await timelineUtils.waitForTimelineLoad(page);
    const selected = fixture.assets[0].id;
    await thumbnailUtils.ensureSelected(page, selected);

    await page.reload();
    await expect(thumbnailUtils.selectButton(page, selected)).toBeChecked();

    const otherTab = await context.newPage();
    await otherTab.goto('/photos');
    await timelineUtils.waitForTimelineLoad(otherTab);
    await expect(thumbnailUtils.selectButton(otherTab, selected)).not.toBeChecked();
    await otherTab.close();
  });

  test('returns keyboard focus from quick edit to the viewer, then to its library tile', async ({ context, page }) => {
    const asset = fixture.assets.find((item) => item.isImage)!;
    await context.route('**/api/assets/*/develop', (route) =>
      route.fulfill({ json: { assetId: asset.id, currentRevisionId: null, revisions: [] } }),
    );

    await page.goto('/photos');
    await timelineUtils.waitForTimelineLoad(page);
    const tile = thumbnailUtils.openButton(page, asset.id);
    await tile.focus();
    await page.keyboard.press('Enter');
    await assetViewerUtils.waitForViewerLoad(page, asset);

    const edit = page.getByRole('button', { name: 'Edit', exact: true });
    await edit.focus();
    await page.keyboard.press('Enter');
    const editor = page.getByRole('dialog', { name: /^Edit / });
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeVisible();
    await expect(edit).toBeFocused();

    await page.keyboard.press('Escape');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/photos');
    await expect(tile).toBeFocused();
  });

  test('reopens a real photo draft after reload and clears it on sign out', async ({ context, page }) => {
    const asset = fixture.primaryAsset;
    await context.route('**/api/assets/*/develop', (route) =>
      route.fulfill({ json: { assetId: asset.id, currentRevisionId: null, revisions: [] } }),
    );

    await page.goto(`/photos/${asset.id}`);
    await assetViewerUtils.waitForViewerLoad(page, asset);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: /^Edit / });
    await expect(editor).toBeVisible();
    await editor.getByRole('tab', { name: 'Crop' }).click();
    const square = editor.getByRole('radio', { name: 'Square' });
    await square.click();
    await expect(square).toBeChecked();
    await expect(editor.getByRole('button', { name: 'Undo' })).toBeEnabled();

    const draftKey = `frameleaf.editor.continuity.${asset.id}`;
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).not.toBeNull();
    await page.reload();
    await expect(editor).toBeVisible();
    await expect(editor.getByRole('tab', { name: 'Crop' })).toHaveAttribute('aria-selected', 'true');
    await expect(editor.getByRole('radio', { name: 'Square' })).toBeChecked();
    await expect(editor.getByRole('button', { name: 'Undo' })).toBeEnabled();

    await page.goto('/auth/logout');
    await expect.poll(() => page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
  });
});
