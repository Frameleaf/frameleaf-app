import {
  AdminConfigDto,
  AssetVisibility,
  getAssetInfo,
  getLivePhotoCandidates,
  updateConfig,
  VideoCodec,
} from '@frameleaf/sdk';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { app, asBearerAuth, baseUrl, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';

/**
 * FL-144: Playwright's Linux arm64 Chromium has no H.264 decoder (the server's default transcode
 * target), so a plain H.264 upload never plays there even though it plays fine on amd64/macOS.
 * The server negotiates no per-client codec (`playbackVideo()` just serves whatever file already
 * exists), so scope a VP9 target/accepted-codec override to this one test, restore the previous
 * config afterwards, and assert the served file is genuinely the VP9 transcode rather than
 * trusting playback success alone.
 */
const withVp9TranscodeTarget = async (accessToken: string, run: () => Promise<void>) => {
  const previous = await utils.getSystemConfig(accessToken);
  const next: AdminConfigDto = {
    ...previous,
    ffmpeg: { ...previous.ffmpeg, targetVideoCodec: VideoCodec.Vp9, acceptedVideoCodecs: [VideoCodec.Vp9] },
  };
  await updateConfig({ adminConfigDto: next }, { headers: asBearerAuth(accessToken) });
  const applied = await utils.getSystemConfig(accessToken);
  expect(applied.ffmpeg.targetVideoCodec).toBe(VideoCodec.Vp9);
  try {
    await run();
  } finally {
    await updateConfig({ adminConfigDto: previous }, { headers: asBearerAuth(accessToken) });
  }
};

test('reviews a separated Live Photo, confirms its link and plays motion after reload (FL-70)', async ({
  context,
  page,
  assetReady,
}) => {
  test.setTimeout(270_000);
  utils.initSdk();
  await utils.resetDatabase();
  const admin = await utils.adminSetup();
  const headers = asBearerAuth(admin.accessToken);
  await withVp9TranscodeTarget(admin.accessToken, async () => {
    const photo = await utils.createAsset(admin.accessToken, { assetData: { filename: 'separated-still.png' } });
    const video = await utils.createAsset(admin.accessToken, {
      assetData: {
        filename: 'separated-motion.mp4',
        bytes: await readFile(new URL('../../fixtures/frameleaf-media/kayak-demo.mp4', import.meta.url)),
      },
    });
    await utils.waitForAssetReady(admin.accessToken, photo.id, { signal: assetReady.signal });
    // Preserve the VP9 budget while including the storage-template and thumbnail prerequisites.
    await utils.waitForAssetReady(admin.accessToken, video.id, {
      video: true,
      timeout: 180_000,
      signal: assetReady.signal,
    });
    await utils.setAuthCookies(context, admin.accessToken);
    const cookies = await page.context().cookies(baseUrl);
    const playbackResponse = await page.request.get(`${app}/assets/${video.id}/video/playback`, {
      headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    });
    expect(playbackResponse.ok()).toBe(true);
    const playbackBody = await playbackResponse.body();
    expect(playbackBody.includes(Buffer.from('vp09'))).toBe(true);
    expect(playbackBody.includes(Buffer.from('avc1'))).toBe(false);
    expect(playbackBody.includes(Buffer.from('avc3'))).toBe(false);

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
});
