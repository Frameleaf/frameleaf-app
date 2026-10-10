import { getConfig, getMlWorkloadRoutes, updateConfig, type LoginResponseDto } from '@frameleaf/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

test.describe('Smart album visual threshold (FL-144)', () => {
  test.skip(process.env.FL144_ML_FIXTURE !== 'true', 'Needs the deterministic Compose ML fixture');

  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  test('changes real preview counts when the confidence threshold changes', async ({ context, page }) => {
    const auth = { headers: asBearerAuth(admin.accessToken) };
    const originalConfig = await getConfig(auth);
    // Resetting the database removes routes; the first config save restores the local defaults.
    await updateConfig({ adminConfigDto: originalConfig }, auth);
    const originalRoutes = await getMlWorkloadRoutes(auth);
    expect(originalConfig.machineLearning.urls).toEqual(['http://immich-machine-learning-fixture:3003']);
    expect(originalConfig.machineLearning.clip.modelName).toBe('ViT-B-16-SigLIP-384__webli');

    try {
      const low = await utils.createAsset(admin.accessToken);
      const high = await utils.createAsset(admin.accessToken);
      await updateConfig(
        {
          adminConfigDto: {
            ...originalConfig,
            machineLearning: {
              ...originalConfig.machineLearning,
              enabled: true,
            },
          },
        },
        auth,
      );

      const db = await utils.connectDatabase();
      await expect
        .poll(
          async () => {
            const { rows } = await db.query<{ dimension: number }>(`
              SELECT att.atttypmod AS dimension FROM pg_attribute att
              JOIN pg_class cls ON cls.oid = att.attrelid
              WHERE cls.relnamespace = 'public'::regnamespace
                AND cls.relname IN ('smart_search', 'asset_video_duplicate_frame')
                AND att.attname = 'embedding'
              ORDER BY cls.relname
            `);
            return rows.map(({ dimension }) => dimension);
          },
          { timeout: 60_000 },
        )
        .toEqual([768, 768]);
      const vector = (similarity: number) =>
        `[${[similarity, Math.sqrt(1 - similarity ** 2), ...Array.from({ length: 766 }, () => 0)].join(',')}]`;
      await db.query('INSERT INTO smart_search ("assetId", embedding) VALUES ($1, $2::vector), ($3, $4::vector)', [
        low.id,
        vector(0.3),
        high.id,
        vector(0.6),
      ]);

      await utils.setAuthCookies(context, admin.accessToken);
      await page.goto('/albums');
      await page.getByRole('button', { name: 'New', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Smart album' }).click();
      const dialog = page.getByRole('dialog', { name: 'New album' });
      const previewAt = (threshold: number) =>
        page.waitForResponse((response) => {
          if (!response.url().endsWith('/api/classification/preview') || !response.ok()) {
            return false;
          }
          const draft = response.request().postDataJSON();
          return draft.visualQueries?.includes('fl144-threshold-fixture') && draft.threshold === threshold;
        });

      await dialog.getByLabel('Looks like (optional)').fill('fl144-threshold-fixture');
      const lowThreshold = previewAt(0.25);
      await dialog.getByLabel('Looks like (optional)').press('Tab');
      const lowResponse = await lowThreshold;
      expect(await lowResponse.json()).toMatchObject({ exact: false, sampled: 2, matched: 2 });
      await expect(dialog.getByRole('status')).toHaveText('2 items of your newest 2 items match.');

      const highThreshold = previewAt(0.5);
      await dialog.getByRole('slider').press('End');
      const highResponse = await highThreshold;
      expect(await highResponse.json()).toMatchObject({ exact: false, sampled: 2, matched: 1 });
      await expect(dialog.getByRole('status')).toHaveText('1 item of your newest 2 items match.');
    } finally {
      await updateConfig({ adminConfigDto: originalConfig }, auth);
      expect(await getMlWorkloadRoutes(auth)).toEqual(originalRoutes);
    }
  });
});
