import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { app, utils } from 'src/utils.js';

/** FL-144 / FL-64: normal API, actual editor controls and real preview/render workers. */
test('renders a radial exposure mask selectively and preserves it across save, reload and rendition comparison', async ({
  context,
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  utils.initSdk();
  await utils.resetDatabase();
  const owner = await utils.adminSetup();
  // Uniform gray removes image-content ambiguity from the inside/outside oracle.
  const source = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#808080' } })
    .png()
    .toBuffer();
  const asset = await utils.createAsset(owner.accessToken, {
    assetData: { filename: 'radial-gray.png', bytes: source },
  });
  await utils.waitForQueueFinish(owner.accessToken, 'metadataExtraction');
  await utils.waitForQueueFinish(owner.accessToken, 'thumbnailGeneration');
  await utils.setAuthCookies(context, owner.accessToken);
  const endpoint = `${app}/assets/${asset.id}/develop`;
  const read = async () => {
    const response = await context.request.get(endpoint);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const original = async () => {
    const response = await context.request.get(`${app}/assets/${asset.id}/original`);
    expect(response.status()).toBe(200);
    return createHash('sha256')
      .update(await response.body())
      .digest('hex');
  };
  const originalHash = await original();
  const measurements: { kind: string; center: number[]; outside: number[] }[] = [];
  const selectivePixels = async (body: Buffer, kind: string) => {
    const { data, info } = await sharp(body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(128);
    expect(info.height).toBe(128);
    const sample = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    const center = sample(64, 64);
    const outside = sample(8, 8);
    // Independent sRGB +1EV reference for gray128 is176. Center is fully inside the
    // default ellipse; corner is fully outside. ±3 permits JPEG quantization only.
    for (const channel of center) {
      expect(Math.abs(channel - 176)).toBeLessThanOrEqual(3);
    }
    for (const channel of outside) {
      expect(Math.abs(channel - 128)).toBeLessThanOrEqual(3);
    }
    measurements.push({ kind, center, outside });
  };
  await page.goto(`/photos/${asset.id}`);
  await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: /^Edit / });
  // Normal clicks also guard the shared desktop wrapper: every tool keeps a full inspector.
  for (const tool of ['Crop', 'Presets', 'Enhance', 'Adjust']) {
    await editor.getByRole('tab', { name: tool, exact: true }).click();
    const panel = editor.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box?.width ?? 0;
      })
      .toBeGreaterThanOrEqual(280);
  }
  await editor.getByRole('button', { name: 'Masks', exact: true }).click();
  await editor.getByRole('button', { name: 'Radial', exact: true }).click();
  await expect(editor.getByRole('radio')).toHaveCount(1);
  const stageImage = editor.locator('.ed-stage img').last();
  const previousPreviewUrl = await stageImage.getAttribute('src');
  const previewPromise = page.waitForResponse(
    (response) =>
      response.url() === `${endpoint}/preview` &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON().recipe.masks?.[0]?.adjustments.exposure === 1,
  );
  await editor.getByRole('slider', { name: 'Exposure', exact: true }).fill('1');
  const preview = await previewPromise;
  expect(preview.status()).toBe(200);
  await expect(stageImage).toHaveAttribute('src', /^blob:/);
  await expect(stageImage).not.toHaveAttribute('src', previousPreviewUrl!);
  await expect
    .poll(() =>
      stageImage.evaluate(
        (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  // Decode the actual displayed, newly completed object URL. Playwright's intercepted
  // response body can be empty even when the actual server JPEG has arrived in the UI.
  const displayedBytes = await stageImage.evaluate(async (image) => {
    const response = await fetch((image as HTMLImageElement).src);
    return [...new Uint8Array(await response.arrayBuffer())];
  });
  await selectivePixels(Buffer.from(displayedBytes), 'actual displayed editor preview');
  await testInfo.attach('desktop-mask-preview', { body: await page.screenshot(), contentType: 'image/png' });
  const unsaved = await read();
  expect(unsaved.revisions).toHaveLength(0);
  const savedPromise = page.waitForResponse(
    (response) => response.url() === endpoint && response.request().method() === 'PUT',
  );
  await editor.getByRole('button', { name: 'Save version', exact: true }).click();
  const savedResponse = await savedPromise;
  expect(savedResponse.status()).toBe(200);
  const saved = await savedResponse.json();
  const expectedMask = {
    kind: 'radial',
    enabled: true,
    invert: false,
    x: 0.5,
    y: 0.5,
    radiusX: 0.25,
    radiusY: 0.25,
    amount: 100,
    feather: 50,
    adjustments: expect.objectContaining({ exposure: 1 }),
  };
  expect(saved.recipe.masks).toEqual([expect.objectContaining(expectedMask)]);
  expect(saved.recipe.exposure).toBe(0);
  await expect(editor).toBeHidden();
  await expect
    .poll(
      async () => {
        const state = await read();
        const revision = state.revisions.find((item: { id: string }) => item.id === saved.id);
        return {
          current: state.currentRevisionId,
          status: revision?.status,
          master: revision?.hasMaster,
          preview: revision?.hasPreview,
        };
      },
      { timeout: 60_000 },
    )
    .toEqual({ current: saved.id, status: 'rendered', master: true, preview: true });
  for (const kind of ['master', 'preview']) {
    const response = await context.request.get(`${endpoint}/revisions/${saved.id}/file?kind=${kind}`);
    expect(response.status()).toBe(200);
    await selectivePixels(await response.body(), kind);
  }
  expect(await original()).toBe(originalHash);
  await page.reload();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.getByRole('button', { name: /^Masks/ }).click();
  await expect(editor.getByRole('radio')).toHaveCount(1);
  await editor.getByRole('radio').click();
  await expect(editor.getByRole('radio')).toHaveAttribute('aria-checked', 'true');
  await expect(editor.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('1');
  const persisted = await read();
  expect(persisted.revisions).toHaveLength(1);
  expect(persisted.revisions[0].recipe.masks).toEqual(saved.recipe.masks);
  await editor.getByRole('button', { name: 'Versions', exact: true }).click();
  await editor.getByRole('menuitem', { name: 'All versions', exact: true }).click();
  await editor.getByRole('button', { name: 'Compare with original', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'Compare with original', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(editor.locator('.rc-stage img')).toHaveCount(2);
  await expect(editor.locator('.rc-stage img').first()).toBeVisible();
  await expect(editor.locator('.rc-stage img').last()).toBeVisible();
  await expect(editor.locator('.rc-stage img').last()).toHaveAttribute('src', new RegExp(saved.id));
  await testInfo.attach('desktop-rendition-comparison', { body: await page.screenshot(), contentType: 'image/png' });
  // The existing <=900px bottom sheet must still use flex, with reachable normal controls.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tool of ['Crop', 'Presets', 'Enhance', 'Adjust']) {
    await editor.getByRole('tab', { name: tool, exact: true }).click();
    const panel = editor.getByRole('tabpanel');
    await expect(panel).toBeVisible();
    await expect
      .poll(async () => {
        const box = await panel.boundingBox();
        return box?.width ?? 0;
      })
      .toBeGreaterThanOrEqual(360);
  }
  await editor.getByRole('button', { name: /^Masks/ }).click();
  await editor.getByRole('button', { name: 'Linear', exact: true }).click();
  await expect(editor.getByRole('radio')).toHaveCount(2);
  await testInfo.attach('mobile-mask-controls', { body: await page.screenshot(), contentType: 'image/png' });
  const afterMobileDraft = await read();
  expect(afterMobileDraft.revisions).toHaveLength(1);
  expect(afterMobileDraft.revisions[0].recipe.masks).toEqual(saved.recipe.masks);
  await testInfo.attach('independent-selective-pixel-measurements', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json',
  });
});
