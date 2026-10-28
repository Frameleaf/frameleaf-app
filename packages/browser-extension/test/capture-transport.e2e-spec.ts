import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'vite';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('capture SDK transport recovers lost HTTP responses using the same private upload and receipt', async () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const userId = '11111111-1111-4111-8111-111111111111';
  const itemId = '44444444-4444-4444-8444-444444444444';
  const key = 'synthetic-delivery-key';
  const resources = new Map<
    string,
    { offset: number; size: number; ready: boolean; digest: string }
  >();
  let loseCreate = true,
    loseAppend = true,
    loseCommit = true;
  let creates = 0,
    commits = 0,
    sourceCount = 0;
  let committedBody: string | undefined;
  const headers: {
    cookie?: string;
    authorization?: string;
    key?: string;
    referrer?: string;
  }[] = [];
  const metadata: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    try {
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
      const state = (resourceId: string) => ({
        id: resourceId,
        ...resources.get(resourceId),
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
          resource.ready =
            resource.offset === resource.size &&
            req.headers['upload-complete'] === '?1' &&
            resource.digest ===
              `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
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
          !resources.get(value.captureId)?.ready ||
          (committedBody && committedBody !== body)
        ) {
          send({}, 409);
          return;
        }
        commits++;
        if (!committedBody) {
          committedBody = body;
          sourceCount++;
        }
        if (loseCommit) {
          loseCommit = false;
          req.socket.destroy();
          return;
        }
        send({
          captureId: value.captureId,
          status: 'created',
          item: { kind: 'asset', asset: { id: itemId } },
        });
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
