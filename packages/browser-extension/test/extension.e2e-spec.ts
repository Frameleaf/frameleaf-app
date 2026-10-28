import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('packaged connection UI pins requests, restricts key storage and clears revoked destinations across pages', async ({}, testInfo) => {
  let revoked = false;
  let redirectTargetHits = 0;
  const requests: string[] = [];
  const fixtureKey = 'synthetic-capture-key';
  const server = createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Synthetic collection page</title><p>Web content</p>');
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
    manifest.permissions.push('scripting');
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
    await options
      .getByLabel('Browser capture key', { exact: true })
      .fill(fixtureKey);
    await options.getByText('Local development', { exact: true }).click();
    await options.getByLabel('Allow HTTP on this computer only').check();
    await options
      .getByRole('button', { name: 'Connect server', exact: true })
      .click();
    await expect(options.getByText('Connected', { exact: true })).toBeVisible();
    await expect(
      options.getByText('1 writable album available.'),
    ).toBeVisible();
    await expect(
      options.getByLabel('Browser capture key', { exact: true }),
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
    await expect(popup.getByText('Connected', { exact: true })).toBeVisible();
    revoked = true;
    await popup.reload();
    await expect(
      popup.getByText('Reconnect to continue', { exact: true }),
    ).toBeVisible();
    await expect(
      options.getByText('1 writable album available.'),
    ).not.toBeVisible();
    expect(
      await options.evaluate(
        async (key) =>
          JSON.stringify(await chrome.storage.local.get(null)).includes(key),
        fixtureKey,
      ),
    ).toBe(false);
    revoked = false;
    await options
      .getByLabel('Browser capture key', { exact: true })
      .fill(fixtureKey);
    await options
      .getByRole('button', { name: 'Connect server', exact: true })
      .click();
    await expect(popup.getByText('Connected', { exact: true })).toBeVisible();
    await expect(popup.getByRole('alert')).not.toBeVisible();
    await options.getByLabel('Server address').fill(origin + '/redirect');
    await options
      .getByLabel('Browser capture key', { exact: true })
      .fill(fixtureKey);
    await options
      .getByRole('button', { name: 'Connect server', exact: true })
      .click();
    await expect(options.getByRole('alert')).toContainText(
      'Redirects are not followed',
    );
    expect(redirectTargetHits).toBe(0);
    await options
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await expect(
      options.getByText('Choose where your inspiration will be saved.'),
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
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  }
});
