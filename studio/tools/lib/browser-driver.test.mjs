import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { admittedHostCapabilities, createChromiumDriver, createWebDriverClassicDriver } from './browser-driver.mjs';
import { assertNoProxyErrors, openPage } from '../resource-admission.browser.mjs';

/**
 * A minimal stub speaking just enough of the W3C WebDriver wire protocol to prove
 * `createWebDriverClassicDriver` sends the right requests - not a real geckodriver/safaridriver,
 * which aren't installed in CI (library-qa runs those on real hardware). Records every request it
 * receives so tests can assert on the wire format itself (the proxy capability shape, the
 * execute/sync vs execute/async routing).
 */
async function startStubDriver({rect = {x: 10, y: 20, width: 200, height: 20}, viewport = {width: 500, height: 400}, userAgent} = {}) {
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
      if (req.method === 'GET' && req.url.endsWith('/element/native-frame/rect')) {
        res.end(JSON.stringify({ value: rect }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/url')) {
        res.end(JSON.stringify({ value: null }));
        return;
      }
      if (req.method === 'POST' && req.url.endsWith('/execute/sync')) {
        if (userAgent && body.script.includes('navigator.userAgent')) {
          res.end(JSON.stringify({value: userAgent}));
          return;
        }
        if (body.args[0]?.selector && body.args[0]?.position) {
          try {
            const value = runInNewContext(`(() => { ${body.script} })()`, {
              arguments: body.args, innerWidth: viewport.width, innerHeight: viewport.height,
              document: {querySelector: () => ({getClientRects: () => rect ? [rect] : []})},
            });
            res.end(JSON.stringify({value}));
          } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({value: {error: 'javascript error', message: error.message}}));
          }
          return;
        }
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

test('admitted host selects actual Safari and Firefox without leaking Firefox options or accepting WebKit', async () => {
  const stub = await startStubDriver();
  try {
    for (const browser of ['safari', 'firefox']) {
      const driver = await createWebDriverClassicDriver({
        endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555',
        capabilities: admittedHostCapabilities(browser),
      });
      try {
        await (await driver.newPage()).goto('http://127.0.0.1:5186/studio?project=fixture');
      } finally { await driver.close(); }
      const request = stub.requests.filter(r => r.url === '/session').at(-1);
      const capabilities = request.body.capabilities.alwaysMatch;
      assert.equal(capabilities.browserName, browser);
      assert.equal(capabilities.proxy.httpProxy, '127.0.0.1:5555');
      if (browser === 'safari') assert.equal(capabilities['moz:firefoxOptions'], undefined);
      else assert.deepEqual(capabilities['moz:firefoxOptions'], {
        binary: '/Applications/Firefox.app/Contents/MacOS/firefox', args: ['-headless'],
        prefs: { 'network.proxy.allow_hijacking_localhost': true },
      });
    }
    assert.equal(stub.requests.filter(r => r.method === 'DELETE').length, 2);
    assert.deepEqual(admittedHostCapabilities('chromium'), { browserName: 'chromium' });
    for (const browser of ['webkit', 'chrome', 'unknown'])
      assert.throws(() => admittedHostCapabilities(browser), /unsupported admitted-host browser/);
  } finally { await stub.close(); }
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

test('classic evaluation preserves omitted defaults, explicit null and zero in sync and async callbacks', async () => {
  const stub = await startStubDriver();
  const driver = await createWebDriverClassicDriver({endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555'});
  try {
    const page = await driver.newPage();
    for (const callback of [(value = 1200) => value, async (value = 1200) => value]) {
      for (const arg of [undefined, null, 0]) {
        await page.evaluate(callback, arg);
        const {script, args} = stub.requests.at(-1).body;
        const async = callback.constructor.name === 'AsyncFunction';
        const execute = (arguments_) => runInNewContext(`(function() { ${script} }).apply(null, args)`, {args: arguments_});
        const outcome = async ? await new Promise(resolve => execute([...args, resolve])) : execute(args);
        assert.equal(async ? outcome.result : outcome, arg === undefined ? 1200 : arg);
      }
    }
  } finally {
    await driver.close();
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

test('Chromium iframe hover uses the native locator position without forced events', async () => {
  const calls = [];
  const nativeFrame = { locator: selector => ({ hover: async options => calls.push({selector, options}) }) };
  const driver = await createChromiumDriver({ harnessOrigin: 'http://127.0.0.1:5555', chromium: {
    launch: async () => ({ newContext: async () => ({ newPage: async () => ({
      locator: () => ({ waitFor: async () => {}, elementHandle: async () => ({ contentFrame: async () => nativeFrame }) }),
    }) }), close: async () => {} }),
  } });
  try {
    const page = await driver.newPage();
    await page.inFrame('iframe', frame => frame.hover('[data-testid="dopesheet-ruler"]', {x: 50, y: 8}));
    assert.deepEqual(calls, [{selector:'[data-testid="dopesheet-ruler"]', options:{position:{x:50,y:8}}}]);
  } finally { await driver.close(); }
});

test('Chromium iframe inputs and background clicks preserve native locator options', async () => {
  const calls = [];
  const nativeFrame = { locator: selector => ({
    fill: async value => calls.push({selector, value}),
    click: async options => calls.push({selector, options}),
  }) };
  const driver = await createChromiumDriver({ harnessOrigin: 'http://127.0.0.1:5555', chromium: {
    launch: async () => ({ newContext: async () => ({ newPage: async () => ({
      locator: () => ({ waitFor: async () => {}, elementHandle: async () => ({ contentFrame: async () => nativeFrame }) }),
    }) }), close: async () => {} }),
  } });
  try {
    await (await driver.newPage()).inFrame('iframe', async frame => {
      await frame.fill('input[aria-label="Position X"]', '12');
      await frame.click('[aria-label="Video Preview"]', {position: {x: 5, y: 5}});
    });
    assert.deepEqual(calls, [
      {selector: 'input[aria-label="Position X"]', value: '12'},
      {selector: '[aria-label="Video Preview"]', options: {position: {x: 5, y: 5}}},
    ]);
  } finally { await driver.close(); }
});

test('WebDriver positioned iframe click uses pointer down/up and restores frame on refusal', async () => {
  for (const clipped of [false, true]) {
  const stub = await startStubDriver(clipped ? {rect: {x: 100, y: 120, width: 700, height: 450}} : {});
  const driver = await createWebDriverClassicDriver({endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555'});
  try {
    const page = await driver.newPage();
    await assert.rejects(page.inFrame('iframe', frame => frame.click('[aria-label="Video Preview"]', {position: {x: 5, y: 5}})), /unknown command/);
    const action = stub.requests.find(r => r.url.endsWith('/actions'));
    assert.deepEqual(action.body.actions[0].actions, [
      {type: 'pointerMove', origin: {'element-6066-11e4-a52e-4f735466cecf': 'native-frame'}, x: clipped ? -195 : -95, y: clipped ? -135 : -5, duration: 0},
      {type: 'pointerDown', button: 0}, {type: 'pointerUp', button: 0},
    ]);
    assert.equal(stub.requests.at(-1).url, '/session/s1/frame/parent');
  } finally { await driver.close(); await stub.close(); }
  }
});

test('WebDriver native iframe hover reaches the same point when clipped and restores frame on action refusal', async () => {
  for (const width of [200, 700]) {
    const stub = await startStubDriver({rect: {x: 100, y: 40, width, height: 40}, viewport: {width: 500, height: 200}});
    const driver = await createWebDriverClassicDriver({endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555'});
    try {
      const page = await driver.newPage();
      await assert.rejects(page.inFrame('iframe', frame => frame.hover('[data-testid="dopesheet-ruler"]', {x: 50, y: 8})), /unknown command/);
      const action = stub.requests.find(r => r.url.endsWith('/actions'));
      assert.ok(action, 'native pointer actions required');
      assert.deepEqual(action.body.actions, [{type: 'pointer', id: 'fixture-mouse', parameters: {pointerType: 'mouse'}, actions: [{
        type: 'pointerMove', origin: {'element-6066-11e4-a52e-4f735466cecf': 'native-frame'}, x: width === 200 ? -50 : -150, y: -12, duration: 0,
      }]}]);
      // The native fixture's visible centers are 200 and 300; both inputs must land at (150, 48).
      const offset = action.body.actions[0].actions[0];
      assert.equal((width === 200 ? 200 : 300) + offset.x, 150);
      assert.equal(60 + offset.y, 48);
      assert.equal(stub.requests.at(-1).url, '/session/s1/frame/parent');
    } finally { await driver.close(); await stub.close(); }
  }
});

test('WebDriver iframe hover refuses invisible or unrendered targets without actions and restores frame', async () => {
  for (const {rect, position, error} of [
    {rect: {x: 100, y: 40, width: 700, height: 40}, position: {x: 450, y: 8}, error: /hover point must be visible/},
    {rect: {x: 100, y: 40, width: 700, height: 40}, position: {x: 50, y: 170}, error: /hover point must be visible/},
    {rect: null, position: {x: 50, y: 8}, error: /hover requires a rendered element/},
  ]) {
    const stub = await startStubDriver({rect, viewport: {width: 500, height: 200}});
    const driver = await createWebDriverClassicDriver({endpoint: stub.endpoint, harnessOrigin: 'http://127.0.0.1:5555'});
    try {
      const page = await driver.newPage();
      await assert.rejects(page.inFrame('iframe', frame => frame.hover('[data-testid="dopesheet-ruler"]', position)), error);
      assert.ok(!stub.requests.some(r => r.url.endsWith('/actions')), 'invalid hover must send no pointer input');
      assert.equal(stub.requests.at(-1).url, '/session/s1/frame/parent');
    } finally { await driver.close(); await stub.close(); }
  }
});

for (const browser of ['firefox', 'safari']) test(`resource admission selects actual ${browser} without loading Chromium`, async () => {
  const userAgent = browser === 'firefox' ? 'Mozilla/5.0 Firefox/157.0' : 'Mozilla/5.0 Version/26.0 Safari/605.1.15';
  const stub = await startStubDriver({userAgent});
  try {
    const session = await openPage('http://127.0.0.1:5555', 'block', {browser, endpoint: stub.endpoint,
      chromium: {launch: () => {throw new Error('classic dispatch loaded Chromium');}}});
    try {
      await session.page.goto('http://127.0.0.1:5186/headless.html');
      assert.deepEqual(session.browser, {name: browser, driver: 'webdriver-classic', userAgent});
      const caps = stub.requests.find(r => r.url === '/session').body.capabilities.alwaysMatch;
      assert.equal(caps.browserName, browser);
      assert.deepEqual(caps.proxy, {proxyType: 'manual', httpProxy: '127.0.0.1:5555', sslProxy: '127.0.0.1:5555', noProxy: []});
      assert.deepEqual(caps.timeouts, {script: 300_000});
      if (browser === 'safari') assert.ok(!Object.hasOwn(caps, 'moz:firefoxOptions'));
      else assert.equal(caps['moz:firefoxOptions'].prefs['dom.webgpu.enabled'], true);
    } finally {await session.close();}
    assert.equal(stub.requests.at(-1).method, 'DELETE');
  } finally {await stub.close();}
});

test('resource admission retains Chromium context policy and closes a failed page', async () => {
  for (const failure of [false, true]) {
    const contexts = [];
    let closed = 0;
    const session = openPage('http://127.0.0.1:5555', 'block', {chromium: {launch: async options => {
      assert.deepEqual(options.proxy, {server: 'http://127.0.0.1:5555'});
      return {newContext: async options => {
        contexts.push(options);
        return {newPage: async () => {
          if (failure) throw new Error('page failed');
          return {evaluate: async () => 'Chrome/140.0 Safari/537.36'};
        }};
      }, close: async () => {closed++;}};
    }}});
    if (failure) await assert.rejects(session, /page failed/);
    else {
      const opened = await session;
      assert.equal(opened.browser.driver, 'playwright');
      await opened.close();
    }
    assert.deepEqual(contexts, [{serviceWorkers: 'block'}]);
    assert.equal(closed, 1);
  }
});

test('resource admission refuses missing classic endpoints, unsupported aliases and false browser provenance', async () => {
  for (const browser of ['firefox', 'safari']) {
    await assert.rejects(openPage('http://127.0.0.1:5555', 'block', {browser}), /requires WEBDRIVER_ENDPOINT/);
    const stub = await startStubDriver({userAgent: 'Chrome/140.0 Safari/537.36'});
    try {
      await assert.rejects(openPage('http://127.0.0.1:5555', 'block', {browser, endpoint: stub.endpoint}), /did not report the requested browser/);
      assert.equal(stub.requests.at(-1).method, 'DELETE');
    } finally {await stub.close();}
  }
  for (const browser of ['webkit', 'chrome', 'unknown'])
    await assert.rejects(openPage('http://127.0.0.1:5555', 'block', {browser}), /unsupported admitted-host browser/);
});

test('resource admission requires a transparent proxied entry GET before absence can count', () => {
  const origin = 'http://127.0.0.1:5186';
  const request = {method: 'GET', kind: 'proxied', url: origin + '/headless.html'};
  assertNoProxyErrors({observations: [request]}, origin, '/headless.html');
  assert.throws(() => assertNoProxyErrors({observations: [request,
    {method: 'CONNECT', kind: 'tunnelled', url: '127.0.0.1:5186'}]}, origin, '/headless.html'), /opaque CONNECT/);
  for (const observations of [[], [{method: 'CONNECT', kind: 'tunnelled', url: '127.0.0.1:5186'}],
    [{...request, method: 'POST'}], [{...request, kind: 'override'}], [{...request, kind: 'blocked'}],
    [{...request, url: origin + '/'}], [{...request, url: 'http://127.0.0.1:5187/headless.html'}]])
    assert.throws(() => assertNoProxyErrors({observations}, origin, '/headless.html'), /no transparent browser GET|opaque CONNECT/);
  assert.throws(() => assertNoProxyErrors({observations: [request, {kind: 'error'}]}, origin, '/headless.html'), /could not reach/);
});

test('native control and geometry runners admit Safari dispatch and refuse unsupported or incomplete input before launch', () => {
  for (const name of ['editor-controls', 'auto-key-control', 'easing-control', 'boundary-hit', 'linked-edit-axis']) {
    for (const browser of ['safari', 'firefox', 'webkit']) {
      const result = spawnSync(process.execPath, [new URL(`../${name}.browser.mjs`, import.meta.url).pathname], {
        env: {...process.env, BROWSER: browser, WEBDRIVER_ENDPOINT: ''}, encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, browser === 'webkit' ? /unsupported admitted-host browser/ : /requires WEBDRIVER_ENDPOINT/, name);
    }
  }
});
