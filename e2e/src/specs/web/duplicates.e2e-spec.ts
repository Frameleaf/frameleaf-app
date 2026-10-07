import {
  AdminConfigDto,
  AssetMediaResponseDto,
  AssetTypeEnum,
  DuplicateDecisionKind,
  getDuplicateDecisions,
  getDuplicateReview,
  LoginResponseDto,
  updateAssets,
  updateConfig,
  VideoCodec,
} from '@frameleaf/sdk';
import { expect, Page } from '@playwright/test';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { app, asBearerAuth, baseUrl, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';

const byId = (a: string[], b: string[]) => a[0].localeCompare(b[0]);

/**
 * FL-144: Playwright's Linux arm64 Chromium has no H.264 decoder (the server's default transcode
 * target), so a plain H.264 upload never plays there even though it plays fine on amd64/macOS.
 * The server negotiates no per-client codec (`playbackVideo()` just serves whatever file already
 * exists), so scope a VP9 target/accepted-codec override to this one test only, restore the
 * previous config afterwards (the web project runs workers:1, so this is safe), and assert the
 * served file is genuinely the VP9 transcode rather than trusting playback success alone.
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

/** Fetches the bytes the browser would actually be served and confirms they carry the VP9 sample
 *  entry (`vp09`), not an H.264 one (`avc1`/`avc3`) — proof the transcode config took effect,
 *  independent of whether this host's own browser can decode it. */
const expectVp9Playback = async (page: Page, assetId: string) => {
  const cookies = await page.context().cookies(baseUrl);
  const response = await page.request.get(`${app}/assets/${assetId}/video/playback`, {
    headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  expect(response.ok()).toBe(true);
  const body = await response.body();
  expect(body.includes(Buffer.from('vp09'))).toBe(true);
  expect(body.includes(Buffer.from('avc1'))).toBe(false);
  expect(body.includes(Buffer.from('avc3'))).toBe(false);
};

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

  test('plays two real duplicate videos side by side while keeping keyboard focus', async ({ page, assetReady }) => {
    test.setTimeout(300_000);
    await withVp9TranscodeTarget(admin.accessToken, async () => {
      const [kayak, forest] = await Promise.all([
        utils.createAsset(admin.accessToken, {
          assetData: {
            filename: 'duplicate-kayak.mp4',
            bytes: await readFile(new URL('../../fixtures/frameleaf-media/kayak-demo.mp4', import.meta.url)),
          },
        }),
        utils.createAsset(admin.accessToken, {
          assetData: {
            filename: 'duplicate-forest.mp4',
            bytes: await readFile(new URL('../../fixtures/frameleaf-media/forest-demo.mp4', import.meta.url)),
          },
        }),
      ]);
      // Both clips share the existing 200s conversion budget and the enclosing test's cancellation.
      const signal = AbortSignal.any([assetReady.signal, AbortSignal.timeout(200_000)]);
      assetReady.onCleanup(() => utils.settlePendingWaits(signal));
      await utils.waitForAssetReady(admin.accessToken, kayak.id, { video: true, timeout: 200_000, signal });
      await utils.waitForAssetReady(admin.accessToken, forest.id, { video: true, timeout: 200_000, signal });
      await expectVp9Playback(page, kayak.id);
      await expectVp9Playback(page, forest.id);

      const duplicateId = crypto.randomUUID();
      await updateAssets(
        { assetBulkUpdateDto: { ids: [kayak.id, forest.id], duplicateId } },
        { headers: asBearerAuth(admin.accessToken) },
      );
      const groups = await reviewGroups();
      const group = groups.find((candidate) => candidate.duplicateId === duplicateId);
      expect(group?.assets.map((asset) => [asset.id, asset.type]).toSorted(byId)).toEqual(
        [
          [kayak.id, AssetTypeEnum.Video],
          [forest.id, AssetTypeEnum.Video],
        ].toSorted(byId),
      );

      await page.goto('/utilities/duplicates');
      const review = page.getByTestId('frameleaf-duplicate-review');
      await review.locator('input[type="search"]').fill(duplicateId);
      const videos = review.getByTestId('frameleaf-duplicate-compare').locator('video');
      await expect(videos).toHaveCount(2);
      await expect
        .poll(
          () =>
            videos.evaluateAll((elements) =>
              elements.every((element) => (element as HTMLVideoElement).readyState >= 1),
            ),
          { timeout: 15_000 },
        )
        .toBe(true);

      // Accessible name is the button's actual copy (frameleaf_duplicates_play_together in i18n),
      // not the paraphrase this spec previously used — the mismatch made the locator never resolve.
      const playTogether = review.getByRole('button', { name: 'Play both from the start' });
      await playTogether.focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(
          () =>
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
  });

  test('keeps keyboard focus through a virtualized queue and decides the offscreen group', async ({ page }) => {
    test.setTimeout(180_000);
    const seededIds = new Set<string>();
    for (let start = 0; start < 24; start += 4) {
      const ids = await Promise.all(
        Array.from({ length: 4 }, async (_, offset) => {
          const index = start + offset;
          const [first, second] = await Promise.all([
            utils.createAsset(admin.accessToken, { assetData: { filename: `queue-${index}-first.png` } }),
            utils.createAsset(admin.accessToken, { assetData: { filename: `queue-${index}-second.png` } }),
          ]);
          const duplicateId = crypto.randomUUID();
          await updateAssets(
            { assetBulkUpdateDto: { ids: [first.id, second.id], duplicateId } },
            { headers: asBearerAuth(admin.accessToken) },
          );
          return duplicateId;
        }),
      );
      for (const id of ids) {
        seededIds.add(id);
      }
    }

    const groups = await reviewGroups();
    const seededGroups = groups.filter((group) => seededIds.has(group.duplicateId));
    expect(seededGroups).toHaveLength(24);
    const groupByTitle = new Map(
      seededGroups.flatMap((group) =>
        group.assets.map((asset) => [asset.originalFileName.replace(/\.[^.]+$/, ''), group] as const),
      ),
    );

    await page.goto('/utilities/duplicates');
    const review = page.getByTestId('frameleaf-duplicate-review');
    const heading = review.getByRole('heading', { level: 2 });
    const queue = review.locator('.fl-dr-queue-scroll');
    await expect(heading).toBeVisible();
    const renderedRowCount = await queue.locator('.fl-dr-queue-row').count();
    const renderedTitles = await queue.locator('.fl-dr-queue-row strong').allTextContents();
    const initiallyRendered = new Set(renderedTitles.map((title) => title.trim()));
    expect(renderedRowCount).toBeGreaterThan(0);
    expect(renderedRowCount).toBeLessThan(groups.length);

    await heading.focus();
    let target: (typeof seededGroups)[number] | undefined;
    let targetTitle = '';
    for (let step = 0; step < groups.length; step++) {
      await page.keyboard.press('ArrowRight');
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      const headingText = await heading.textContent();
      targetTitle = headingText?.trim() ?? '';
      const candidate = groupByTitle.get(targetTitle);
      if (candidate && !initiallyRendered.has(targetTitle)) {
        target = candidate;
        break;
      }
    }
    if (!target) {
      throw new Error('Keyboard navigation did not reach a seeded group outside the initial virtual window');
    }
    const decidedGroup = target;
    expect(decidedGroup.editable).toBe(true);
    await expect(heading).toBeFocused();
    await expect(queue.locator('.fl-dr-queue-row button[aria-current="true"]')).toContainText(targetTitle);

    await page.keyboard.press('a');
    await expect(heading).not.toHaveText(targetTitle);
    await expect(heading).toBeFocused();
    await expect
      .poll(
        async () => {
          const history = await getDuplicateDecisions({ headers: asBearerAuth(admin.accessToken) });
          const decision = history.recent
            .flatMap((batch) => batch.groups)
            .find((group) => group.duplicateId === decidedGroup.duplicateId);
          return decision?.applied
            ? {
                kind: decision.decision,
                memberIds: decision.memberIds.toSorted((a, b) => a.localeCompare(b)),
              }
            : null;
        },
        { timeout: 30_000 },
      )
      .toEqual({
        kind: DuplicateDecisionKind.KeepAll,
        memberIds: decidedGroup.assets.map((asset) => asset.id).toSorted((a, b) => a.localeCompare(b)),
      });
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
