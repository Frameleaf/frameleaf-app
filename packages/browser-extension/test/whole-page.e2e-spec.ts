import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { build } from 'vite';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Bands of colour every 500 px, with a fixed red bar at the top that must appear once.
const bands = ['rgb(18,69,120)', 'rgb(42,176,111)', 'rgb(200,140,20)'];
const fixture = (height: number, grow = false) =>
  `<title>Whole page fixture</title><style>body{margin:0}#bar{position:fixed;top:0;left:0;right:0;height:60px;background:rgb(220,30,30)}.band{height:500px}${bands
    .map((colour, index) => `.b${index}{background:${colour}}`)
    .join('')}</style><div id="bar"></div><main>${Array.from(
    { length: Math.ceil(height / 500) },
    (_, index) => `<div class="band b${index % 3}"></div>`,
  ).join('')}</main>${
    grow
      ? `<script>addEventListener('scroll',()=>{if(scrollY>100){const d=document.createElement('div');d.className='band b0';document.querySelector('main').append(d)}})</script>`
      : ''
  }`;

test('whole page joins the screens, keeps fixed bars once, cuts at 30,000 px, cancels and falls back cleanly', async () => {
  test.setTimeout(180000);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const height = Number(url.searchParams.get('height') ?? 3000);
    res
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(fixture(height, url.searchParams.has('grow')));
  });
  const temp = await mkdtemp(join(tmpdir(), 'frameleaf-whole-page-'));
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
          entry: resolve(import.meta.dirname, '../src/whole-page-capture.ts'),
          formats: ['es'],
          fileName: () => 'whole-page-test.js',
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

    function capture() {
      return driver.evaluate(async () => {
        const api: typeof import('../src/whole-page-capture') = await import(
          chrome.runtime.getURL('whole-page-test.js')
        );
        return api.takeWholePage(new AbortController().signal);
      });
    }
    async function open(path: string) {
      await content.goto(origin + path);
      await content.evaluate(() => scrollTo(0, 200));
      await content.bringToFront();
    }
    async function restored(page: Page) {
      expect(await page.evaluate(() => scrollY)).toBe(200);
      expect(
        await page.evaluate(
          () => document.getElementById('bar')!.style.visibility,
        ),
      ).toBe('');
      await expect(page.locator('[id^="frameleaf-whole-"]')).toHaveCount(0);
    }
    async function samples(
      dataUrl: string,
      cssHeight: number,
      points: [number, number][],
    ) {
      return driver.evaluate(
        async ({ dataUrl, cssHeight, points }) => {
          const image = await createImageBitmap(
            await (await fetch(dataUrl)).blob(),
          );
          const canvas = new OffscreenCanvas(image.width, image.height);
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          const scale = image.height / cssHeight;
          const result = {
            width: image.width,
            height: image.height,
            pixels: points.map(([x, y]) => [
              ...context.getImageData(
                Math.floor(x * scale),
                Math.floor(y * scale),
                1,
                1,
              ).data,
            ]),
          };
          image.close();
          return result;
        },
        { dataUrl, cssHeight, points },
      );
    }
    const rgb = (colour: string) => [...colour.match(/\d+/g)!.map(Number), 255];

    // A normal page: joined from screens, the fixed bar kept once at the top.
    await open('/page?height=3000');
    const whole = await capture();
    expect(whole.kind).toBe('done');
    if (whole.kind !== 'done') throw new Error();
    expect(whole.discovery.pageUrl).toBe(origin + '/page');
    expect(whole.screenshot.whole).toMatchObject({
      height: 3000,
      pageHeight: 3000,
      cut: false,
      screens: 5,
      keptBars: true,
      reduced: false,
    });
    const shot = await samples(whole.screenshot.dataUrl!, 3000, [
      [640, 20],
      [640, 30],
      [640, 750],
      [640, 1240],
      [640, 1520],
      [640, 2990],
    ]);
    // Headless Chromium may capture at 1x even at DPR 2; the picture keeps the capture's own sharpness.
    expect(shot.height).toBe(Math.round((3000 * shot.width) / 1280));
    // The progress bar sits at the top centre; only the page's red bar is there.
    expect(shot.pixels[0]).toEqual(rgb('rgb(220,30,30)'));
    expect(shot.pixels[1]).toEqual(rgb('rgb(220,30,30)'));
    expect(shot.pixels[2]).toEqual(rgb(bands[1]));
    expect(shot.pixels[3]).toEqual(rgb(bands[2]));
    expect(shot.pixels[4]).toEqual(rgb(bands[0]));
    expect(shot.pixels[5]).toEqual(rgb(bands[2]));
    await restored(content);

    // Cancel from the page with Esc.
    await new Promise((done) => setTimeout(done, 600));
    const cancelling = capture();
    await expect(content.locator('[id^="frameleaf-whole-"]')).toHaveCount(1);
    await content.keyboard.press('Escape');
    expect(await cancelling).toEqual({ kind: 'cancelled' });
    await restored(content);

    // A page that keeps loading more: the page is restored and the other screenshots offered.
    await open('/page?height=3000&grow');
    const growing = capture();
    await expect(content.locator('[id^="frameleaf-whole-offer-"]')).toHaveCount(
      1,
    );
    expect(await content.evaluate(() => scrollY)).toBe(200);
    await content.keyboard.press('Enter');
    expect(await growing).toEqual({ kind: 'fallback', mode: 'visible' });
    await expect(content.locator('[id^="frameleaf-whole-"]')).toHaveCount(0);

    // Taller than 30,000 px: cut there and said so.
    await content.setViewportSize({ width: 1280, height: 1000 });
    await open('/page?height=31000');
    const tall = await capture();
    expect(tall.kind).toBe('done');
    if (tall.kind !== 'done') throw new Error();
    expect(tall.screenshot.whole).toMatchObject({
      height: 30000,
      pageHeight: 31000,
      cut: true,
      screens: 30,
    });
    const cut = await samples(tall.screenshot.dataUrl!, 30000, [[640, 29990]]);
    expect(cut.height).toBeLessThanOrEqual(32000);
    expect(cut.pixels[0]).toEqual(rgb(bands[59 % 3]));
    await restored(content);
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
