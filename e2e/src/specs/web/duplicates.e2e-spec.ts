import { AssetMediaResponseDto, getDuplicateReview, LoginResponseDto, updateAssets } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import { asBearerAuth, utils } from 'src/utils.js';

test.describe('Duplicate review', () => {
  let admin: LoginResponseDto;
  let firstAsset: AssetMediaResponseDto;
  let secondAsset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test.beforeEach(async ({ context }) => {
    [firstAsset, secondAsset] = await Promise.all([
      utils.createAsset(admin.accessToken, {}),
      utils.createAsset(admin.accessToken, {}),
    ]);

    await updateAssets(
      {
        assetBulkUpdateDto: {
          ids: [firstAsset.id, secondAsset.id],
          duplicateId: crypto.randomUUID(),
        },
      },
      { headers: asBearerAuth(admin.accessToken) },
    );

    await utils.setAuthCookies(context, admin.accessToken);
  });

  const reviewGroups = () => getDuplicateReview({ headers: asBearerAuth(admin.accessToken) });

  test('opens a copy in the viewer and steps through its group with the arrow keys', async ({ page }) => {
    await page.goto('/utilities/duplicates');
    await page
      .getByRole('button', { name: /^Open / })
      .first()
      .click();
    await page.waitForSelector('#immich-asset-viewer');

    const getViewedAssetId = () => new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const initialAssetId = getViewedAssetId();
    expect([firstAsset.id, secondAsset.id]).toContain(initialAssetId);

    await page.keyboard.press('ArrowRight');
    await expect.poll(getViewedAssetId).not.toBe(initialAssetId);

    await page.keyboard.press('ArrowLeft');
    await expect.poll(getViewedAssetId).toBe(initialAssetId);
  });

  test('keeps every copy with one key, without a confirmation, and undoes it after a reload', async ({ page }) => {
    const before = (await reviewGroups()).length;
    await page.goto('/utilities/duplicates');
    const review = page.getByTestId('frameleaf-duplicate-review');
    await expect(review.getByRole('heading', { level: 2 })).toBeVisible();

    // A: keep all. No dialog; the decision runs as a durable job and the group leaves the review.
    await page.keyboard.press('a');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await reviewGroups()).length, { timeout: 30_000 }).toBe(before - 1);

    // the undo survives a reload: the server keeps the decision history
    await page.reload();
    const undo = page.getByRole('button', { name: /^Undo/ }).first();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect.poll(async () => (await reviewGroups()).length, { timeout: 30_000 }).toBe(before);
  });

  test('lists only the signed-in account’s groups, each complete', async () => {
    const groups = await reviewGroups();
    const ids = groups.flatMap((group) => group.assets.map((asset) => asset.id));
    expect(ids).toEqual(expect.arrayContaining([firstAsset.id, secondAsset.id]));
    for (const group of groups) {
      expect(group.hiddenMemberCount).toBe(0);
      expect(group.editable).toBe(true);
    }
  });
});
