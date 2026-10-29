import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packaged connection UI pins requests, restricts key storage and clears revoked destinations across pages', async ({}, testInfo) => {
  let revoked = false;
  let redirectTargetHits = 0;
  let mediaHits = 0;
  const mediaRequests: {
    cookie?: string;
    authorization?: string;
    key?: string;
    referrer?: string;
  }[] = [];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#2ab06f"/></svg>';
  const requests: string[] = [];
  const fixtureKey = 'synthetic-capture-key';
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<title>Synthetic collection page</title><p>Web content</p><img src="${'data:image/svg+xml,' + encodeURIComponent(svg)}"><img src="/images/small.png" srcset="/images/large.png?transient=private 2000w"><div style="background-image:url('/images/background.webp')"></div>${Array.from({ length: 105 }, (_, index) => `<img src="/images/${index}.png?transient=private">`).join('')}`,
      );
      return;
    }
    if (req.url?.startsWith('/images/')) {
      mediaHits++;
      mediaRequests.push({
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        key: req.headers['x-api-key'] as string | undefined,
        referrer: req.headers.referer,
      });
      if (req.url.startsWith('/images/104.png')) res.writeHead(403).end();
      else if (req.url.startsWith('/images/103.png'))
        res.writeHead(302, { Location: '/must-not-follow' }).end();
      else res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svg);
      return;
    }
    if (req.url === '/redirect/api/capture/capabilities') {
      res.writeHead(302, { Location: '/must-not-follow' }).end();
      return;
    }
    if (req.url === '/must-not-follow') {
      redirectTargetHits++;
      res.writeHead(500).end();
      return;
    }
    if (req.headers['x-api-key'] !== fixtureKey) {
      res.writeHead(401).end();
      return;
    }
    requests.push(req.url!);
    if (revoked) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/frameleaf/api/capture/capabilities')
      res.end(
        JSON.stringify({
          version: 1,
          captureSupported: true,
          serverId: 'fixture-server',
          userId: '11111111-1111-4111-8111-111111111111',
          maxFileBytes: 104857600,
        }),
      );
    else if (req.url === '/frameleaf/api/capture/catalog')
      res.end(
        JSON.stringify({
          albums: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              albumName: 'Inspiration',
              parentId: null,
            },
          ],
          tags: [],
        }),
      );
    else res.writeHead(404).end();
  });
  const temp = await mkdtemp(join(tmpdir(), 'frameleaf-extension-'));
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
    // Pregrant only the synthetic server; native permission prompts are a separate browser gate.
    manifest.host_permissions = ['http://127.0.0.1/*'];
    await writeFile(
      join(extensionPath, 'manifest.json'),
      JSON.stringify(manifest),
    );
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
    console.info(
      'Bundled Chromium:',
      context.browser()?.version() ??
        (await worker.evaluate(() => navigator.userAgent)),
    );
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByLabel('Server address').fill(origin + '/frameleaf');
    await options.getByLabel('Browser key', { exact: true }).fill(fixtureKey);
    await options
      .getByRole('switch', { name: /Allow a local server without HTTPS/ })
      .check();
    await options.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      options.getByRole('heading', { name: 'Settings', exact: true }),
    ).toBeVisible();
    await expect(options.getByText('1 you can save into')).toBeVisible();
    await expect(
      options.getByLabel('Browser key', { exact: true }),
    ).toHaveValue('');
    expect(requests).toContain('/frameleaf/api/capture/catalog');
    await options.screenshot({
      path: testInfo.outputPath('connection.png'),
      fullPage: true,
    });
    const content = await context.newPage();
    await content.goto(origin + '/page');
    const requestCount = requests.length;
    const untrusted = await worker.evaluate(async (pageUrl) => {
      const tab = (await chrome.tabs.query({})).find(
        (tab) => tab.url === pageUrl,
      );
      if (!tab?.id) throw new Error('Synthetic content tab missing');
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          let storageDenied = false;
          try {
            await chrome.storage.local.get(null);
          } catch {
            storageDenied = true;
          }
          return {
            storageDenied,
            reply: await chrome.runtime.sendMessage({ type: 'status' }),
          };
        },
      });
      return injected.result;
    }, origin + '/page');
    if (!untrusted) throw new Error('Content-script probe returned no result');
    expect(untrusted).toMatchObject({
      storageDenied: true,
      reply: { ok: false },
    });
    expect(untrusted.reply).not.toHaveProperty('connection');
    expect(requests.length).toBe(requestCount);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      popup.getByRole('button', { name: 'Find images on this page' }),
    ).toBeVisible();
    await content.waitForLoadState('networkidle');
    const beforeCollection = mediaHits;
    const initialRedirectHits = redirectTargetHits;
    await content.bringToFront();
    const collectionOpened = context.waitForEvent('page', { timeout: 5000 });
    const discovered = await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: 'discover' }),
    );
    expect(discovered).toMatchObject({ ok: true });
    const collection = await collectionOpened;
    await expect(
      collection.getByRole('heading', { name: 'Save images', exact: true }),
    ).toBeVisible();
    await expect(
      collection.getByText('Synthetic collection page', { exact: true }),
    ).toBeVisible();
    const images = collection
      .getByRole('region', { name: 'Discovered images' })
      .getByRole('checkbox');
    expect(await images.count()).toBeGreaterThan(100);
    await images.first().focus();
    await images.first().press('Space');
    await expect(images.first()).toBeChecked();
    for (let index = 1; index < 100; index++) await images.nth(index).check();
    await expect(collection.getByRole('status')).toContainText(
      '100 of 100 selected',
    );
    await expect(images.nth(100)).toBeDisabled();
    await collection.getByRole('button', { name: 'Clear selection' }).click();
    await expect(collection.getByRole('status')).toContainText(
      '0 of 100 selected',
    );
    await collection.getByLabel('At least').selectOption('1600');
    await collection.getByRole('radio', { name: 'PNG', exact: true }).check();
    await expect(images).toHaveCount(1);
    await collection.getByRole('button', { name: /^Save to/ }).click();
    await collection
      .getByRole('group', { name: 'Collections' })
      .getByRole('button')
      .first()
      .click();
    await expect(
      collection.getByRole('button', { name: /^Save to Choose/ }),
    ).toHaveCount(0);
    await collection
      .getByLabel('Note', { exact: true })
      .fill('Synthetic reference');
    await expect(collection.locator('body')).not.toContainText(
      'transient=private',
    );
    await expect(
      collection.getByText(/^Previews aren’t loaded yet, so 127\.0\.0\.1/),
    ).toBeVisible();
    expect(mediaHits).toBe(beforeCollection);
    await context.addCookies([
      {
        name: 'private-browser-cookie',
        value: 'must-not-forward',
        url: origin,
        httpOnly: true,
      },
    ]);
    await collection
      .getByRole('button', { name: `Preview from ${origin}`, exact: true })
      .click();
    await expect(collection.locator('.candidate-thumbnail')).toBeVisible();
    await expect
      .poll(() =>
        collection
          .locator('.candidate-thumbnail')
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    expect(mediaHits).toBe(beforeCollection + 1);
    expect(mediaRequests.at(-1)).toEqual({
      cookie: undefined,
      authorization: undefined,
      key: undefined,
      referrer: undefined,
    });
    await collection
      .getByRole('button', { name: 'Clear loaded previews', exact: true })
      .click();
    await expect(collection.locator('.candidate-thumbnail')).toHaveCount(0);
    await collection
      .getByRole('button', { name: `Preview from ${origin}`, exact: true })
      .click();
    await expect(collection.locator('.candidate-thumbnail')).toBeVisible();

    await collection.screenshot({
      path: testInfo.outputPath('collection.png'),
      fullPage: true,
    });
    await collection.setViewportSize({ width: 390, height: 844 });
    expect(
      await collection.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await collection.screenshot({
      path: testInfo.outputPath('collection-narrow.png'),
      fullPage: true,
    });
    await collection.getByLabel('At least').selectOption('0');
    await collection.getByRole('radio', { name: 'All', exact: true }).check();
    const embedded = collection
      .locator('.candidate-list li')
      .filter({ hasText: 'Embedded image' });
    await embedded
      .getByRole('button', { name: 'Preview from this page', exact: true })
      .click();
    await expect(embedded.locator('.candidate-thumbnail')).toBeVisible();
    await expect
      .poll(() =>
        embedded
          .locator('.candidate-thumbnail')
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    const protectedImage = collection
      .locator('.candidate-list li')
      .filter({ hasText: '/images/104.png' });
    await protectedImage
      .getByRole('button', { name: `Preview from ${origin}`, exact: true })
      .click();
    await expect(protectedImage.getByRole('alert')).toContainText(
      'requires access',
    );
    const redirectedImage = collection
      .locator('.candidate-list li')
      .filter({ hasText: '/images/103.png' });
    await redirectedImage
      .getByRole('button', { name: `Preview from ${origin}`, exact: true })
      .click();
    await expect(redirectedImage.getByRole('alert')).toContainText('Redirects');
    expect(redirectTargetHits).toBe(initialRedirectHits);
    const loadedObjectUrl = await embedded
      .locator('.candidate-thumbnail')
      .getAttribute('src');
    revoked = true;
    await popup.reload();
    await expect(
      popup.getByRole('heading', {
        name: 'This browser key was removed',
        exact: true,
      }),
    ).toBeVisible();
    await expect(options.getByText('1 you can save into')).not.toBeVisible();
    await expect(collection.getByRole('alert')).toContainText('expired');
    expect(
      await collection.evaluate(
        async (url) =>
          fetch(url!).then(
            () => false,
            () => true,
          ),
        loadedObjectUrl,
      ),
    ).toBe(true);
    await expect(
      collection.getByLabel('Note', { exact: true }),
    ).not.toBeVisible();
    expect(
      await options.evaluate(
        async (key) =>
          JSON.stringify(await chrome.storage.local.get(null)).includes(key),
        fixtureKey,
      ),
    ).toBe(false);
    revoked = false;
    await options.getByLabel('Browser key', { exact: true }).fill(fixtureKey);
    await options
      .getByRole('button', { name: 'Connect again', exact: true })
      .click();
    await expect(
      popup.getByRole('button', { name: 'Find images on this page' }),
    ).toBeVisible();
    await expect(popup.getByRole('alert')).not.toBeVisible();
    await options.getByText('Use a different server or key').click();
    await options.getByLabel('Server address').fill(origin + '/redirect');
    await options.getByLabel('Browser key', { exact: true }).fill(fixtureKey);
    await options.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(options.getByRole('alert')).toContainText(
      'Redirects are not followed',
    );
    expect(redirectTargetHits).toBe(initialRedirectHits);
    await options
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await expect(
      options.getByText(
        'Connect to your Frameleaf server to save images, links and screenshots into Boards.',
      ),
    ).toBeVisible();
    expect(
      await options.evaluate(async () =>
        Object.keys(await chrome.storage.local.get(null)),
      ),
    ).toEqual([]);
  } finally {
    try {
      await context?.close();
    } finally {
      if (server.listening) {
        const closed = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        server.closeAllConnections();
        await closed;
      }
      await rm(temp, { recursive: true, force: true });
    }
  }
});
