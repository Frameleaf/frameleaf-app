import { expect, test, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { app, asBearerAuth, utils } from 'src/utils.js';

/** FL-233: normal API/worker/browser proof, without response/render/auth overrides.
 * Run alone against an owned disposable database. Queued responses never prove rendering.
 */
test('preserves an opaque recipe through real editor history/save-only fallback and renders an explicit Original reset', async ({
  context,
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  utils.initSdk();
  await utils.resetDatabase();
  const owner = await utils.adminSetup();
  const asset = await utils.createAsset(owner.accessToken, { assetData: { filename: 'opaque-recipe-fl233.png' } });
  await utils.setAuthCookies(context, owner.accessToken);
  const endpoint = `${app}/assets/${asset.id}/develop`;
  const read = async () => {
    const response = await context.request.get(endpoint);
    expect(response.status()).toBe(200);
    return response.json();
  };
  const digest = async (url: string) => {
    const response = await context.request.get(url);
    expect(response.status()).toBe(200);
    return createHash('sha256')
      .update(await response.body())
      .digest('hex');
  };
  const observeSave = (render: boolean) =>
    page.waitForResponse(
      (response) =>
        response.url() === endpoint &&
        response.request().method() === 'PUT' &&
        response.request().postDataJSON().render === render,
    );
  const open = async () => {
    await page.goto(`/photos/${asset.id}`);
    await expect(page.getByTestId('preview').filter({ visible: true })).toHaveAttribute('src', /.+/);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog', { name: /^Edit / });
    await expect(editor).toBeVisible();
    return editor;
  };
  const load = async (editor: Locator, label: string) => {
    await editor.getByRole('button', { name: 'Versions', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'All versions and renders', exact: true }).click();
    await editor
      .locator('.ed-version')
      .filter({ hasText: label })
      .getByRole('button', { name: 'Load settings', exact: true })
      .click();
    await expect(editor.getByRole('tab', { name: 'Adjust', exact: true })).toHaveAttribute('aria-selected', 'true');
  };
  const requests: { render: boolean; status: number; payload: unknown }[] = [];
  const record = (response: Awaited<ReturnType<typeof observeSave>>) => {
    requests.push({
      render: response.request().postDataJSON().render,
      status: response.status(),
      payload: response.request().postDataJSON(),
    });
  };
  const rendered = async (id: string) => {
    await expect
      .poll(
        async () => {
          const state = await read();
          return {
            status: state.revisions.find((item: { id: string }) => item.id === id)?.status,
            currentRevisionId: state.currentRevisionId,
          };
        },
        {
          timeout: 60_000,
        },
      )
      .toEqual({ status: 'rendered', currentRevisionId: id });
  };

  await test.step('create a real supported master/current preview through the actual worker', async () => {
    const response = await context.request.put(endpoint, { data: { recipe: { version: 1 }, render: true } });
    expect(response.status()).toBe(200);
    const baseline = await response.json();
    await rendered(baseline.id);
  });
  const before = await read();
  expect(before.currentRevisionId).not.toBeNull();
  const current = before.revisions.find((item: { id: string }) => item.id === before.currentRevisionId);
  expect(current).toMatchObject({ hasMaster: true, hasPreview: true, status: 'rendered' });
  const masterUrl = `${endpoint}/revisions/${current.id}/file?kind=master`;
  const previewUrl = `${endpoint}/revisions/${current.id}/file?kind=preview`;
  const originalUrl = `${app}/assets/${asset.id}/original`;
  const originalHash = await digest(originalUrl);
  const masterHash = await digest(masterUrl);
  const previewHash = await digest(previewUrl);
  const opaque = {
    version: 2,
    contrast: 7,
    future: { operations: [{ method: 'opaque', fill: { revision: 'untouched', values: [1, 2] } }] },
    masks: [
      {
        id: 'known',
        kind: 'radial',
        x: 0.5,
        y: 0.5,
        maskWeight: { future: true },
        adjustments: { future: { curve: [1, 2] } },
      },
      { id: 'future', kind: 'subject', descriptor: { coordinates: 'opaque' } },
    ],
  };
  const seeded = await context.request.put(endpoint, {
    data: { recipe: opaque, label: 'Future recipe source', render: false },
  });
  expect(seeded.status()).toBe(200);
  const source = await seeded.json();
  expect(source).toMatchObject({ status: 'saved', hasMaster: false, hasPreview: false, recipe: opaque });

  await test.step('refuse a foreign source through the normal API without mutating this asset', async () => {
    const separate = await utils.createAsset(owner.accessToken);
    const mismatched = await context.request.put(`${app}/assets/${separate.id}/develop`, {
      data: { recipe: { version: 1 }, sourceRevisionId: source.id, render: false },
    });
    expect(mismatched.status()).toBe(400);
    const separateState = await context.request.get(`${app}/assets/${separate.id}/develop`);
    expect(separateState.status()).toBe(200);
    const separateData = await separateState.json();
    expect(separateData.revisions).toEqual([]);
    const foreign = await utils.userSetup(owner.accessToken, {
      email: 'foreign-fl233@example.com',
      name: 'Foreign FL233',
      password: 'test-password-fl233',
    });
    const foreignAsset = await utils.createAsset(foreign.accessToken);
    // The independent API context has no owner cookies; this is ordinary foreign-user bearer auth.
    const foreignSaved = await request.put(`${app}/assets/${foreignAsset.id}/develop`, {
      headers: asBearerAuth(foreign.accessToken),
      data: { recipe: { version: 1 }, render: false },
    });
    expect(foreignSaved.status()).toBe(200);
    const foreignSource = await foreignSaved.json();
    const denied = await context.request.put(endpoint, {
      data: { recipe: opaque, sourceRevisionId: foreignSource.id, render: false },
    });
    expect(denied.status()).toBe(400);
    expect(await denied.json()).not.toMatchObject({ code: 'develop_renderer_unsupported' });
    const unchanged = await read();
    expect(unchanged.revisions).toHaveLength(2);
  });

  let saved!: { id: string; revision: number; recipe: unknown };
  await test.step('load/edit/undo/redo and retry only the actual pre-write renderer refusal', async () => {
    const editor = await open();
    await load(editor, 'Future recipe source');
    const contrast = editor.getByRole('slider', { name: 'Contrast', exact: true });
    await expect(contrast).toHaveValue('7');
    await contrast.fill('25');
    await editor.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(contrast).toHaveValue('7');
    await editor.focus();
    await page.keyboard.press('Control+Shift+z');
    await expect(contrast).toHaveValue('25');
    const image = editor.locator('.ed-stage img').last();
    await expect(image).toBeVisible();
    const imageUrl = await image.getAttribute('src');
    expect(imageUrl).toBeTruthy();
    const imageSource = (value: string) => {
      const url = new URL(value, page.url());
      url.searchParams.delete('c');
      return url.href;
    };
    const refusedPromise = observeSave(true);
    const savedPromise = observeSave(false);
    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    const refused = await refusedPromise;
    record(refused);
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toMatchObject({ code: 'develop_renderer_unsupported' });
    const successful = await savedPromise;
    record(successful);
    expect(successful.status()).toBe(200);
    const first = refused.request().postDataJSON();
    const second = successful.request().postDataJSON();
    expect(first).toMatchObject({
      sourceRevisionId: source.id,
      replaceRecipe: true,
      recipe: { ...opaque, contrast: 25 },
      render: true,
    });
    expect(second).toEqual({ ...first, render: false });
    saved = await successful.json();
    expect(saved).toMatchObject({
      status: 'saved',
      hasMaster: false,
      hasPreview: false,
      recipe: { ...opaque, contrast: 25 },
    });
    await expect(
      page.getByText('Edits saved. This recipe requires a newer renderer; the current preview is unchanged.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/Version \d+ saved\. Rendering the edited master/)).toHaveCount(0);
    await expect(editor).toBeHidden();
    const after = await read();
    // Two existing rows plus exactly one new row proves the refused first request wrote no revision.
    expect(after.revisions).toHaveLength(3);
    expect(after.currentRevisionId).toBe(current.id);
    expect(after.revisions.find((item: { id: string }) => item.id === source.id)?.recipe).toEqual(opaque);
    expect(await digest(masterUrl)).toBe(masterHash);
    expect(await digest(previewUrl)).toBe(previewHash);
    expect(await digest(originalUrl)).toBe(originalHash);
    await page.keyboard.press('e');
    await expect(editor).toBeVisible();
    // Asset metadata may acquire a thumbhash while rendering; only its cache token can change.
    await expect
      .poll(async () => imageSource((await editor.locator('.ed-stage img').last().getAttribute('src')) ?? ''))
      .toBe(imageSource(imageUrl!));
    await page.keyboard.press('Escape');
  });

  await test.step('reload the saved opaque recipe and deliberately reset Original into a real render', async () => {
    await page.reload();
    const editor = await open();
    await load(editor, `Version ${saved.revision}`);
    await expect(editor.getByRole('slider', { name: 'Contrast', exact: true })).toHaveValue('25');
    const reloaded = await read();
    expect(reloaded.revisions.find((item: { id: string }) => item.id === saved.id)?.recipe).toEqual({
      ...opaque,
      contrast: 25,
    });
    await editor.getByRole('button', { name: 'Revert', exact: true }).click();
    const renderedPromise = observeSave(true);
    await editor.getByRole('button', { name: 'Save version', exact: true }).click();
    const admitted = await renderedPromise;
    record(admitted);
    expect(admitted.status()).toBe(200);
    const sent = admitted.request().postDataJSON();
    expect(sent).toMatchObject({ render: true, replaceRecipe: true, recipe: { version: 1, contrast: 0, masks: [] } });
    expect(sent).not.toHaveProperty('sourceRevisionId');
    expect(sent.recipe).not.toHaveProperty('future');
    const revision = await admitted.json();
    await rendered(revision.id);
    const after = await read();
    expect(after.currentRevisionId).toBe(revision.id);
    expect(after.revisions).toHaveLength(4);
    expect(after.revisions.find((item: { id: string }) => item.id === revision.id)).toMatchObject({
      hasMaster: true,
      hasPreview: true,
    });
    expect(await digest(originalUrl)).toBe(originalHash);
    await testInfo.attach('rendered-artifact-hashes', {
      body: JSON.stringify(
        {
          assetId: asset.id,
          originalSha256: originalHash,
          before: { revisionId: current.id, masterSha256: masterHash, previewSha256: previewHash },
          after: {
            revisionId: revision.id,
            masterSha256: await digest(`${endpoint}/revisions/${revision.id}/file?kind=master`),
            previewSha256: await digest(`${endpoint}/revisions/${revision.id}/file?kind=preview`),
          },
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(requests.map(({ render, status }) => ({ render, status }))).toEqual([
      { render: true, status: 400 },
      { render: false, status: 200 },
      { render: true, status: 200 },
    ]);
  });
  await testInfo.attach('actual-save-requests', {
    body: JSON.stringify(requests, null, 2),
    contentType: 'application/json',
  });
});
