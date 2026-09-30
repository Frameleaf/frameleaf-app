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
export async function createChromiumDriver({ harnessOrigin, args = [], channel, chromium } = {}) {
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
    async newPage() {
      const page = await browser.newPage();
      return {
        goto: (url) => page.goto(url),
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        waitForFunction: (fn, options) => page.waitForFunction(fn, undefined, options),
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
      const page = {
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
