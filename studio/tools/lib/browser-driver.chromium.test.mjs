// FL-112: proves the design's own gate - "before any Firefox or Safari row counts, Chromium must
// produce byte-identical reports through the new harness" - using the exact shape every simple
// `*.browser.mjs` matrix script already follows (serve a synthetic entrypoint at a fixed path,
// navigate to it, `page.evaluate` a real module import + computation, collect a JSON report).
// It stands in for the real engine/Vite dev server, which this checkout doesn't vendor (`studio/
// engine` isn't present outside a prepared build) - the point being proven is the *mechanism*
// (proxy-routed override + real-origin module load produces the same bytes as `page.route`), not
// any particular script's real computation, which studio-color/studio-editing own.
//
// Needs a real Chromium binary; skips itself if Playwright can't launch one. Resolves the same
// way the real matrix scripts do - rooted at the prepared engine's own install
// (studio/engine/package.json) - so this actually runs wherever CI's own engine job does; a
// checkout without a prepared engine (studio/engine isn't vendored until `engine.mjs prepare` +
// `npm ci` run) skips it instead of failing, matching the module-level tests in
// browser-driver.test.mjs and cross-browser-harness.test.mjs, which cover the logic without a
// browser at all (studio-editing, FL-112 review, 2026-09-30).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createHarness } from './cross-browser-harness.mjs';
import { createChromiumDriver } from './browser-driver.mjs';

const require = createRequire(new URL('../../engine/package.json', import.meta.url));

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // studio/engine isn't prepared in this checkout - see the module doc above.
}

async function startFakeStudioServer() {
  // Stands in for the real Vite dev server: serves one "module" a matrix script would import.
  const server = http.createServer((req, res) => {
    if (req.url === '/src/fake-matrix-module.mjs') {
      res.setHeader('content-type', 'text/javascript');
      res.end('export const computeReport = () => ({ deterministic: 2 + 2, ranAt: "fake-module" });');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0);
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// The exact pattern every simple matrix script follows: a page.evaluate callback that imports a
// real same-origin module and returns a JSON report. Kept as one shared function so both the
// "current" (page.route) and "harness" paths run the literal same evaluate step.
const evaluateReport = async () => {
  const { computeReport } = await import('/src/fake-matrix-module.mjs');
  return computeReport();
};

async function runCurrentPattern(studioOrigin) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route(studioOrigin + '/fake-matrix', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Fake matrix</title>' }),
    );
    await page.goto(studioOrigin + '/fake-matrix');
    return await page.evaluate(evaluateReport);
  } finally {
    await browser.close();
  }
}

async function runHarnessPattern(studioOrigin) {
  const harness = createHarness({
    upstream: studioOrigin,
    overrides: [
      {
        test: (url) => url.pathname === '/fake-matrix',
        respond: () => ({ contentType: 'text/html', body: '<title>Fake matrix</title>' }),
      },
    ],
  });
  const harnessOrigin = await harness.listen();
  const driver = await createChromiumDriver({ harnessOrigin, chromium });
  try {
    const page = await driver.newPage();
    await page.goto(studioOrigin + '/fake-matrix');
    const report = await page.evaluate(evaluateReport);
    return { report, observations: harness.observations };
  } finally {
    await driver.close();
    await harness.close();
  }
}

test(
  'Chromium produces a byte-identical report through the harness as through direct page.route()',
  { skip: !chromium && 'no Playwright chromium available in this environment' },
  async () => {
    const studio = await startFakeStudioServer();
    try {
      const [current, harnessed] = await Promise.all([
        runCurrentPattern(studio.url),
        runHarnessPattern(studio.url),
      ]);
      assert.deepEqual(harnessed.report, current);
      assert.deepEqual(harnessed.report, { deterministic: 4, ranAt: 'fake-module' });
      // The entrypoint went through the override, the real module load proxied through untouched.
      assert.deepEqual(
        harnessed.observations.map((o) => o.kind),
        ['override', 'proxied'],
      );
    } finally {
      await studio.close();
    }
  },
);
