import { AssetMediaResponseDto, LoginResponseDto, updateAsset, updatePerson } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * T-12 (ExploreLibrary.jsx:60-274): Explore's cards carry counts taken in the same scope as the
 * search they open, "Things in your photos" lists the account's tags, and "Recent captures" names
 * each item and its capture day. Hidden people and archived items never appear.
 */
test.describe('Explore', () => {
  let admin: LoginResponseDto;
  let first: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    first = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'sunset.png' },
      fileCreatedAt: '2026-08-02T18:00:00.000Z',
    });
    const second = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'harbour.png' },
      fileCreatedAt: '2026-08-01T09:00:00.000Z',
    });
    // Archived: tagged too, but outside the Timeline scope the search opens, so never counted.
    const archived = await utils.createAsset(admin.accessToken, {
      assetData: { filename: 'archived.png' },
      fileCreatedAt: '2026-08-03T09:00:00.000Z',
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    await utils.archiveAssets(admin.accessToken, [archived.id]);

    const [beach] = await utils.upsertTags(admin.accessToken, ['beach']);
    await utils.tagAssets(admin.accessToken, beach.id, [first.id, second.id, archived.id]);

    const jamie = await utils.createPerson(admin.accessToken, { name: 'Jamie' });
    await utils.createFace({ assetId: first.id, personGroupId: jamie.id });
    const hidden = await utils.createPerson(admin.accessToken, { name: 'Hidden Person' });
    await utils.createFace({ assetId: second.id, personGroupId: hidden.id });
    await updatePerson(
      { id: hidden.id, personUpdateDto: { isHidden: true } },
      { headers: asBearerAuth(admin.accessToken) },
    );
  });

  test('counts people and things, and opens the search each count came from', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/explore');

    const people = page.getByRole('region', { name: 'People' });
    await expect(people.getByRole('link', { name: /Jamie/ })).toContainText('1 item');
    await expect(people.getByText('Hidden Person')).toHaveCount(0);

    const things = page.getByRole('region', { name: 'Things in your photos' });
    const beach = things.getByRole('link', { name: /beach/ });
    await expect(beach).toContainText('2 items');

    await beach.click();
    await page.waitForURL(/\/search\?query=.*tagIds/);
    // B1: the archived tagged item is neither counted nor found, so the count is the result count
    await expect(page.locator('[data-asset-id]')).toHaveCount(2);
  });

  test('lists recent captures newest first with their name and capture day', async ({ context, page }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/explore');

    const recent = page.getByRole('region', { name: 'Recent captures' }).getByRole('button');
    await expect(recent.first()).toHaveAccessibleName('Open sunset.png');
    await expect(recent.first()).toContainText('2026-08-02');
    await expect(recent.nth(1)).toHaveAccessibleName('Open harbour.png');
  });

  test('Explore to a filtered result, the viewer and back keeps the place on the page (FL-50)', async ({
    context,
    page,
  }) => {
    await utils.setAuthCookies(context, admin.accessToken);
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.goto('/explore');

    const things = page.getByRole('region', { name: 'Things in your photos' });
    await things.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate(() => {
      const scroller = document.querySelector('main') ?? document.scrollingElement;
      return scroller?.scrollTop ?? 0;
    });

    await things.getByRole('link', { name: /beach/ }).click();
    await page.waitForURL(/\/search\?query=.*tagIds/);
    await page.locator('[data-asset-id]').first().click();
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(page.locator('[data-asset-id]')).toHaveCount(2);

    await page.goBack();
    await page.waitForURL(/\/explore/);
    await expect(things).toBeVisible();
    const restored = await page.evaluate(() => {
      const scroller = document.querySelector('main') ?? document.scrollingElement;
      return scroller?.scrollTop ?? 0;
    });
    expect(Math.abs(restored - scrolled)).toBeLessThan(80);
  });

  test('Best Photos without quality scores says so instead of ranking by stars (FL-50)', async ({ context, page }) => {
    // Uploads are scored locally in the background (BestPhotosScore follows thumbnail generation and
    // face detection), so this library already has scores. Give one item five stars, let every job
    // that could score it finish, then clear the scores: a rated library with nothing scored.
    await updateAsset({ id: first.id, updateAssetDto: { rating: 5 } }, { headers: asBearerAuth(admin.accessToken) });
    for (const queue of [
      'sidecar',
      'metadataExtraction',
      'thumbnailGeneration',
      'faceDetection',
      'backgroundTask',
    ] as const) {
      await utils.waitForQueueFinish(admin.accessToken, queue);
    }
    const client = await utils.connectDatabase();
    await client.query(`DO $$
      BEGIN
        IF to_regclass('public.asset_best_photo_score') IS NOT NULL THEN
          DELETE FROM public.asset_best_photo_score;
        END IF;
        IF to_regclass('immich_fork.asset_best_photo_score') IS NOT NULL THEN
          DELETE FROM immich_fork.asset_best_photo_score;
        END IF;
      END $$;`);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/best-photos');
    await expect(page.getByText('No best photos have been scored yet.')).toBeVisible();
    await expect(page.locator('[data-asset-id]')).toHaveCount(0);
  });
});
