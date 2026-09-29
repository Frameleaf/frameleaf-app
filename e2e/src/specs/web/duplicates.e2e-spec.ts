import {
  AssetMediaResponseDto,
  AssetTypeEnum,
  DuplicateDecisionKind,
  getDuplicateDecisions,
  getDuplicateReview,
  LoginResponseDto,
  updateAssets,
} from '@immich/sdk';
import { expect, test } from '@playwright/test';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    const viewer = page.locator('#immich-asset-viewer');
    await viewer.waitFor();

    // The review lives in Settings -> Utilities (UtilitiesManager.jsx), so the viewer opens over it
    // without an asset URL of its own; it names the item it shows.
    const getViewedAssetId = async () => (await viewer.getAttribute('data-asset-id')) ?? '';
    const initialAssetId = await getViewedAssetId();
    expect([firstAsset.id, secondAsset.id]).toContain(initialAssetId);

    await page.keyboard.press('ArrowRight');
    await expect.poll(getViewedAssetId).not.toBe(initialAssetId);

    await page.keyboard.press('ArrowLeft');
    await expect.poll(getViewedAssetId).toBe(initialAssetId);
  });

  test('keeps every copy with one key, without a confirmation, and undoes it after a reload', async ({ page }) => {
    const initialGroups = await reviewGroups();
    const before = initialGroups.length;
    await page.goto('/utilities/duplicates');
    const review = page.getByTestId('frameleaf-duplicate-review');
    await expect(review.getByRole('heading', { level: 2 })).toBeVisible();

    // A: keep all. No dialog; the decision runs as a durable job and the group leaves the review.
    await page.keyboard.press('a');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const groups = await reviewGroups();
          return groups.length;
        },
        { timeout: 30_000 },
      )
      .toBe(before - 1);

    // the undo survives a reload: the server keeps the decision history
    await page.reload();
    const undo = page.getByRole('button', { name: /^Undo/ }).first();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect
      .poll(
        async () => {
          const groups = await reviewGroups();
          return groups.length;
        },
        { timeout: 30_000 },
      )
      .toBe(before);
  });

  test('keeps two copies from a contact sheet with keyboard shortcuts', async ({ page }) => {
    const initialGroups = await reviewGroups();
    const duplicateId = initialGroups.find((group) =>
      group.assets.some((asset) => asset.id === firstAsset.id),
    )?.duplicateId;
    if (!duplicateId) {
      throw new Error('New duplicate group was not found');
    }
    const thirdAsset = await utils.createAsset(admin.accessToken, {});
    await updateAssets(
      { assetBulkUpdateDto: { ids: [thirdAsset.id], duplicateId } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    const updatedGroups = await reviewGroups();
    const group = updatedGroups.find((group) => group.duplicateId === duplicateId);
    if (!group || group.assets.length !== 3) {
      throw new Error('Expected a three-copy duplicate group');
    }
    const keepAssetIds = group.assets.slice(0, 2).map((asset) => asset.id);

    await page.goto('/utilities/duplicates');
    const review = page.getByTestId('frameleaf-duplicate-review');
    await review.locator('input[type="search"]').fill(duplicateId);
    await review.getByRole('heading', { level: 2 }).focus();
    await page.keyboard.press('1');
    await page.keyboard.press('2');

    const sheet = review.getByRole('group', { name: 'Group contact sheet' });
    await expect(sheet.getByRole('checkbox', { name: 'Keep frame 1' })).toBeChecked();
    await expect(sheet.getByRole('checkbox', { name: 'Keep frame 2' })).toBeChecked();
    await expect(sheet.getByRole('checkbox', { name: 'Keep frame 3' })).not.toBeChecked();
    await page.keyboard.press('e');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect
      .poll(
        async () => {
          const history = await getDuplicateDecisions({ headers: asBearerAuth(admin.accessToken) });
          const decision = history.recent
            .flatMap((batch) => batch.groups)
            .find((group) => group.duplicateId === duplicateId);
          return decision?.applied
            ? { kind: decision.decision, keepAssetIds: decision.keepAssetIds.toSorted((a, b) => a.localeCompare(b)) }
            : null;
        },
        { timeout: 30_000 },
      )
      .toEqual({
        kind: DuplicateDecisionKind.Keepers,
        keepAssetIds: keepAssetIds.toSorted((a, b) => a.localeCompare(b)),
      });

    await page.reload();
    const undo = review.getByRole('button', { name: /^Undo/ }).first();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect
      .poll(
        async () => {
          const groups = await reviewGroups();
          return groups
            .find((candidate) => candidate.duplicateId === duplicateId)
            ?.assets.map((asset) => asset.id)
            .toSorted((a, b) => a.localeCompare(b));
        },
        { timeout: 30_000 },
      )
      .toEqual(group.assets.map((asset) => asset.id).toSorted((a, b) => a.localeCompare(b)));
  });

  test('plays two real duplicate videos side by side while keeping keyboard focus', async ({ page }) => {
    test.setTimeout(120_000);
    const [kayak, forest] = await Promise.all([
      utils.createAsset(admin.accessToken, {
        assetData: {
          filename: 'duplicate-kayak.mp4',
          bytes: await readFile(
            new URL('../../../../design/frameleaf/template/public/media/kayak-demo.mp4', import.meta.url),
          ),
        },
      }),
      utils.createAsset(admin.accessToken, {
        assetData: {
          filename: 'duplicate-forest.mp4',
          bytes: await readFile(
            new URL('../../../../design/frameleaf/template/public/media/forest-demo.mp4', import.meta.url),
          ),
        },
      }),
    ]);
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction', 60_000);
    const duplicateId = crypto.randomUUID();
    await updateAssets(
      { assetBulkUpdateDto: { ids: [kayak.id, forest.id], duplicateId } },
      { headers: asBearerAuth(admin.accessToken) },
    );
    const group = (await reviewGroups()).find((candidate) => candidate.duplicateId === duplicateId);
    expect(group?.assets.map((asset) => [asset.id, asset.type]).toSorted()).toEqual(
      [
        [kayak.id, AssetTypeEnum.Video],
        [forest.id, AssetTypeEnum.Video],
      ].toSorted(),
    );

    await page.goto('/utilities/duplicates');
    const review = page.getByTestId('frameleaf-duplicate-review');
    await review.locator('input[type="search"]').fill(duplicateId);
    const videos = review.getByTestId('frameleaf-duplicate-compare').locator('video');
    await expect(videos).toHaveCount(2);
    await expect
      .poll(
        () => videos.evaluateAll((elements) => elements.every((element) => (element as HTMLVideoElement).readyState >= 1)),
        { timeout: 15_000 },
      )
      .toBe(true);

    const playTogether = review.getByRole('button', { name: 'Play together' });
    await playTogether.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        videos.evaluateAll((elements) =>
          elements.every((element) => {
            const video = element as HTMLVideoElement;
            return !video.paused && video.currentTime > 0.25;
          }),
        ),
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(playTogether).toBeFocused();
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
