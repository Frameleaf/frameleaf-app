import { AssetVisibility, getAssetInfo, getLivePhotoCandidates } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { asBearerAuth, utils } from 'src/utils.js';

test('reviews a separated Live Photo, confirms its link and plays motion after reload (FL-70)', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  utils.initSdk();
  await utils.resetDatabase();
  const admin = await utils.adminSetup();
  const headers = asBearerAuth(admin.accessToken);
  const photo = await utils.createAsset(admin.accessToken, { assetData: { filename: 'separated-still.png' } });
  const video = await utils.createAsset(admin.accessToken, {
    assetData: {
      filename: 'separated-motion.mp4',
      bytes: await readFile(
        new URL('../../../../design/frameleaf/template/public/media/kayak-demo.mp4', import.meta.url),
      ),
    },
  });
  await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction', 60_000);

  // Model an already ingested pair whose link was lost, after ingestion has finished auto-linking.
  const db = await utils.connectDatabase();
  await db.query(`UPDATE asset_exif SET "livePhotoCID" = $1 WHERE "assetId" = ANY($2::uuid[])`, [
    randomUUID(),
    [photo.id, video.id],
  ]);
  const { candidates } = await getLivePhotoCandidates({ headers });
  expect(candidates).toEqual([
    expect.objectContaining({
      photo: expect.objectContaining({ id: photo.id }),
      video: expect.objectContaining({ id: video.id }),
      confidence: 'high',
    }),
  ]);

  await utils.setAuthCookies(context, admin.accessToken);
  await page.goto('/user-settings?area=utilities&section=live-photos');
  const pair = page.getByRole('article').filter({ hasText: 'separated-still.png' });
  await expect(pair).toContainText('High confidence');
  await pair.getByRole('button', { name: 'Inspect', exact: true }).click();
  const inspector = page.getByRole('dialog', { name: 'separated-still.png' });
  await expect(inspector.getByText('Matched on the embedded live photo identifier')).toBeVisible();
  await expect(inspector.locator('video')).toHaveAttribute('src', new RegExp(video.id));
  await inspector.getByRole('button', { name: 'Done', exact: true }).first().click();
  const inspected = await getAssetInfo({ id: photo.id }, { headers });
  expect(inspected.livePhotoVideoId).toBeNull();

  await pair.getByRole('button', { name: 'Review pair' }).click();
  const review = page.getByRole('dialog', { name: 'Review Live Photo pairs' });
  await expect(review).toContainText('separated-still.png');
  await expect(review).toContainText('separated-motion.mp4');
  await review.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  const cancelled = await getAssetInfo({ id: photo.id }, { headers });
  expect(cancelled.livePhotoVideoId).toBeNull();

  await pair.getByRole('button', { name: 'Review pair' }).click();
  await review.getByRole('button', { name: 'Confirm 1 pair', exact: true }).click();
  await expect
    .poll(async () => {
      const linked = await getAssetInfo({ id: photo.id }, { headers });
      return linked.livePhotoVideoId;
    })
    .toBe(video.id);
  await expect(pair).toHaveCount(0);
  const motionAsset = await getAssetInfo({ id: video.id }, { headers });
  expect(motionAsset.visibility).toBe(AssetVisibility.Hidden);

  await page.reload();
  await expect(page.getByText('No candidate pairs need review.')).toBeVisible();
  const remaining = await getLivePhotoCandidates({ headers });
  expect(remaining.candidates).toEqual([]);

  await page.goto(`/photos/${photo.id}`);
  const badge = page.getByTestId('viewer-live-badge');
  await expect(badge).toBeVisible();
  await page.reload();
  await badge.focus();
  await page.keyboard.press('Enter');
  await expect(badge).toHaveAttribute('aria-pressed', 'true');
  const motion = page.locator('#immich-asset-viewer video');
  await expect(motion).toBeVisible();
  await expect.poll(() => motion.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
});
