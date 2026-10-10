import {
  DocumentField,
  DocumentFieldStatus,
  DocumentResponseDto,
  LoginResponseDto,
  deleteSession,
  getConfig,
  getDocument,
  getSessions,
  lockAssets,
  lockAuthSession,
  login,
  searchDocuments,
  setUserOnboarding,
  setupPinCode,
  unlockAuthSession,
  updateConfig,
} from '@frameleaf/sdk';
import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { app, asBearerAuth, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';

/**
 * FL-144 / FL-63: real browser, upload, auth, search and correction endpoints. Only OCR output is
 * seeded: this deterministic image/region is evidence of the document journey, not OCR quality.
 * No network responses, renderer or authorization decisions are replaced.
 */
test.describe('Document search and evidence journey (FL-63)', () => {
  let admin: LoginResponseDto;
  const pinCode = '246810';

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    const headers = asBearerAuth(admin.accessToken);
    const config = await getConfig({ headers });
    await updateConfig(
      {
        adminConfigDto: {
          ...config,
          machineLearning: {
            ...config.machineLearning,
            ocr: { ...config.machineLearning.ocr, documentFields: true },
          },
        },
      },
      { headers },
    );
  });

  test.afterAll(async () => {
    await utils.resetAdminConfig(admin.accessToken);
  });

  test('searches, locates and corrects a field, preserves provenance after reload, and clears open evidence on relock/revoke', async ({
    context,
    page,
    request,
    assetReady,
  }, testInfo) => {
    test.setTimeout(120_000);
    const suffix = randomUUID().slice(0, 8);
    const user = await utils.userSetup(admin.accessToken, {
      email: `document-${suffix}@example.com`,
      name: `Document ${suffix}`,
      password: 'password',
    });
    const headers = asBearerAuth(user.accessToken);
    await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers });

    // A real uploaded raster, with a colored strip independently matching the seeded OCR region.
    const image = new PNG({ width: 800, height: 600 });
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const offset = (y * image.width + x) * 4;
        const strip = x >= 120 && x < 640 && y >= 120 && y < 192;
        image.data.set(strip ? [14, 165, 160, 255] : [245, 245, 245, 255], offset);
      }
    }
    const asset = await utils.createAsset(user.accessToken, {
      assetData: { filename: `document-region-${suffix}.png`, bytes: PNG.sync.write(image) },
    });
    // Upload acknowledgement precedes metadata and preview publication. Wait while the owner can
    // still read the asset, before locking it and seeding deterministic OCR evidence.
    await utils.waitForAssetReady(admin.accessToken, asset.id, { headers, signal: assetReady.signal });
    await lockAssets({ bulkIdsDto: { ids: [asset.id] } }, { headers });
    await setupPinCode({ pinCodeSetupDto: { pinCode } }, { headers });
    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    const db = await utils.connectDatabase();
    await db.query(
      `INSERT INTO asset_ocr ("assetId", x1, y1, x2, y2, x3, y3, x4, y4, "boxScore", "textScore", text)
       VALUES ($1, 0.15, 0.2, 0.8, 0.2, 0.8, 0.32, 0.15, 0.32, 0.9, 0.96, $2)`,
      [asset.id, 'Grand total $18.50'],
    );
    await db.query(
      `INSERT INTO ocr_search ("assetId", text) VALUES ($1, $2)
       ON CONFLICT ("assetId") DO UPDATE SET text = EXCLUDED.text`,
      [asset.id, 'grand total 18.50'],
    );

    // A real foreign account cannot read either document text or the private image.
    const foreign = await utils.userSetup(admin.accessToken, {
      email: `document-foreign-${suffix}@example.com`,
      name: 'Foreign document viewer',
      password: 'password',
    });
    const foreignHeaders = asBearerAuth(foreign.accessToken);
    const foreignDocument = await request.get(`${app}/documents/${asset.id}`, { headers: foreignHeaders });
    const foreignImage = await request.get(`${app}/assets/${asset.id}/original`, { headers: foreignHeaders });
    const foreignSearch = await searchDocuments({ query: 'grand' }, { headers: foreignHeaders });
    expect(foreignDocument.status()).toBe(400);
    // File transfers deliberately mask inaccessible resources as404 (utils/file.ts).
    expect(foreignImage.status()).toBe(404);
    expect(foreignSearch.items).toEqual([]);

    await utils.setAuthCookies(context, user.accessToken);
    await page.goto('/documents');
    const search = page.getByRole('searchbox', { name: 'Search text in your photos' });
    await search.fill('grand');
    await expect(page).toHaveURL(/query=grand/);
    const tile = page.locator(`[data-asset-id="${asset.id}"]`);
    await expect(tile).toBeVisible();
    await tile.click();
    await page.getByRole('button', { name: 'Information', exact: true }).click();
    const text = page.getByTestId('frameleaf-document-text');
    await expect(text.getByTestId('frameleaf-document-text-body')).toContainText('Grand total $18.50');
    const fields = page.getByTestId('frameleaf-document-fields');
    await expect(fields).toContainText('Read from the text and not verified');
    const total = fields.locator('li').filter({ hasText: 'Total' });
    await expect(total).toContainText('$18.50');
    const before = await getDocument({ id: asset.id }, { headers });
    const suggested = before.fields.find((field) => field.field === DocumentField.Total)!;
    expect(suggested.status).toBe(DocumentFieldStatus.Suggested);
    expect(suggested.editId).toBeNull();
    expect(suggested.region).toMatchObject({ x1: 0.15, y1: 0.2, x3: 0.8, y3: 0.32 });

    await total.getByRole('button', { name: 'Show where' }).click();
    const highlight = page.getByTestId('document-region-highlight');
    await expect(highlight).toBeVisible();
    // Inspect actual SVG geometry, independent of the application's geometry helper.
    const geometry = await highlight.evaluate((svg) => {
      const width = Number(svg.getAttribute('width'));
      const height = Number(svg.getAttribute('height'));
      const points = svg
        .querySelector('polygon')!
        .getAttribute('points')!
        .trim()
        .split(/\s+/)
        .map((point) => {
          const [x, y] = point.split(',').map(Number);
          return [x / width, y / height];
        });
      return { width, height, points };
    });
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.height).toBeGreaterThan(0);
    for (const [index, point] of [
      [0.15, 0.2],
      [0.8, 0.2],
      [0.8, 0.32],
      [0.15, 0.32],
    ].entries()) {
      expect(geometry.points[index][0]).toBeCloseTo(point[0], 5);
      expect(geometry.points[index][1]).toBeCloseTo(point[1], 5);
    }
    const renderedImage = page.locator('[data-viewer-hero] img').first();
    await expect(renderedImage).toBeVisible();
    await expect
      .poll(() => renderedImage.evaluate((element: HTMLImageElement) => element.naturalWidth / element.naturalHeight))
      .toBeCloseTo(800 / 600, 2);
    await testInfo.attach('seeded-region-render', { body: await page.screenshot(), contentType: 'image/png' });

    await total.getByRole('button', { name: 'Correct' }).click();
    await total.getByRole('textbox', { name: 'Total value' }).fill('$19.25');
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/documents/${asset.id}/fields/total`) && response.request().method() === 'PUT',
    );
    await total.getByRole('button', { name: 'Save' }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({
      action: 'correct',
      value: '$19.25',
      revision: suggested.revision,
    });
    const persisted: DocumentResponseDto = await response.json();
    const correction = persisted.fields.find((field) => field.field === DocumentField.Total)!;
    expect(correction).toMatchObject({
      status: DocumentFieldStatus.Corrected,
      value: '$19.25',
      lineId: suggested.lineId,
    });
    expect(correction.editId).toBeTruthy();
    expect(correction.revision).not.toBeNull();
    expect(correction.updatedAt).toBeTruthy();
    expect(persisted.lines[0].recognizedText).toBe('Grand total $18.50');
    await expect(total).toContainText('$19.25');
    await page.reload();
    await expect(page.locator('#detail-panel')).toBeVisible();
    await expect(total).toContainText('$19.25');
    const reloaded = await getDocument({ id: asset.id }, { headers });
    expect(reloaded.fields).toEqual(persisted.fields);
    const recognized = await db.query('SELECT text FROM asset_ocr WHERE "assetId" = $1', [asset.id]);
    expect(recognized.rows).toEqual([{ text: 'Grand total $18.50' }]);

    // Search again through the UI, using only the newly persisted correction.
    await page.goto('/documents');
    await search.fill('19.25');
    await expect(page).toHaveURL(/query=19.25/);
    await expect(tile).toBeVisible();
    await tile.click();
    await expect(total).toContainText('$19.25');
    await total.getByRole('button', { name: 'Show where' }).click();
    await expect(highlight).toBeVisible();
    await lockAuthSession({ headers });
    await expect(page).toHaveURL(/\/photos\/?$/);
    await expect(text).toHaveCount(0);
    await expect(highlight).toHaveCount(0);
    await expect(page.getByText('$19.25')).toHaveCount(0);
    await expect(page.locator(`img[src*="${asset.id}"], a[href*="${asset.id}"]`)).toHaveCount(0);
    const lockedDocument = await request.get(`${app}/documents/${asset.id}`, { headers });
    const lockedImage = await request.get(`${app}/assets/${asset.id}/original`, { headers });
    const lockedSearch = await searchDocuments({ query: '19.25' }, { headers });
    expect(lockedDocument.status()).toBe(400);
    expect(lockedImage.status()).toBe(404);
    expect(lockedSearch.items).toEqual([]);

    await unlockAuthSession({ sessionUnlockDto: { pinCode } }, { headers });
    await page.goto('/documents?query=19.25');
    await tile.click();
    await expect(total).toContainText('$19.25');
    await total.getByRole('button', { name: 'Show where' }).click();
    await expect(highlight).toBeVisible();
    const other = await login({ loginCredentialDto: { email: user.userEmail, password: 'password' } });
    const sessions = await getSessions({ headers });
    const current = sessions.find((session) => session.current)!;
    expect(current).toBeDefined();
    await deleteSession({ id: current.id }, { headers: asBearerAuth(other.accessToken) });
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(text).toHaveCount(0);
    await expect(highlight).toHaveCount(0);
    await expect(page.getByText('$19.25')).toHaveCount(0);
    await expect(page.locator(`img[src*="${asset.id}"], a[href*="${asset.id}"]`)).toHaveCount(0);
    const revokedDocument = await request.get(`${app}/documents/${asset.id}`, { headers });
    expect(revokedDocument.status()).toBe(401);
  });
});
