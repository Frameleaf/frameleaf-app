import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createChromiumDriver, createWebDriverClassicDriver } from './browser-driver.mjs';

/**
 * A minimal stub speaking just enough of the W3C WebDriver wire protocol to prove
 * `createWebDriverClassicDriver` sends the right requests - not a real geckodriver/safaridriver,
 * which aren't installed in CI (library-qa runs those on real hardware). Records every request it
 * receives so tests can assert on the wire format itself (the proxy capability shape, the
 * execute/sync vs execute/async routing).
 */
async function startStubDriver() {
  const requests = [];
  let sessionCounter = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/session') {
        res.end(JSON.stringify({ value: { sessionId: `s${++sessionCounter}`, capabilities: body.capabilities } }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/element')) {
        res.end(JSON.stringify({ value: { 'element-6066-11e4-a52e-4f735466cecf': 'native-frame' } }));
        return;
      }
      if (req.method === 'POST' && /\/(frame|frame\/parent|element\/native-frame\/click)$/.test(req.url)) {
        res.end(JSON.stringify({ value: null }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/url')) {
        res.end(JSON.stringify({ value: null }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/execute/sync')) {
        res.end(JSON.stringify({ value: { sawScript: body.script, sawArgs: body.args } }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/execute/async')) {
        // Simulate the browser invoking the injected callback with a real result.
        res.end(JSON.stringify({ value: { ok: true, result: { fromCallback: body.args[0] } } }));
        return;
      }
      if (req.method === 'DELETE' && /\/session\/[^/]+$/.test(req.url)) {
        res.end(JSON.stringify({ value: null }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ value: { error: 'unknown command' } }));
    });
  });
  server.listen(0);
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('createChromiumDriver launches with the harness as the proxy server, using an injected chromium', async () => {
  const launches = [];
  const fakeChromium = {
    launch: async (options) => {
      launches.push(options);
      return {
        newPage: async () => ({ goto: async () => {}, evaluate: async () => {}, close: async () => {} }),
        close: async () => {},
      };
    },
  };
  const driver = await createChromiumDriver({
    harnessOrigin: 'http://127.0.0.1:5555',
    args: ['--use-gl=swiftshader'],
    chromium: fakeChromium,
  });
  await driver.close();
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].proxy, { server: 'http://127.0.0.1:5555' });
  assert.deepEqual(launches[0].args, ['--use-gl=swiftshader']);
});

test('creates a session with the harness as the manual proxy target', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({
      endpoint: stub.endpoint,
      harnessOrigin: 'http://127.0.0.1:5555',
    });
    await driver.close();
    const created = stub.requests.find((r) => r.url === '/session');
    assert.deepEqual(created.body.capabilities.alwaysMatch.proxy, {
      proxyType: 'manual',
      httpProxy: '127.0.0.1:5555',
      sslProxy: '127.0.0.1:5555',
      noProxy: [],
    });
  } finally {
    await stub.close();
  }
});

test('merges extra capabilities (e.g. moz:firefoxOptions prefs) alongside the proxy', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({
      endpoint: stub.endpoint,
      harnessOrigin: 'http://127.0.0.1:5555',
      capabilities: { 'moz:firefoxOptions': { prefs: { 'dom.webgpu.enabled': true } } },
    });
    await driver.close();
    const created = stub.requests.find((r) => r.url === '/session');
    assert.deepEqual(created.body.capabilities.alwaysMatch['moz:firefoxOptions'], {
      prefs: { 'dom.webgpu.enabled': true },
    });
  } finally {
    await stub.close();
  }
});

test('navigates via POST .../url with the given url', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    const page = await driver.newPage();
    await page.goto('http://127.0.0.1:5186/effects-matrix');
    await driver.close();
    const nav = stub.requests.find((r) => r.url.endsWith('/url'));
    assert.deepEqual(nav.body, { url: 'http://127.0.0.1:5186/effects-matrix' });
  } finally {
    await stub.close();
  }
});

test('evaluates a plain function via execute/sync', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    const page = await driver.newPage();
    const result = await page.evaluate((n) => n, 42);
    await driver.close();
    assert.deepEqual(result.sawArgs, [42]);
    assert.match(result.sawScript, /^return \(/);
  } finally {
    await stub.close();
  }
});

test('evaluates an async function via execute/async and unwraps the callback result', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    const page = await driver.newPage();
    const result = await page.evaluate(async (n) => n, 7);
    await driver.close();
    assert.deepEqual(result, { fromCallback: 7 });
  } finally {
    await stub.close();
  }
});

test('waitForFunction polls evaluate until it returns truthy, then stops', async () => {
  const stub = await startStubDriver();
  try {
    let call = 0;
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    const page = await driver.newPage();
    page.evaluate = async () => {
      call++;
      return call >= 3;
    };
    await page.waitForFunction(() => true, { interval: 1, timeout: 1000 });
    await driver.close();
    assert.equal(call, 3);
  } finally {
    await stub.close();
  }
});

test('waitForFunction times out with a clear error if the condition never becomes truthy', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    const page = await driver.newPage();
    page.evaluate = async () => false;
    await assert.rejects(
      () => page.waitForFunction(() => false, { interval: 1, timeout: 20 }),
      /waitForFunction timed out/,
    );
    await driver.close();
  } finally {
    await stub.close();
  }
});

test('close() deletes the session exactly once even if called twice', async () => {
  const stub = await startStubDriver();
  try {
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    await driver.close();
    await driver.close();
    const deletes = stub.requests.filter((r) => r.method === 'DELETE');
    assert.equal(deletes.length, 1);
  } finally {
    await stub.close();
  }
});

for (const fail of [false, true]) {
  test(`iframe native command restores parent context after ${fail ? 'failure' : 'success'}`, async () => {
    const stub = await startStubDriver();
    const driver = await createWebDriverClassicDriver({ endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555' });
    try {
      const page = await driver.newPage();
      const run = () => page.inFrame('[data-testid=studio-editor-frame]', async frame => {
        await frame.click('button[aria-label="Set interpolation to Ease Out"]');
        if (fail) throw new Error('oracle failed');
        return frame.evaluate(() => 'native read');
      });
      if (fail) await assert.rejects(run, /oracle failed/);
      else assert.ok(await run());
      const commands = stub.requests.slice(1).map(r => r.url);
      assert.deepEqual(commands.slice(0, 4), ['/session/s1/element', '/session/s1/frame', '/session/s1/element', '/session/s1/element/native-frame/click']);
      assert.equal(commands.at(-1), '/session/s1/frame/parent');
      assert.deepEqual(stub.requests.find(r => r.url === '/session/s1/frame').body, { id: { 'element-6066-11e4-a52e-4f735466cecf': 'native-frame' } });
    } finally { await driver.close(); await stub.close(); }
  });
}

test('Chromium iframe operations use frame context and real page keyboard', async () => {
  const calls = [];
  const frame = { locator: selector => ({ click: async () => calls.push(selector) }), evaluate: async () => 'frame', waitForFunction: async () => {} };
  const driver = await createChromiumDriver({ harnessOrigin: 'http://127.0.0.1:5555', chromium: {
    launch: async () => ({ newContext: async () => ({ newPage: async () => ({
      locator: () => ({ waitFor: async () => {}, elementHandle: async () => ({ contentFrame: async () => frame }) }),
      keyboard: { press: async value => calls.push(value) },
    }) }), close: async () => {} }),
  } });
  try {
    const page = await driver.newPage();
    assert.equal(await page.inFrame('iframe', async f => { await f.click('button'); await f.shortcut('z'); return f.evaluate(() => 'frame'); }), 'frame');
    assert.equal(calls[0], 'button');
    assert.match(calls[1], /(?:Meta|Control)\+z/);
  } finally { await driver.close(); }
});
