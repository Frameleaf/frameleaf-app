import assert from 'node:assert/strict';
import test from 'node:test';
import { withEffectsMatrixPage } from './effects-matrix.browser.mjs';

const origin = 'http://127.0.0.1:5186';
const harnessOrigin = 'http://127.0.0.1:5279';
const agents = {
  chromium: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 Firefox/143.0',
  safari: 'Mozilla/5.0 Version/26.0 Safari/605.1.15',
};

function fixture(browser, failure) {
  const calls = [];
  let harnessOptions;
  let driverOptions;
  const fail = (stage) => {
    calls.push(stage);
    if (failure === stage) throw new Error(stage);
  };
  const page = {
    goto: async (url) => { assert.equal(url, `${origin}/effects-matrix`); fail('goto'); },
    evaluate: async () => { fail('userAgent'); return agents[browser]; },
  };
  const launch = async (kind, options) => {
    driverOptions = options;
    fail(kind);
    return {
      newPage: async () => { fail('newPage'); return page; },
      close: async () => { fail('driver.close'); },
    };
  };
  const dependencies = {
    createHarness: (options) => {
      harnessOptions = options;
      return {
        listen: async () => { fail('listen'); return harnessOrigin; },
        close: async () => { fail('harness.close'); },
      };
    },
    chromiumOptions: async () => {
      assert.equal(browser, 'chromium', 'classic dispatch must not load Chromium or engine CLI');
      fail('chromiumOptions');
      return { chromium: 'locked-playwright', args: ['software-gpu-fixture'] };
    },
    createChromiumDriver: (options) => launch('chromium', options),
    createWebDriverClassicDriver: (options) => launch('classic', options),
  };
  return { calls, page, dependencies, fail,
    harnessOptions: () => harnessOptions, driverOptions: () => driverOptions };
}

for (const browser of ['chromium', 'firefox', 'safari']) {
  test(`${browser} runs the same measurement through its selected driver with observed provenance`, async () => {
    const run = fixture(browser);
    const measurement = { adapter: { vendor: 'fixture' }, effects: [{ id: 'measured-row', pixels: [1, -0.25] }] };
    const report = await withEffectsMatrixPage({ origin, browser, endpoint: 'http://127.0.0.1:4444' }, async (page) => {
      assert.equal(page, run.page);
      run.fail('measure');
      return measurement;
    }, run.dependencies);
    assert.equal(report.effects, measurement.effects, 'dispatch preserves the full measurement');
    assert.equal(report.adapter, measurement.adapter);
    assert.deepEqual(report.browser, {
      name: browser, driver: browser === 'chromium' ? 'playwright' : 'webdriver-classic', userAgent: agents[browser],
    });
    assert.equal(run.driverOptions().harnessOrigin, harnessOrigin);
    if (browser === 'chromium') {
      assert.equal(run.driverOptions().chromium, 'locked-playwright');
      assert.deepEqual(run.driverOptions().args, ['software-gpu-fixture']);
      assert(!run.calls.includes('classic'));
    } else {
      assert(!run.calls.includes('chromium'));
      assert(!run.calls.includes('chromiumOptions'));
      assert.equal(run.driverOptions().endpoint, 'http://127.0.0.1:4444');
      assert.equal(run.driverOptions().capabilities.browserName, browser);
      assert.deepEqual(run.driverOptions().capabilities.timeouts, { script: 300_000 });
      if (browser === 'safari') assert(!Object.hasOwn(run.driverOptions().capabilities, 'moz:firefoxOptions'));
      else assert.equal(run.driverOptions().capabilities['moz:firefoxOptions'].prefs['network.proxy.allow_hijacking_localhost'], true);
    }
    assert.deepEqual(run.calls.slice(-2), ['driver.close', 'harness.close']);
    const override = run.harnessOptions().overrides[0];
    assert.equal(run.harnessOptions().upstream, origin);
    assert(override.test(new URL(`${origin}/effects-matrix`)));
    assert(!override.test(new URL(`${origin}/src/module.ts`)));
    assert.deepEqual(await override.respond(), { contentType: 'text/html', body: '<title>Effects matrix</title>' });
  });
}

test('rejects WebKit and unknown browser aliases before opening a harness', async () => {
  for (const browser of ['webkit', 'chrome', 'safari-webkit']) {
    const run = fixture('safari');
    await assert.rejects(withEffectsMatrixPage({ origin, browser }, () => {}, run.dependencies), /unsupported effects-matrix browser/);
    assert.deepEqual(run.calls, []);
  }
});

test('classic browsers require an explicit driver endpoint before any acquisition', async () => {
  for (const browser of ['firefox', 'safari']) {
    const run = fixture(browser);
    await assert.rejects(withEffectsMatrixPage({ origin, browser }, () => {}, run.dependencies), /requires WEBDRIVER_ENDPOINT/);
    assert.deepEqual(run.calls, []);
  }
});

test('a Chromium user agent cannot be reported as actual Safari', async () => {
  const run = fixture('safari');
  run.page.evaluate = async () => agents.chromium;
  await assert.rejects(withEffectsMatrixPage({ origin, browser: 'safari', endpoint: 'http://127.0.0.1:4444' },
    () => assert.fail('measurement must not run with mismatched browser'), run.dependencies), /did not report the requested browser/);
  assert.deepEqual(run.calls.slice(-2), ['driver.close', 'harness.close']);
});

for (const failure of ['listen', 'classic', 'newPage', 'goto', 'userAgent', 'measure', 'driver.close']) {
  test(`releases acquired resources when ${failure} fails`, async () => {
    const run = fixture('firefox', failure);
    await assert.rejects(withEffectsMatrixPage({ origin, browser: 'firefox', endpoint: 'http://127.0.0.1:4444' },
      async () => { run.fail('measure'); return {}; }, run.dependencies), new RegExp(failure.replace('.', '\\.')));
    assert.equal(run.calls.at(-1), 'harness.close');
    assert.equal(run.calls.filter((stage) => stage === 'harness.close').length, 1);
    if (!['listen', 'classic'].includes(failure)) assert.equal(run.calls.filter((stage) => stage === 'driver.close').length, 1);
  });
}
