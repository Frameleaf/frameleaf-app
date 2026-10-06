import {
  AssetVisibility,
  ClassificationMediaType,
  ClassificationRuleAction,
  MediaOperationStatus,
  createClassificationRule,
  getAlbumInfo,
  getAssetInfo,
  getClassificationRules,
  getMediaOperation,
  pauseMediaOperation,
  type ClassificationPlanResponseDto,
  type LoginResponseDto,
} from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

test.describe('Smart album rules (FL-144)', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('previews without writing and requires archive consent before creating', async ({ context, page }) => {
    const asset = await utils.createAsset(admin.accessToken);
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const visibility = async () => {
      const current = await getAssetInfo({ id: asset.id }, auth);
      return current.visibility;
    };
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/albums');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Smart album' }).click();

    const dialog = page.getByRole('dialog', { name: 'New album' });
    await dialog.getByLabel('Name').fill('Archive candidate');
    const previewResponse = page.waitForResponse(
      (response) => response.url().endsWith('/api/classification/preview') && response.ok(),
    );
    await dialog.getByLabel('Media').selectOption(ClassificationMediaType.Photo);
    const previewHttp = await previewResponse;
    const preview = await previewHttp.json();
    expect(preview).toMatchObject({ exact: true, matched: 1 });
    await expect(dialog.getByRole('status')).toHaveText('1 item matches right now.');
    expect(await getClassificationRules({}, auth)).toEqual([]);
    expect(await visibility()).toBe(AssetVisibility.Timeline);

    await dialog.getByLabel('When something matches').selectOption(ClassificationRuleAction.Tag);
    await dialog.getByLabel('Tag to add').fill('Archive candidate');
    await dialog.getByRole('switch', { name: /Archive matches/ }).check();
    await expect(
      dialog.getByRole('checkbox', { name: /I agree that matching items are archived automatically/ }),
    ).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog.getByText('Confirm that matches may be archived, or turn archiving off.')).toBeVisible();
    expect(await getClassificationRules({}, auth)).toEqual([]);

    await dialog.getByRole('checkbox', { name: /I agree that matching items are archived automatically/ }).check();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await page.waitForURL(/\/albums\/[\da-f-]{36}/);
    const [rule] = await getClassificationRules({}, auth);
    expect(rule).toMatchObject({ archive: true, action: ClassificationRuleAction.Tag });
    expect(rule.archiveConsentAt).not.toBeNull();
    expect(await visibility()).toBe(AssetVisibility.Timeline);
    const emptyAlbum = await getAlbumInfo({ id: rule.albumId }, auth);
    expect(emptyAlbum.assetCount).toBe(0);

    await page.getByRole('button', { name: 'Re-evaluate', exact: true }).click();
    const planDialog = page.getByRole('dialog', { name: 'Re-evaluate smart album' });
    await expect(planDialog.getByText('1 item', { exact: true })).toBeVisible();
    expect(await visibility()).toBe(AssetVisibility.Timeline);
    await planDialog.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(visibility).toBe(AssetVisibility.Archive);
    const filledAlbum = await getAlbumInfo({ id: rule.albumId }, auth);
    expect(filledAlbum.assetCount).toBe(1);
  });

  test('resumes a durable apply after leaving the album', async ({ context, page }) => {
    test.setTimeout(180_000);
    const asset = await utils.createAsset(admin.accessToken);
    const db = await utils.connectDatabase();
    // More than the 500 item inline limit. The real server plans and applies these DB fixture assets.
    await db.query(
      `INSERT INTO asset ("id", "ownerId", "type", "originalPath", "fileCreatedAt", "fileModifiedAt",
        "checksum", "checksumAlgorithm", "originalFileName", "localDateTime")
       SELECT gen_random_uuid(), "ownerId", "type", "originalPath" || '-fl144-' || n,
         "fileCreatedAt", "fileModifiedAt", decode(md5('fl144-' || n) || md5(n || '-fl144'), 'hex'),
         "checksumAlgorithm", 'fl144-' || n || '.png', "localDateTime"
       FROM asset CROSS JOIN generate_series(1, 1200) AS n WHERE id = $1`,
      [asset.id],
    );
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const rule = await createClassificationRule(
      {
        classificationRuleCreateDto: {
          albumName: 'Durable smart album',
          mediaType: ClassificationMediaType.Photo,
          action: ClassificationRuleAction.Tag,
          tagName: 'Durable smart album',
        },
      },
      auth,
    );
    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/albums/${rule.albumId}`);
    const planned = page.waitForResponse(
      (response) => response.url().endsWith(`/api/classification/rules/${rule.id}/plan`) && response.ok(),
    );
    await page.getByRole('button', { name: 'Re-evaluate', exact: true }).click();
    const plannedHttp = await planned;
    const plan = (await plannedHttp.json()) as ClassificationPlanResponseDto;
    expect(plan.durable).toBe(true);
    expect(plan.matched).toBeGreaterThan(500);
    expect(plan.added).toBe(plan.matched);
    const dialog = page.getByRole('dialog', { name: 'Re-evaluate smart album' });
    await expect(
      dialog.getByText('Over 500 changes, so this runs as a background job you can follow in Activity.'),
    ).toBeVisible();
    // Hold an asset in batch two while batch one checkpoints. This keeps the worker in progress
    // until the pause request is recorded, independent of runner speed.
    const operation = await (async () => {
      await db.query('BEGIN');
      try {
        const locked = await db.query('SELECT id FROM asset WHERE id = $1 FOR UPDATE', [plan.assetIds[500]]);
        expect(locked.rowCount).toBe(1);
        const queued = page.waitForResponse(
          (response) => response.url().endsWith('/api/media-operations/bulk') && response.status() === 201,
        );
        await dialog.getByRole('button', { name: 'Apply' }).click();
        const queuedHttp = await queued;
        const currentOperation = await queuedHttp.json();
        expect(currentOperation.bulk?.action).toBe('apply-classification-rule');
        await expect
          .poll(
            async () => {
              const current = await getMediaOperation({ id: currentOperation.id }, auth);
              return Number(current.processedUnits);
            },
            { timeout: 30_000 },
          )
          .toBeGreaterThan(0);
        await pauseMediaOperation({ id: currentOperation.id }, auth);
        return currentOperation;
      } finally {
        await db.query('ROLLBACK');
      }
    })();
    const operationStatus = async () => {
      const current = await getMediaOperation({ id: operation.id }, auth);
      return current.status;
    };
    await expect.poll(operationStatus, { timeout: 30_000 }).toBe(MediaOperationStatus.Paused);
    const paused = await getMediaOperation({ id: operation.id }, auth);
    expect(Number(paused.processedUnits)).toBeLessThan(plan.assetIds.length);

    await page.goto('/activity');
    await page.reload();
    await page.getByRole('button', { name: 'Resume “Apply smart album rule”' }).click();
    await expect.poll(operationStatus, { timeout: 60_000 }).toBe(MediaOperationStatus.Completed);
    const album = await getAlbumInfo({ id: rule.albumId }, auth);
    expect(album.assetCount).toBe(plan.matched);
  });
});
