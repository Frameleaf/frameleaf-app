// FL-112: the thin part of the cross-browser harness - one small interface
// (`launch/newPage/goto/evaluate/close`) that every `*.browser.mjs` matrix script's simple
// entrypoint-and-evaluate pattern needs, implemented once for Playwright (Chromium) and once for
// plain WebDriver classic (geckodriver for real Firefox, safaridriver for real Safari - neither
// speaks Playwright's protocol; see the module doc on cross-browser-harness.mjs for why).
//
// Both implementations route every request through `harnessOrigin` (from
// `cross-browser-harness.mjs`) via the browser's own proxy settings, not a script-level flag -
// Chromium via its `--proxy-server` launch option, WebDriver classic via the standard W3C `proxy`
// capability, which both geckodriver and safaridriver, as W3C-conformant WebDriver
// implementations, accept directly. Neither implementation needs page-level network
// interception, so the interface has none.
import { createRequire } from 'node:module';

/** Actual admitted-host browser profiles; WebKit cannot stand in for Safari. */
export function admittedHostCapabilities(browserName) {
  if (!['chromium', 'firefox', 'safari'].includes(browserName))
    throw new Error(`unsupported admitted-host browser: ${browserName}`);
  return {
    browserName,
    ...(browserName === 'firefox' ? {
      'moz:firefoxOptions': {
        binary: '/Applications/Firefox.app/Contents/MacOS/firefox',
        args: ['-headless'],
        prefs: { 'network.proxy.allow_hijacking_localhost': true },
      },
    } : {}),
  };
}

/**
 * @param {object} options
 * @param {string} options.harnessOrigin - `http://127.0.0.1:<port>` from `harness.listen()`.
 * @param {string[]} [options.args] - extra Chromium launch args (e.g. `chromeLaunchArgs()`).
 * @param {string} [options.channel] - e.g. 'chrome', matching some scripts' `chromium.launch` use.
 * @param {object} [options.chromium] - a resolved `{ launch }` (Playwright's `chromium` export).
 *   Defaults to `require('playwright')` resolved from this file's own location, which is only
 *   ever correct for a caller whose own `node_modules` makes that resolve (the matrix scripts
 *   today instead do `createRequire(new URL('../engine/package.json', import.meta.url))`, rooted
 *   at the vendored engine's own install) - pass it explicitly rather than relying on the default
 *   whenever the caller's own `playwright` doesn't live on this file's resolution path.
 */
export async function createChromiumDriver({ harnessOrigin, args = [], channel, chromium, contextOptions = {} } = {}) {
  if (!chromium) {
    const require = createRequire(import.meta.url);
    ({ chromium } = require('playwright'));
  }
  const browser = await chromium.launch({
    headless: true,
    channel,
    args,
    proxy: { server: harnessOrigin },
  });
  return {
    // `contextOptions` are Playwright browser-context options (e.g. `{ serviceWorkers: 'block' }`);
    // WebDriver classic has no equivalent, so only this driver takes them.
    async newPage() {
      const page = await (await browser.newContext(contextOptions)).newPage();
      return {
        async inFrame(selector, run) {
          const locator = page.locator(selector);
          await locator.waitFor();
          const frame = await (await locator.elementHandle()).contentFrame();
          if (!frame) throw new Error(`iframe unavailable: ${selector}`);
          return run({
            click: (target) => frame.locator(target).click(),
            hover: (target, position) => frame.locator(target).hover({ position }),
            evaluate: (fn, arg) => frame.evaluate(fn, arg),
            waitForFunction: (fn, options) => frame.waitForFunction(fn, undefined, options),
            shortcut: (key, shift = false) => page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+${shift ? 'Shift+' : ''}${key}`),
          });
        },
        goto: (url) => page.goto(url),
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        waitForFunction: (fn, options) => page.waitForFunction(fn, undefined, options),
        click: (selector) => page.locator(selector).click(),
        fill: (selector, value) => page.locator(selector).fill(value),
        screenshot: async () => (await page.screenshot()).toString('base64'),
        async shortcut(key, shift = false) {
          const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
          await page.keyboard.press(`${modifier}+${shift ? 'Shift+' : ''}${key}`);
        },
        async drag(from, to) {
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 10 });
          await page.mouse.up();
        },
        close: () => page.close(),
      };
    },
    close: () => browser.close(),
  };
}

/** Polls `evaluate(fn)` (WebDriver classic has no native wait-for-condition) until it's truthy. */
async function pollForFunction(evaluate, fn, { timeout = 30_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await evaluate(fn)) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForFunction timed out after ${timeout}ms: ${fn.toString()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const w3cSuccess = async (response) => {
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`WebDriver error ${response.status}: ${JSON.stringify(body)}`);
  }
  return body.value;
};

/**
 * A plain WebDriver classic (W3C) client, for geckodriver or safaridriver - neither has anything
 * like Playwright's `browser`/`context`/`page` model, so this exposes exactly what the matrix
 * scripts' simple pattern needs and nothing more: one browsing context per session.
 *
 * @param {object} options
 * @param {string} options.endpoint - the running driver's own base URL, e.g. http://127.0.0.1:4444
 *   for geckodriver, http://127.0.0.1:4445 for safaridriver.
 * @param {string} options.harnessOrigin - proxied via the W3C `proxy` capability, not a launch arg
 *   - safaridriver has no launch-arg equivalent, so this is the one mechanism that works for both.
 * @param {object} [options.capabilities] - merged into `capabilities.alwaysMatch`, e.g.
 *   `{ 'moz:firefoxOptions': { prefs: { 'dom.webgpu.enabled': true, 'network.proxy.allow_hijacking_localhost': true } } }`.
 */
export async function createWebDriverClassicDriver({ endpoint, harnessOrigin, capabilities = {} } = {}) {
  const harness = new URL(harnessOrigin);
  const hostPort = `${harness.hostname}:${harness.port}`;
  const session = await w3cSuccess(
    await fetch(`${endpoint}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            proxy: { proxyType: 'manual', httpProxy: hostPort, sslProxy: hostPort, noProxy: [] },
            ...capabilities,
          },
        },
      }),
    }),
  );
  const sessionId = session.sessionId;
  const call = (path, init) => fetch(`${endpoint}/session/${sessionId}${path}`, init).then(w3cSuccess);
  let closed = false;
  return {
    // One session, one browsing context: newPage() just hands back the same session-bound page,
    // matching the "launch once, script one page" shape every matrix script already uses.
    async newPage() {
      const element = async (selector) => {
        const found = await call('/element', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ using: 'css selector', value: selector }),
        });
        return found['element-6066-11e4-a52e-4f735466cecf'];
      };
      const elementCommand = async (selector, command, body = {}) => call(`/element/${await element(selector)}/${command}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const page = {
        async inFrame(selector, run) {
          const id = await element(selector);
          await call('/frame', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: { 'element-6066-11e4-a52e-4f735466cecf': id } }),
          });
          try { return await run(page); }
          finally { await call('/frame/parent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); }
        },
        screenshot: () => call('/screenshot', { method: 'GET' }),
        shortcut: (key, shift = false) => {
          const modifier = String(session.capabilities?.platformName).toLowerCase().includes('mac') ? '\uE03D' : '\uE009';
          return call('/actions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions: [{ type: 'key', id: 'fixture-shortcut', actions: [
              { type: 'keyDown', value: modifier },
              ...(shift ? [{ type: 'keyDown', value: '\uE008' }] : []),
              { type: 'keyDown', value: key }, { type: 'keyUp', value: key },
              ...(shift ? [{ type: 'keyUp', value: '\uE008' }] : []),
              { type: 'keyUp', value: modifier },
            ] }] }),
          });
        },
        drag: (from, to) => call('/actions', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actions: [{ type: 'pointer', id: 'fixture-mouse', parameters: { pointerType: 'mouse' }, actions: [
            { type: 'pointerMove', origin: 'viewport', x: Math.round(from.x), y: Math.round(from.y), duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', origin: 'viewport', x: Math.round(to.x), y: Math.round(to.y), duration: 200 },
            { type: 'pointerUp', button: 0 },
          ] }] }),
        }),
        click: (selector) => elementCommand(selector, 'click'),
        // W3C element-origin offsets are measured from the element's center, not its top-left.
        async hover(selector, position) {
          const id = await element(selector);
          const rect = await call(`/element/${id}/rect`, { method: 'GET' });
          return call('/actions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions: [{ type: 'pointer', id: 'fixture-mouse', parameters: { pointerType: 'mouse' }, actions: [
              { type: 'pointerMove', origin: { 'element-6066-11e4-a52e-4f735466cecf': id },
                x: Math.round(position.x - rect.width / 2), y: Math.round(position.y - rect.height / 2), duration: 0 },
            ] }] }),
          });
        },
        async fill(selector, value) {
          // WebDriver clear does not produce React's native input sequence. Replace the value
          // with real select-all/delete/type keys so controlled inputs see the user's edit.
          const modifier = String(session.capabilities?.platformName).toLowerCase().includes('mac') ? '\uE03D' : '\uE009';
          await elementCommand(selector, 'value', { text: '' });
          const key = (value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }];
          await call('/actions', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actions: [{ type: 'key', id: 'fixture-keyboard', actions: [
              { type: 'keyDown', value: modifier }, ...key('a'), { type: 'keyUp', value: modifier },
              ...key('\uE003'), ...[...value].flatMap(key),
            ] }] }),
          });
        },
        goto: (url) =>
          call('/url', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
          }),
        // Matches Playwright's `page.evaluate(fn, arg)` contract closely enough for the matrix
        // scripts' pattern - `fn` must be a plain (non-closure) function either way, exactly as
        // Playwright's own `page.evaluate` already requires. An async `fn` (every matrix script's
        // real evaluate callback is `async (...) => {...}`) needs W3C's `execute/async`: the
        // script must itself call the injected completion callback, since `execute/sync` cannot
        // wait on a returned promise.
        evaluate: (fn, arg) =>
          fn.constructor.name === 'AsyncFunction'
            ? call('/execute/async', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  script: [
                    'const callback = arguments[arguments.length - 1];',
                    `(${fn.toString()})(arguments[0]).then(`,
                    '  (result) => callback({ ok: true, result }),',
                    '  (error) => callback({ ok: false, error: String((error && error.stack) || error) }),',
                    ');',
                  ].join('\n'),
                  args: [arg],
                }),
              }).then((outcome) => {
                if (!outcome.ok) throw new Error(outcome.error);
                return outcome.result;
              })
            : call('/execute/sync', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ script: `return (${fn.toString()})(arguments[0])`, args: [arg] }),
              }),
        close: () => {}, // session-scoped; real cleanup happens in the driver's own close()
      };
      page.waitForFunction = (fn, options) => pollForFunction((f) => page.evaluate(f), fn, options);
      return page;
    },
    async close() {
      if (closed) return;
      closed = true;
      await fetch(`${endpoint}/session/${sessionId}`, { method: 'DELETE' });
    },
  };
}
