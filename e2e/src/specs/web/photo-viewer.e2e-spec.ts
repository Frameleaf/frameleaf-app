import { AssetMediaResponseDto, LoginResponseDto } from '@frameleaf/sdk';
import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { testAssetDir, utils } from 'src/utils.js';
import { test, withAssetReadySetup } from 'src/web-test.js';

test.describe('Photo Viewer', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;
  let rawAsset: AssetMediaResponseDto;
  let websocket: Socket;
  let originalDigest: string;

  test.beforeAll(
    withAssetReadySetup(async (signal) => {
      utils.initSdk();
      await utils.resetDatabase();
      admin = await utils.adminSetup();
      // This case exercises native original loading; unknown PNG encoding stays on the rendition route.
      const jpeg = await readFile(join(testAssetDir, 'formats/jpeg/el_torcal_rocks.jpeg'));
      originalDigest = createHash('sha256').update(jpeg).digest('hex');
      asset = await utils.createAsset(admin.accessToken, {
        assetData: {
          filename: 'el_torcal_rocks.jpeg',
          bytes: jpeg,
        },
      });
      // FL-281 renders RAW from the sensor, so this must be a real camera file, not a JPEG renamed to .arw.
      rawAsset = await utils.createAsset(admin.accessToken, {
        assetData: {
          filename: 'glarus.nef',
          bytes: await readFile(join(testAssetDir, 'formats/raw/Nikon/D80/glarus.nef')),
        },
      });
      const ready = await utils.waitForAssetReady(admin.accessToken, asset.id, { signal });
      expect(ready.imageEncoding?.dynamicRange).toBe('sdr');
      expect(ready.isEdited).toBe(false);
      await utils.waitForAssetReady(admin.accessToken, rawAsset.id, { signal });
      websocket = await utils.connectWebsocket(admin.accessToken);
    }),
  );

  test.afterAll(() => {
    utils.disconnectWebsocket(websocket);
  });

  test.beforeEach(async ({ context, page }) => {
    // before each test, login as user
    await utils.setAuthCookies(context, admin.accessToken);
    await page.waitForLoadState('networkidle');
  });

  test('loads original photo when zoomed', async ({ context, page }) => {
    await page.goto(`/photos/${asset.id}`);

    const preview = page.getByTestId('preview').filter({ visible: true });
    await expect(preview).toHaveAttribute('src', /.+/);

    // The service worker follows the redirect; its response belongs to the browser context.
    const originalResponse = context.waitForEvent('response', {
      predicate: (response) => new URL(response.url()).pathname.endsWith(`/assets/${asset.id}/original`),
    });

    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, -1);

    const response = await originalResponse;
    expect(response.status()).toBe(200);
    expect(response.request().redirectedFrom()?.url()).toMatch(/thumbnail\?.*size=fullsize/);
    expect(
      createHash('sha256')
        .update(await response.body())
        .digest('hex'),
    ).toBe(originalDigest);

    const original = page.getByTestId('original').filter({ visible: true });
    // Redirects fetch original bytes without rewriting the image's requested rendition URL.
    await expect(original).toHaveAttribute('src', /thumbnail\?.*size=fullsize/);
    await expect(original).toBeVisible();
    await expect(original).toHaveJSProperty('complete', true);
    expect(await original.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  });

  test('loads fullsize image when zoomed and original is web-incompatible', async ({ page }) => {
    await page.goto(`/photos/${rawAsset.id}`);

    const preview = page.getByTestId('preview').filter({ visible: true });
    await expect(preview).toHaveAttribute('src', /.+/);

    const fullsizeResponse = page.waitForResponse((response) => response.url().includes('fullsize'));

    const { width, height } = page.viewportSize()!;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, -1);

    await fullsizeResponse;

    const original = page.getByTestId('original').filter({ visible: true });
    await expect(original).toHaveAttribute('src', /fullsize/);
  });

  test('right-click targets the img element', async ({ page }) => {
    await page.goto(`/photos/${asset.id}`);

    const preview = page.getByTestId('preview').filter({ visible: true });
    await expect(preview).toHaveAttribute('src', /.+/);

    const box = await preview.boundingBox();
    const tagAtCenter = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    });
    expect(tagAtCenter).toBe('IMG');
  });
});
