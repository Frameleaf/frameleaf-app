import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'vite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('native screenshot pixels follow browser zoom and DPR, with pointer/keyboard selection and clean cancellation', async () => {
  test.setTimeout(60000);
  const server = createServer((_req, res) =>
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        '<title>Owned screenshot fixture</title><style>body{margin:0;height:3000px;background:rgb(18,69,120)}.patch{position:fixed;background:rgb(42,176,111)}#one{left:80px;top:140px;width:200px;height:160px}#two{left:50%;top:50%;width:120px;height:100px}</style><div class="patch" id="one"></div><div class="patch" id="two"></div>',
      ),
  );
  const temp = await mkdtemp(join(tmpdir(), 'frameleaf-screenshot-'));
  let context: BrowserContext | undefined;
  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const extension = join(temp, 'extension');
    await cp(resolve(import.meta.dirname, '../dist'), extension, {
      recursive: true,
    });
    const manifest = JSON.parse(
      await readFile(join(extension, 'manifest.json'), 'utf8'),
    );
    // Isolated owned-profile fixture only: native activeTab toolbar grants remain separate qualification.
    manifest.host_permissions = ['<all_urls>'];
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        target: 'chrome116',
        outDir: extension,
        emptyOutDir: false,
        sourcemap: false,
        lib: {
          entry: resolve(import.meta.dirname, '../src/capture.ts'),
          formats: ['es'],
          fileName: () => 'screenshot-test.js',
        },
      },
    });
    context = await chromium.launchPersistentContext(join(temp, 'profile'), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).hostname;
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${id}/options.html`);
    const content = await context.newPage();
    await content.goto(origin + '/page?private=1#part');
    await content.evaluate(() => scrollTo(0, 200));
    expect(await content.evaluate(() => devicePixelRatio)).toBe(2);
    const tabId = await driver.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)!.id!,
      content.url(),
    );
    let lastCapture = 0;
    async function capture(mode: 'visible' | 'area') {
      const delay = 600 - (Date.now() - lastCapture);
      if (delay > 0) await new Promise((done) => setTimeout(done, delay));
      lastCapture = Date.now();
      return driver.evaluate(async (mode) => {
        const api: typeof import('../src/capture') = await import(
          chrome.runtime.getURL('screenshot-test.js')
        );
        return api.takeScreenshot(mode, new AbortController().signal);
      }, mode);
    }
    async function pixels(
      shot: NonNullable<Awaited<ReturnType<typeof capture>>>,
      selection?: { x: number; y: number; width: number; height: number },
    ) {
      return driver.evaluate(
        async ({ shot, selection }) => {
          const api: typeof import('../src/capture') = await import(
            chrome.runtime.getURL('screenshot-test.js')
          );
          const original = await (await fetch(shot.screenshot.dataUrl!)).blob();
          const bitmap = await createImageBitmap(original);
          const chosen = selection ?? shot.screenshot.selection;
          const expected = api.cropRectangle(
            bitmap,
            shot.screenshot.viewport,
            chosen!,
          );
          bitmap.close();
          const crop = await api.cropCapture(
            original,
            shot.screenshot.viewport,
            chosen,
          );
          const image = await createImageBitmap(crop);
          const canvas = new OffscreenCanvas(image.width, image.height);
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const samples = [
            [1, 1],
            [image.width - 2, 1],
            [1, image.height - 2],
            [image.width - 2, image.height - 2],
            [Math.floor(image.width / 2), Math.floor(image.height / 2)],
          ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
          const size = { width: image.width, height: image.height };
          image.close();
          return { expected, size, samples };
        },
        { shot, selection },
      );
    }
    for (const zoom of [1, 1.25, 2]) {
      await driver.evaluate(
        async ({ tabId, zoom }) => {
          await chrome.tabs.setZoom(tabId, zoom);
        },
        { tabId, zoom },
      );
      await content.bringToFront();
      const visible = await capture('visible');
      expect(visible).not.toBeNull();
      expect(visible!.discovery.pageUrl).toBe(origin + '/page');
      const fixed = await pixels(visible!, {
        x: 100,
        y: 160,
        width: 100,
        height: 80,
      });
      expect(fixed.size).toEqual({
        width: fixed.expected.width,
        height: fixed.expected.height,
      });
      for (const pixel of fixed.samples)
        expect(pixel).toEqual([42, 176, 111, 255]);
      const pending = capture('area');
      await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(1);
      await content.keyboard.press('Shift+ArrowRight');
      await content.keyboard.press('Shift+ArrowDown');
      await content.keyboard.press('Enter');
      for (let i = 0; i < 10; i++)
        await content.keyboard.press('Shift+ArrowRight');
      for (let i = 0; i < 8; i++)
        await content.keyboard.press('Shift+ArrowDown');
      await content.keyboard.press('Enter');
      const area = await pending;
      expect(area?.screenshot.selection).toMatchObject({
        width: 100,
        height: 80,
      });
      await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(0);
      const selected = await pixels(area!);
      expect(selected.size).toEqual({
        width: selected.expected.width,
        height: selected.expected.height,
      });
      for (const pixel of selected.samples)
        expect(pixel).toEqual([42, 176, 111, 255]);
    }
    await driver.evaluate(
      async (tabId) => chrome.tabs.setZoom(tabId, 1),
      tabId,
    );
    await content.bringToFront();
    const pointer = capture('area');
    await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(1);
    await content.mouse.move(100, 160);
    await content.mouse.down();
    await content.mouse.move(200, 240);
    await content.mouse.up();
    const point = await pointer;
    expect(point?.screenshot.selection).toEqual({
      x: 100,
      y: 160,
      width: 100,
      height: 80,
    });
    const cropped = await pixels(point!);
    expect(cropped.size).toEqual({
      width: cropped.expected.width,
      height: cropped.expected.height,
    });
    for (const pixel of cropped.samples)
      expect(pixel).toEqual([42, 176, 111, 255]);
    const cancelled = capture('area');
    await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(1);
    await content.keyboard.press('Escape');
    expect(await cancelled).toBeNull();
    await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(0);
    const removed = capture('area');
    await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(1);
    await content
      .locator('[id^="frameleaf-area-"]')
      .evaluate((node) => node.remove());
    expect(await removed).toBeNull();
    const switched = capture('area');
    await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(1);
    await driver.bringToFront();
    await expect(switched).rejects.toThrow();
    await expect(content.locator('[id^="frameleaf-area-"]')).toHaveCount(0);
  } finally {
    await context?.close();
    if (server.listening) {
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
