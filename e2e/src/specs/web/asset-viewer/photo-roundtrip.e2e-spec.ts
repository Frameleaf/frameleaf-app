import { createAssetDevelopExport, getAssetDevelop, importAssetDevelopRendition } from '@frameleaf/sdk';
import { expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { asBearerAuth, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';

/**
 * FL-144 / FL-64: "Edit in another app" round trip through the real editor and server. The
 * original is exported, a developed file comes back as a version, an interrupted upload changes
 * nothing and can be retried, and the server refuses a file named with another photo's export or
 * one that did not arrive intact.
 */
test('round trip: export, interrupted import retried once, and refused wrong original or damaged transfer', async ({
  context,
  page,
  assetReady,
}) => {
  test.setTimeout(120_000);
  utils.initSdk();
  await utils.resetDatabase();
  const owner = await utils.adminSetup();
  const headers = asBearerAuth(owner.accessToken);
  const gray = (background: string) =>
    sharp({ create: { width: 128, height: 128, channels: 3, background } })
      .png()
      .toBuffer();
  const asset = await utils.createAsset(owner.accessToken, {
    assetData: { filename: 'roundtrip.png', bytes: await gray('#808080') },
  });
  const other = await utils.createAsset(owner.accessToken, {
    assetData: { filename: 'other.png', bytes: await gray('#404040') },
  });
  await utils.waitForAssetReady(owner.accessToken, asset.id, { signal: assetReady.signal });
  await utils.waitForAssetReady(owner.accessToken, other.id, { signal: assetReady.signal });
  await utils.setAuthCookies(context, owner.accessToken);
  const developed = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#a0a0a0' } })
    .jpeg()
    .toBuffer();
  const revisionsOf = async (id: string) => {
    const develop = await getAssetDevelop({ id }, { headers });
    return develop.revisions.length;
  };

  await page.goto(`/photos/${asset.id}`);
  await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: /^Edit / });
  await editor.getByRole('button', { name: 'Versions' }).click();
  await page.getByRole('menuitem', { name: 'All versions' }).click();
  await expect(editor.getByRole('heading', { name: 'Edit in another app' })).toBeVisible();

  const download = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'Export original' }).click();
  await download;
  const exports = editor.getByRole('list', { name: 'Exported originals' });
  await expect(exports.getByText('Matches the original', { exact: true })).toHaveCount(1);

  const form = editor.getByRole('form', { name: 'Bring back as a version' });
  await form.getByLabel(/Finished file/).setInputFiles({
    name: 'roundtrip-developed.jpg',
    mimeType: 'image/jpeg',
    buffer: developed,
  });
  await form.getByLabel('Edited with (optional)').fill('Darkroom');

  // The first upload is cut off before it reaches the server: nothing is stored, the form says so.
  const importPath = `/api/assets/${asset.id}/develop/imports`;
  await page.route(
    (url) => url.pathname === importPath,
    (route) => route.abort('connectionreset'),
    { times: 1 },
  );
  await form.getByRole('button', { name: 'Bring back as a version' }).click();
  await expect(form.getByRole('alert')).toBeVisible();
  expect(await revisionsOf(asset.id)).toBe(0);

  // The same file, retried, arrives intact and becomes exactly one version.
  const imported = page.waitForResponse(
    (response) => new URL(response.url()).pathname === importPath && response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Bring back as a version' }).click();
  const importedResponse = await imported;
  expect(importedResponse.status()).toBe(201);
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect.poll(() => revisionsOf(asset.id)).toBe(1);

  // The server reconciles every return against this photo's current original.
  const foreignExport = await createAssetDevelopExport({ id: other.id }, { headers });
  const checksum = createHash('sha256').update(developed).digest('hex');
  const file = new File([developed], 'roundtrip-developed.jpg', { type: 'image/jpeg' });
  await expect(
    importAssetDevelopRendition(
      { id: asset.id, assetDevelopImportDto: { file, exportId: foreignExport.id, renditionChecksum: checksum } },
      { headers },
    ),
  ).rejects.toMatchObject({ status: 400, data: { message: 'That export was not made from this photo' } });

  const ownExport = await createAssetDevelopExport({ id: asset.id }, { headers });
  await expect(
    importAssetDevelopRendition(
      { id: asset.id, assetDevelopImportDto: { file, exportId: ownExport.id, renditionChecksum: '0'.repeat(64) } },
      { headers },
    ),
  ).rejects.toMatchObject({
    status: 400,
    data: { message: 'The file did not arrive intact; nothing was changed, try again' },
  });
  expect(await revisionsOf(asset.id)).toBe(1);
  expect(await revisionsOf(other.id)).toBe(0);
});
