import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'vite';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('capture delivery preserves one receipt through HTTP faults and browser restart', async ({}, testInfo) => {
  const id = '33333333-3333-4333-8333-333333333333';
  const userId = '11111111-1111-4111-8111-111111111111';
  const itemId = '44444444-4444-4444-8444-444444444444';
  test.setTimeout(60000);
  const key = 'synthetic-delivery-key';
  const albums = [
    { id: itemId, albumName: 'Inspiration', parentId: null as string | null },
  ];
  const albumRequests: unknown[] = [];
  let failNextAlbumResponse = false;
  const resources = new Map<
    string,
    {
      offset: number;
      size: number;
      ready: boolean;
      digest: string;
      chunks: Buffer[];
    }
  >();
  let loseCreate = true,
    loseAppend = true,
    loseCommit = true;
  let creates = 0,
    commits = 0,
    sourceCount = 0;
  const committedBodies = new Map<string, string>();
  let failCommitWithStatus = false;
  let holdUiReceipt = false;
  let releaseUiReceipt: (() => void) | undefined;
  const headers: {
    cookie?: string;
    authorization?: string;
    key?: string;
    referrer?: string;
  }[] = [];
  const publicKeys: (string | undefined)[] = [];
  const metadata: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith('/frameleaf/api/'))
        publicKeys.push(req.headers['x-api-key'] as string | undefined);
      if (req.url?.startsWith('/page')) {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#2ab06f"/></svg>';
        res
          .writeHead(200, { 'Content-Type': 'text/html' })
          .end(
            `<title>Fixture inspiration</title><img src="data:image/svg+xml,${encodeURIComponent(svg)}">`,
          );
        return;
      }
      if (!req.url?.startsWith('/frameleaf/api/')) {
        res.writeHead(404).end();
        return;
      }
      headers.push({
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        key: req.headers['x-api-key'] as string | undefined,
        referrer: req.headers.referer,
      });
      if (req.headers['x-api-key'] !== key) {
        res.writeHead(401).end();
        return;
      }
      const send = (value: unknown, status = 200) =>
        res
          .writeHead(status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(value));
      if (req.url === '/frameleaf/api/capture/capabilities') {
        send({
          version: 1,
          captureSupported: true,
          serverId: 'fixture',
          userId,
          maxFileBytes: 104857600,
        });
        return;
      }
      if (req.url === '/frameleaf/api/capture/catalog') {
        send({
          albums,
          tags: [],
        });
        return;
      }
      if (
        req.url === '/frameleaf/api/capture/albums' &&
        req.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const request = JSON.parse(Buffer.concat(chunks).toString());
        albumRequests.push(request);
        if (
          request.libraryScope !== 'design' ||
          (request.parentId &&
            !albums.some((album) => album.id === request.parentId))
        ) {
          send({}, 409);
          return;
        }
        const album = {
          id:
            albums.length === 1
              ? '55555555-5555-4555-8555-555555555555'
              : '66666666-6666-4666-8666-666666666666',
          albumName: request.name,
          parentId: request.parentId ?? null,
        };
        albums.push(album);
        if (failNextAlbumResponse) {
          failNextAlbumResponse = false;
          send({}, 503);
          return;
        }
        send({ ...album, unexpected: 'not-cached' }, 201);
        return;
      }
      const state = (resourceId: string) => ({
        id: resourceId,
        offset: resources.get(resourceId)!.offset,
        ready: resources.get(resourceId)!.ready,
        expiresAt: '2030-01-01T00:00:00.000Z',
      });
      if (
        req.url === '/frameleaf/api/capture/uploads' &&
        req.method === 'POST'
      ) {
        const value = JSON.parse(
          Buffer.from(
            req.headers['asset-metadata'] as string,
            'base64url',
          ).toString('utf8'),
        );
        metadata.push(value);
        const resourceId = value.captureId as string;
        if (resources.has(resourceId)) {
          send({}, 409);
          return;
        }
        creates++;
        for await (const _chunk of req) {
        }
        resources.set(resourceId, {
          offset: 0,
          size: Number(req.headers['upload-length']),
          ready: false,
          chunks: [],
          digest: req.headers['repr-digest'] as string,
        });
        if (loseCreate) {
          loseCreate = false;
          req.socket.destroy();
          return;
        }
        send(state(resourceId), 201);
        return;
      }
      if (req.url?.startsWith('/frameleaf/api/capture/uploads/')) {
        const resourceId = req.url.split('/').at(-1)!;
        const resource = resources.get(resourceId);
        if (!resource) {
          send({}, 404);
          return;
        }
        if (req.method === 'GET') {
          send(state(resourceId));
          return;
        }
        if (req.method === 'DELETE') {
          resources.delete(resourceId);
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'PATCH') {
          if (Number(req.headers['upload-offset']) !== resource.offset) {
            send({}, 409);
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          resource.offset += bytes.length;
          resource.chunks.push(bytes);
          resource.ready =
            resource.offset === resource.size &&
            req.headers['upload-complete'] === '?1' &&
            resource.digest ===
              `sha-256=:${createHash('sha256').update(Buffer.concat(resource.chunks)).digest('base64')}:`;
          if (loseAppend) {
            loseAppend = false;
            req.socket.destroy();
            return;
          }
          send(state(resourceId));
          return;
        }
      }
      if (
        req.url === '/frameleaf/api/capture/commit' &&
        req.method === 'POST'
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        const value = JSON.parse(body);
        if (
          (!value.bookmark && !resources.get(value.captureId)?.ready) ||
          (committedBodies.has(value.captureId) &&
            committedBodies.get(value.captureId) !== body)
        ) {
          send({}, 409);
          return;
        }
        commits++;
        if (!committedBodies.has(value.captureId)) {
          committedBodies.set(value.captureId, body);
          sourceCount++;
        }
        if (loseCommit) {
          loseCommit = false;
          if (failCommitWithStatus) {
            res
              .writeHead(503, {
                'Content-Type': 'application/json',
                'Retry-After': '0',
              })
              .end('{}');
            return;
          }
          req.socket.destroy();
          return;
        }
        const receipt = {
          captureId: value.captureId,
          status: 'created',
          item: value.bookmark
            ? { kind: 'bookmark', bookmark: { id: itemId } }
            : { kind: 'asset', asset: { id: itemId } },
        };
        if (holdUiReceipt) {
          holdUiReceipt = false;
          releaseUiReceipt = () => send(receipt);
          return;
        }
        send(receipt);
        return;
      }
      send({}, 404);
    } catch {
      if (!res.destroyed) res.writeHead(500).end();
    }
  });
  const temp = await mkdtemp(join(tmpdir(), 'frameleaf-delivery-'));
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const extensionPath = join(temp, 'extension');
    await cp(resolve(import.meta.dirname, '../dist'), extensionPath, {
      recursive: true,
    });
    const manifest = JSON.parse(
      await readFile(join(extensionPath, 'manifest.json'), 'utf8'),
    );
    manifest.host_permissions = ['http://127.0.0.1/*'];
    await writeFile(
      join(extensionPath, 'manifest.json'),
      JSON.stringify(manifest),
    );
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        target: 'chrome116',
        outDir: extensionPath,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: resolve(import.meta.dirname, '../src/capture-transport.ts'),
          formats: ['es'],
          fileName: () => 'transport-test.js',
        },
      },
    });
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        target: 'chrome116',
        outDir: extensionPath,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: resolve(import.meta.dirname, 'fixtures/runner-entry.ts'),
          formats: ['es'],
          fileName: () => 'runner-test.js',
        },
      },
    });
    context = await chromium.launchPersistentContext(join(temp, 'profile'), {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await context.addCookies([
      {
        name: 'private-browser-cookie',
        value: 'must-not-forward',
        url: origin,
        httpOnly: true,
      },
    ]);
    const result = await page.evaluate(
      async ({ origin, userId, id, itemId, key }) => {
        const module: typeof import('../src/capture-transport') = await import(
          chrome.runtime.getURL('transport-test.js')
        );
        const binding = {
          serverId: 'fixture',
          userId,
          credentialId: crypto.randomUUID(),
          origin: origin + '/frameleaf',
        };
        const blob = new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
          ],
          { type: 'image/svg+xml' },
        );
        const hash = [
          ...new Uint8Array(
            await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()),
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        const task: import('../src/queue').CaptureTask = {
          version: 1,
          id,
          captureId: id,
          binding,
          albumId: itemId,
          tagIds: [],
          source: {
            pageUrl: 'https://example.com/',
            title: 'Synthetic capture',
            capturedAt: '2026-10-28T12:00:00.000Z',
          },
          file: {
            filename: 'synthetic.svg',
            type: blob.type,
            size: blob.size,
            sha256: hash,
          },
          state: 'uploading',
          phase: 'upload',
          offset: 0,
          attempts: 1,
          createdAt: 1,
          updatedAt: 1,
        };
        const transport = module.createCaptureTransport(binding, key);
        const errors: { kind: string; status: number }[] = [];
        try {
          await transport.createUpload(task);
        } catch (error) {
          const failure =
            error as import('../src/capture-transport').DeliveryFailure;
          errors.push({ kind: failure.kind, status: failure.status });
        }
        const created = await transport.getUpload(task);
        try {
          await transport.appendUpload(task, blob, created.offset);
        } catch (error) {
          const failure =
            error as import('../src/capture-transport').DeliveryFailure;
          errors.push({ kind: failure.kind, status: failure.status });
        }
        const verified = await transport.getUpload(task);
        task.phase = 'commit';
        task.state = 'committing';
        task.offset = verified.offset;
        try {
          await transport.commit(task);
        } catch (error) {
          const failure =
            error as import('../src/capture-transport').DeliveryFailure;
          errors.push({ kind: failure.kind, status: failure.status });
        }
        const receipt = await transport.commit(task);
        const next = {
          ...task,
          id: crypto.randomUUID(),
          state: 'uploading' as const,
          phase: 'upload' as const,
          offset: 0,
        };
        next.captureId = next.id;
        await transport.createUpload(next);
        await transport.cancelUpload(next);
        return { errors, created, verified, receipt };
      },
      { origin, userId, id, itemId, key },
    );
    // Chromium can replay interrupted requests; upload conflicts reconcile through GET.
    for (const failure of result.errors)
      expect(
        failure.kind === 'retry' ||
          (failure.kind === 'attention' && failure.status === 409),
      ).toBe(true);
    expect([loseCreate, loseAppend, loseCommit]).toEqual([false, false, false]);
    expect(result.created.offset).toBe(0);
    expect(result.verified.ready).toBe(true);
    expect(result.receipt).toEqual({
      captureId: id,
      status: 'created',
      kind: 'asset',
      itemId,
    });
    expect(creates).toBe(2);
    expect(commits).toBeGreaterThanOrEqual(2);
    expect(sourceCount).toBe(1);
    expect(resources.size).toBe(1);
    expect(metadata[0]).toMatchObject({
      publication: 'capture',
      libraryScope: 'design',
      captureId: id,
      filename: 'synthetic.svg',
    });
    await page.getByLabel('Server address').fill(origin + '/frameleaf');
    await page.getByLabel('Browser capture key', { exact: true }).fill(key);
    await page.getByText('Local development', { exact: true }).click();
    await page.getByLabel('Allow HTTP on this computer only').check();
    await page
      .getByRole('button', { name: 'Connect server', exact: true })
      .click();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    loseCreate = true;
    loseAppend = true;
    loseCommit = true;
    failCommitWithStatus = true;
    const pending = await page.evaluate(
      async ({ origin, userId, itemId, key }) => {
        const queue: typeof import('./fixtures/runner-entry') = await import(
          chrome.runtime.getURL('runner-test.js')
        );
        const binding = {
          serverId: 'fixture',
          userId,
          credentialId: crypto.randomUUID(),
          origin: origin + '/frameleaf',
        };
        const blob = new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><!--',
            'x'.repeat(5 * 1024 * 1024),
            '--><rect width="8" height="8"/></svg>',
          ],
          { type: 'image/svg+xml' },
        );
        const task = await queue.enqueueCapture({
          binding,
          albumId: itemId,
          tagIds: [],
          source: {
            pageUrl: 'https://example.com/runner?private=1',
            title: 'Native runner fixture',
            capturedAt: new Date().toISOString(),
          },
          file: { blob, filename: 'runner.svg' },
        });
        await chrome.runtime.sendMessage({ type: 'wake-queue' });
        return { id: task.id, binding };
      },
      { origin, userId, itemId, key },
    );
    await expect
      .poll(async () =>
        page.evaluate(async (binding) => {
          const queue: typeof import('./fixtures/runner-entry') = await import(
            chrome.runtime.getURL('runner-test.js')
          );
          const current = (await queue.listCaptures(binding))[0];
          return current?.retryAt ? current.state : '';
        }, pending.binding),
      )
      .toBe('committing');
    const persisted = await page.evaluate(async (binding) => {
      const queue: typeof import('./fixtures/runner-entry') = await import(
        chrome.runtime.getURL('runner-test.js')
      );
      const current = (await queue.listCaptures(binding))[0];
      return {
        state: current.state,
        phase: current.phase,
        retryAt: current.retryAt,
        size: (await queue.captureBlob(current.id))?.size,
      };
    }, pending.binding);
    expect(persisted.state).toBe('committing');
    expect(persisted.phase).toBe('commit');
    expect(persisted.retryAt).toBeGreaterThan(Date.now());
    expect(persisted.size).toBeGreaterThan(5 * 1024 * 1024);
    expect(sourceCount).toBe(2);
    const creationsBeforeRestart = creates;
    await context.close();
    context = undefined;
    context = await chromium.launchPersistentContext(join(temp, 'profile'), {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const restartedWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const restartedPage = await context.newPage();
    await restartedPage.goto(
      `chrome-extension://${new URL(restartedWorker.url()).hostname}/options.html`,
    );
    await expect
      .poll(
        async () =>
          restartedPage.evaluate(async () => {
            const reply: import('../src/platform').ExtensionReply =
              await chrome.runtime.sendMessage({ type: 'queue' });
            return reply.ok
              ? reply.queue?.items.find((item) => item.label === 'runner.svg')
                  ?.state
              : '';
          }),
        { timeout: 10000 },
      )
      .toBe('saved');
    const resumed = await restartedPage.evaluate(async (pending) => {
      const queue: typeof import('./fixtures/runner-entry') = await import(
        chrome.runtime.getURL('runner-test.js')
      );
      const after = (await queue.listCaptures(pending.binding))[0];
      return {
        id: after.id,
        state: after.state,
        receipt: after.receipt,
        removed: (await queue.captureBlob(after.id)) === null,
      };
    }, pending);
    expect(resumed.id).toBe(pending.id);
    expect(resumed.state).toBe('saved');
    expect(resumed.receipt?.captureId).toBe(pending.id);
    expect(resumed.removed).toBe(true);
    expect(sourceCount).toBe(2);
    expect(creates).toBe(creationsBeforeRestart);
    const content = await context.newPage();
    await content.goto(origin + '/page');
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(restartedWorker.url()).hostname}/popup.html`,
    );
    await expect(popup.getByText('Connected', { exact: true })).toBeVisible();
    await content.bringToFront();
    const opened = context.waitForEvent('page');
    await popup.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Find images on this page'),
      );
      button!.click();
    });
    const chooser = await opened;
    await expect(
      chooser.getByRole('heading', { name: 'Collect images', exact: true }),
    ).toBeVisible();
    await chooser.getByLabel('Album', { exact: true }).selectOption(itemId);
    await chooser.locator('.candidate-list').getByRole('checkbox').check();
    await expect(
      chooser.getByRole('button', {
        name: 'Save selected images',
        exact: true,
      }),
    ).toBeVisible({ timeout: 1000 });
    await chooser.screenshot({
      path: testInfo.outputPath('save-selection.png'),
      fullPage: true,
    });
    holdUiReceipt = true;
    await chooser
      .getByRole('button', { name: 'Save selected images', exact: true })
      .click();
    await expect(
      chooser.getByText('Queued 1 image.', { exact: true }),
    ).toBeVisible();
    await chooser.close();
    await expect.poll(() => !!releaseUiReceipt).toBe(true);
    releaseUiReceipt!();
    const saved = popup
      .locator('.queue-list li')
      .filter({ hasText: 'capture.svg' });
    await expect(saved.getByText('Saved', { exact: true })).toBeVisible();
    await popup.screenshot({
      path: testInfo.outputPath('saved-queue.png'),
      fullPage: true,
    });
    expect(sourceCount).toBe(3);
    await content.goto(origin + '/page?variant=2#section');
    await content.bringToFront();
    const bookmarkOpened = context.waitForEvent('page');
    await popup.evaluate(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === 'Save page bookmark')!
        .click();
    });
    const bookmarkPage = await bookmarkOpened;
    await expect(
      bookmarkPage.getByRole('heading', {
        name: 'Save page bookmark',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      bookmarkPage.getByLabel('Bookmark address', { exact: true }),
    ).toHaveValue(origin + '/page?variant=2#section');
    await expect(
      bookmarkPage.getByLabel('Source page', { exact: true }),
    ).toHaveValue(origin + '/page');
    await expect(bookmarkPage.locator('.candidate-list')).toHaveCount(0);
    await bookmarkPage
      .getByLabel('Album', { exact: true })
      .selectOption(itemId);
    await bookmarkPage.getByText('Create an album', { exact: true }).click();
    await bookmarkPage
      .getByLabel('New album name', { exact: true })
      .fill('Packaging');
    await bookmarkPage
      .getByLabel('Parent album', { exact: true })
      .selectOption(itemId);
    await bookmarkPage
      .getByRole('button', { name: 'Create and select album', exact: true })
      .click();
    await expect(
      bookmarkPage.getByText(
        'Album created and selected. Captures have not been saved.',
        { exact: true },
      ),
    ).toBeVisible();
    const nestedId = albums[1].id;
    await expect(bookmarkPage.getByLabel('Album', { exact: true })).toHaveValue(
      nestedId,
    );
    await expect(
      bookmarkPage
        .getByLabel('Album', { exact: true })
        .locator('option:checked'),
    ).toHaveText('Inspiration / Packaging');
    expect(albumRequests).toEqual([
      { name: 'Packaging', parentId: itemId, libraryScope: 'design' },
    ]);
    await bookmarkPage
      .getByLabel('New album name', { exact: true })
      .fill('Interrupted');
    await bookmarkPage
      .getByLabel('Parent album', { exact: true })
      .selectOption(nestedId);
    failNextAlbumResponse = true;
    await bookmarkPage
      .getByRole('button', { name: 'Create and select album', exact: true })
      .click();
    await expect(bookmarkPage.getByRole('alert')).toContainText(
      'Could not confirm album creation',
    );
    await expect(
      bookmarkPage.getByRole('button', {
        name: 'Create and select album',
        exact: true,
      }),
    ).toBeDisabled();
    await bookmarkPage
      .getByRole('button', { name: 'Refresh albums', exact: true })
      .click();
    await expect(
      bookmarkPage.getByLabel('New album name', { exact: true }),
    ).toBeEnabled();
    await expect(
      bookmarkPage
        .getByLabel('Album', { exact: true })
        .locator('option')
        .filter({ hasText: 'Inspiration / Packaging / Interrupted' }),
    ).toHaveCount(1);
    expect(albumRequests).toHaveLength(2);
    expect(albums).toHaveLength(3);
    const uploadsBeforeBookmark = creates;
    await bookmarkPage.screenshot({
      path: testInfo.outputPath('bookmark-preview.png'),
      fullPage: true,
    });
    await bookmarkPage
      .getByRole('button', { name: 'Save page bookmark', exact: true })
      .click();
    await expect(
      bookmarkPage.getByText('Queued 1 bookmark.', { exact: true }),
    ).toBeVisible();
    await expect(
      bookmarkPage.getByRole('button', {
        name: 'Bookmark queued',
        exact: true,
      }),
    ).toBeDisabled();
    await bookmarkPage.close();
    const bookmarkRow = popup
      .locator('.queue-list li')
      .filter({ hasText: 'Fixture inspiration' });
    await expect(bookmarkRow.getByText('Saved', { exact: true })).toBeVisible();
    expect(creates).toBe(uploadsBeforeBookmark);
    expect(sourceCount).toBe(4);
    const bookmarkBody = [...committedBodies.values()]
      .map((body) => JSON.parse(body))
      .find((body) => body.bookmark);
    expect(bookmarkBody.bookmark).toEqual({
      url: origin + '/page?variant=2#section',
      title: 'Fixture inspiration',
    });
    expect(bookmarkBody.source.pageUrl).toBe(origin + '/page');
    expect(bookmarkBody.albumId).toBe(nestedId);
    expect(bookmarkBody.uploadResourceId).toBeUndefined();
    expect(bookmarkBody.sha256).toBeUndefined();
    await popup.screenshot({
      path: testInfo.outputPath('bookmark-saved.png'),
      fullPage: true,
    });
    const polling = await context.newPage();
    await polling.clock.install();
    await polling.addInitScript(() => {
      const state = globalThis as typeof globalThis & {
        queueReads: number;
        releaseQueue?: () => void;
      };
      state.queueReads = 0;
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((message: unknown) => {
        if (
          message &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'queue'
        ) {
          state.queueReads++;
          return new Promise((resolve) => {
            state.releaseQueue = () => {
              void original(message).then(resolve);
            };
          });
        }
        return original(message);
      }) as typeof chrome.runtime.sendMessage;
    });
    await polling.goto(
      `chrome-extension://${new URL(restartedWorker.url()).hostname}/popup.html`,
    );
    await expect(polling.getByText('Connected', { exact: true })).toBeVisible();
    await polling.clock.runFor(6000);
    expect(
      await polling.evaluate(
        () =>
          (globalThis as typeof globalThis & { queueReads: number }).queueReads,
      ),
    ).toBe(1);
    await polling.evaluate(() =>
      (
        globalThis as typeof globalThis & { releaseQueue?: () => void }
      ).releaseQueue?.(),
    );
    await polling.close();
    expect(publicKeys.every((value) => value === undefined)).toBe(true);
    for (const request of headers)
      expect(request).toEqual({
        cookie: undefined,
        authorization: undefined,
        key,
        referrer: undefined,
      });
  } finally {
    await context?.close();
    if (server.listening) {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      );
      server.closeAllConnections();
      await closed;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
