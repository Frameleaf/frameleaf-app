import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'vite';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binding = {
  serverId: 'queue-fixture',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example/subpath',
};
const albumId = '33333333-3333-4333-8333-333333333333';
const source = {
  pageUrl: 'https://example.com/page?private=1',
  title: 'Synthetic queue fixture',
  capturedAt: '2026-10-28T12:00:00.000Z',
};

test('native IndexedDB commits bytes atomically and preserves acknowledged captures across browser restart', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'frameleaf-queue-'));
  let context: BrowserContext | undefined;
  try {
    const extensionPath = join(temp, 'extension');
    await cp(resolve(import.meta.dirname, '../dist'), extensionPath, {
      recursive: true,
    });
    // Test-only entry exercises the production module in a native IDB engine; it is never packaged in dist.
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        target: 'chrome116',
        outDir: extensionPath,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: resolve(import.meta.dirname, '../src/queue.ts'),
          formats: ['es'],
          fileName: () => 'queue-test.js',
        },
      },
    });
    const launch = async () => {
      const browser = await chromium.launchPersistentContext(
        join(temp, 'profile'),
        {
          channel: 'chromium',
          headless: true,
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
          ],
        },
      );
      const worker =
        browser.serviceWorkers()[0] ??
        (await browser.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).hostname;
      const page = await browser.newPage();
      await page.goto(`chrome-extension://${id}/options.html`);
      return { browser, page };
    };
    let running = await launch();
    context = running.browser;
    const created = await running.page.evaluate(
      async (input) => {
        const q: typeof import('../src/queue') = await import(
          chrome.runtime.getURL('queue-test.js')
        );
        const first = await q.enqueueCapture({
          ...input,
          file: {
            blob: new Blob(['abc'], { type: 'image/png' }),
            filename: 'one.png',
          },
        });
        await q.claimCapture(
          input.binding,
          'old-cancellation-owner',
          Date.now() - q.CLAIM_MS - 100,
        );
        await q.requestCaptureCancellation(first.id, input.binding);
        const second = await q.enqueueCapture({
          ...input,
          file: {
            blob: new Blob(['def'], { type: 'image/png' }),
            filename: 'two.png',
          },
        });
        const bookmark = await q.enqueueCapture({
          ...input,
          bookmark: {
            url: 'https://example.com/watch?v=123',
            title: 'Watch later',
          },
        });
        const original = IDBObjectStore.prototype.add;
        let rolledBack = false;
        IDBObjectStore.prototype.add = function (
          value: unknown,
          key?: IDBValidKey,
        ) {
          if (this.name === 'blobs')
            throw new DOMException(
              'Synthetic quota failure',
              'QuotaExceededError',
            );
          return original.call(this, value, key);
        };
        try {
          await q.enqueueCapture({
            ...input,
            file: { blob: new Blob(['ghi']), filename: 'failed.png' },
          });
        } catch {
          rolledBack = true;
        } finally {
          IDBObjectStore.prototype.add = original;
        }
        return {
          ids: [first.id, second.id, bookmark.id],
          cancelId: first.id,
          rolledBack,
          count: (await q.listCaptures(input.binding)).length,
        };
      },
      { binding, albumId, source },
    );
    expect(created.rolledBack).toBe(true);
    expect(created.count).toBe(3);
    await context.close();
    context = undefined;
    running = await launch();
    context = running.browser;
    const recovered = await running.page.evaluate(
      async ({ binding, ids, albumId, cancelId }) => {
        const q: typeof import('../src/queue') = await import(
          chrome.runtime.getURL('queue-test.js')
        );
        const tasks = await q.listCaptures(binding);
        const bytes = await Promise.all(
          ids.slice(0, 2).map(async (id) => (await q.captureBlob(id))?.text()),
        );
        const claims = await Promise.all(
          ['one', 'two', 'three'].map((owner) =>
            q.claimCapture(binding, owner),
          ),
        );
        const claimed = claims.filter(
          (value): value is NonNullable<typeof value> => value !== null,
        );
        let savedFile: string | undefined;
        const settle = async (task: NonNullable<(typeof claims)[number]>) => {
          if (task.cancelRequested) {
            await q.finishCaptureCancellation(task.id, task.claim!.owner, {
              captureId: task.id,
              status: 'cancelled',
            });
          } else {
            await q.saveCaptureProgress(task.id, task.claim!.owner, {
              state: 'committing',
              offset: task.file?.size ?? 0,
            });
            await q.finishCapture(task.id, task.claim!.owner, {
              captureId: task.id,
              status: 'created',
              kind: task.file ? 'asset' : 'bookmark',
              itemId: albumId,
            });
            if (task.file) savedFile = task.id;
          }
        };
        for (const task of claimed) await settle(task);
        const remaining = await q.claimCapture(binding, 'remaining');
        if (remaining) await settle(remaining);
        const cancelled = (await q.listCaptures(binding)).find(
          (task) => task.id === cancelId,
        )!;
        return {
          ids: tasks.map((task) => task.id),
          bytes,
          claims: claimed.map((task) => task.id),
          source: tasks[0].source.pageUrl,
          removed: (await q.captureBlob(savedFile!)) === null,
          state: (await q.listCaptures(binding)).find(
            (task) => task.id === savedFile,
          )?.state,
          intentSurvived: tasks.find((task) => task.id === cancelId)
            ?.cancelRequested,
          cancelled: cancelled.state,
          cancellationReceipt: cancelled.cancellationReceipt,
          cancelledBytesRemoved: (await q.captureBlob(cancelId)) === null,
        };
      },
      { binding, ids: created.ids, albumId, cancelId: created.cancelId },
    );
    expect([...recovered.ids].sort()).toEqual([...created.ids].sort());
    expect(recovered.bytes).toEqual(['abc', 'def']);
    expect(new Set(recovered.claims).size).toBe(2);
    expect(recovered.source).toBe('https://example.com/page');
    expect(recovered.removed).toBe(true);
    expect(recovered.state).toBe('saved');
    expect(recovered.intentSurvived).toBe(true);
    expect(recovered.cancelled).toBe('cancelled');
    expect(recovered.cancellationReceipt).toEqual({
      captureId: created.cancelId,
      status: 'cancelled',
    });
    expect(recovered.cancelledBytesRemoved).toBe(true);
  } finally {
    await context?.close();
    await rm(temp, { recursive: true, force: true });
  }
});
