// Real browser entrypoint checks. Run against the prepared engine's Vite dev server.
//
// FL-112: network substitution and blocking route through the shared cross-browser harness
// (studio/tools/lib/cross-browser-harness.mjs), and the page is driven only through the shared
// driver interface (studio/tools/lib/browser-driver.mjs: goto, evaluate, waitForFunction), so the
// same checks can run under WebDriver classic (Firefox, Safari) as well as Playwright's Chromium.
// Waiting for a link polls the DOM, the MOSS iframe is reached through its parent's contentWindow,
// and the MOSS pages are visited in turn on the one page rather than in a second one.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createHarness } from './lib/cross-browser-harness.mjs';
import { admittedHostCapabilities, createChromiumDriver, createWebDriverClassicDriver } from './lib/browser-driver.mjs';
const require = createRequire(new URL('../engine/package.json', import.meta.url));
import { readFile, writeFile } from 'node:fs/promises';
import { runModelTransportAdmission } from './model-transport-byte-admission.browser.mjs';

export function assertNoProxyErrors(harness, origin, entry) {
  assert.deepEqual(harness.observations.filter(o => o.kind === 'error'), [], `${entry}: harness could not reach the dev server`);
  assert.ok(!harness.observations.some(o => o.kind === 'tunnelled'), `${entry}: opaque CONNECT traffic cannot qualify startup absence`);
  assert.ok(harness.observations.some(o => o.method === 'GET' && o.kind === 'proxied' &&
    o.url === new URL(entry, origin).href), `${entry}: no transparent browser GET reached the proxy`);
}

export async function openPage(harnessOrigin, serviceWorkers, { browser = 'chromium', endpoint, chromium } = {}) {
  const capabilities = admittedHostCapabilities(browser);
  if (browser !== 'chromium') assert(endpoint, `${browser} requires WEBDRIVER_ENDPOINT`);
  capabilities.timeouts = {script: 300_000};
  if (browser === 'firefox') capabilities['moz:firefoxOptions'].prefs['dom.webgpu.enabled'] = true;
  const driver = browser === 'chromium'
    ? await createChromiumDriver({ harnessOrigin, chromium: chromium ?? require('playwright').chromium,
        contextOptions: { serviceWorkers } })
    : await createWebDriverClassicDriver({ harnessOrigin, endpoint, capabilities });
  try {
    const page = await driver.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const matches = browser === 'firefox' ? /Firefox\//.test(userAgent)
      : browser === 'safari' ? /Safari\//.test(userAgent) && !/(Chrome|Chromium|Firefox)\//.test(userAgent)
      : /(Chrome|Chromium)\//.test(userAgent);
    assert(matches, `${browser} did not report the requested browser: ${userAgent}`);
    return { page, close: () => driver.close(),
      browser: {name: browser, driver: browser === 'chromium' ? 'playwright' : 'webdriver-classic', userAgent} };
  }
  catch (error) { await driver.close(); throw error; }
}

export async function runResourceAdmission() {
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = process.env.BROWSER || 'chromium';
assert.equal(new URL(origin).protocol, 'http:', 'resource-admission requires an observable HTTP origin');
admittedHostCapabilities(browser);
if (browser !== 'chromium') assert(process.env.WEBDRIVER_ENDPOINT, `${browser} requires WEBDRIVER_ENDPOINT`);
const driverOptions = { browser, endpoint: process.env.WEBDRIVER_ENDPOINT };
// The generated policy admits what the owner approved (studio/rights-approval.json). These
// entrypoint regressions check the refusal path, so they substitute a policy in which every
// reviewed identity is blocked, as a checkout without an approval would generate.
const generated = JSON.parse(await readFile(new URL('../engine/src/shared/utils/resource-policy.json', import.meta.url), 'utf8'));
const blockedPolicy = Object.fromEntries(Object.entries(generated).map(([id, entry]) => [id, { ...entry, localRuntime: 'blocked', approvalSha256: null }]));
// Answers both forms `resource-policy.json` is ever fetched as (matching the pre-harness
// `substitutePolicy` exactly): raw JSON for the MOSS iframe's plain fetch, a JS module export for
// everywhere else (Vite's `?import` module form).
const policyOverride = (policy) => ({
  test: (url) => url.pathname.includes('resource-policy.json'),
  respond: (url) => {
    const raw = url.pathname.includes('/moss-tts/') && !url.searchParams.has('import');
    return raw
      ? { contentType: 'application/json', body: JSON.stringify(policy) }
      : { contentType: 'text/javascript', body: `export default ${JSON.stringify(policy)}` };
  },
});
// Vite's `?import&url` form returns a URL string, not resource bytes - never treat it as a binary
// payload attempt. The harness has no Playwright `resourceType()` to check instead, per
// studio-editing's review: exempting on both query params present is enough.
const isViteUrlImport = (url) => url.searchParams.has('import') && url.searchParams.has('url');
const binaryAssetOverride = (resourcePayloads) => ({
  test: (url) => !isViteUrlImport(url) && /\.(onnx|bin|woff2?|ttf|otf)$/i.test(url.pathname),
  respond: (url) => {
    resourcePayloads.push(url.href);
    return { status: 403, body: 'blocked by resource-admission harness (binary asset payload)' };
  },
});
// RESOURCE_ADMISSION_REPORT=<path> writes every raw observation as JSON, whether the checks pass
// or not, for measured-conformance evidence (FL-112).
const report = { origin, built: Boolean(process.env.STUDIO_TEST_BUILT), entries: [], ort: null, fixture: null };
// Playwright's own Chromium: a proxy sees the whole browser, and branded Chrome's background
// services (time, update, sign-in) reach Google on their own, whatever the page does.
const drivers = [];
const harnesses = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  for (const entry of ['/', '/headless.html']) {
    const resourcePayloads = [];
    const overrides = [binaryAssetOverride(resourcePayloads)];
    if (!process.env.STUDIO_TEST_BUILT) overrides.push(policyOverride(blockedPolicy));
    const harness = createHarness({ upstream: origin, overrides });
    harnesses.push(harness);
    const harnessOrigin = await harness.listen();
    const session = await openPage(harnessOrigin, process.env.STUDIO_TEST_BUILT ? 'allow' : 'block', driverOptions);
    drivers.push(session);
    report.browser = session.browser;
    const { page, close } = session;
    // `external`: every request the harness denied for not matching the Studio origin at all -
    // the harness's own always-on deny-all is what `url.origin !== origin` used to check per-route.
    const external = () => harness.observations.filter((o) => o.kind === 'blocked').map((o) => o.url);
    const observed = { entry, browser: session.browser, get external() { return external(); }, resourcePayloads };
    report.entries.push(observed);
    await page.goto(origin + entry);
    assertNoProxyErrors(harness, origin, entry);
    await sleep(1000);
    assert.deepEqual(external(), [], `${entry}: implicit external startup request`);
    assert.deepEqual(resourcePayloads, [], `${entry}: implicit resource payload acquisition`);
    if (entry === '/') {
      // A link whose accessible name is "Get Started" (its aria-label, or else its text).
      await page.waitForFunction(() => [...document.querySelectorAll('a[href]')].some((link) =>
        (link.getAttribute('aria-label') ?? link.textContent ?? '').replace(/\s+/g, ' ').trim() === 'Get Started'), { timeout: 10000 });
    } else await page.waitForFunction(() => Boolean(window.freecut?.ready));
    if (process.env.STUDIO_TEST_BUILT) {
      if (entry === '/headless.html') {
        const frame = await page.evaluate(async () => { const project = window.freecut.createProject({ name: 'Local empty-frame smoke', width: 320, height: 240 }); project.timeline = { tracks: [], items: [], transitions: [], keyframes: [] }; return window.freecut.renderFrame({ project, frame: 0 }); });
        observed.headlessFrame = frame;
        assert.equal(frame.ok, true); assert.ok(frame.fileSize > 0);
      }
      assert.deepEqual(external(), []);
      assert.deepEqual(resourcePayloads, []);
      console.log(`${entry}: built page ready; no external acquisition`);
      assertNoProxyErrors(harness, origin, entry);
      await close(); await harness.close(); continue;
    }
    const results = await page.evaluate(async () => {
      const root = '/src/';
      const attempts = [];
      const blocked = async (name, run) => {
        try { await run(); attempts.push({ name, blocked: false }); }
        catch (error) { attempts.push({ name, blocked: String(error).includes('FRAMELEAF_RESOURCE_BLOCKED') }); }
      };
      const cache = await caches.open('onnx-model-cache');
      const url = 'https://huggingface.co/unapproved/resolve/main/model.onnx';
      await cache.put(url, new Response(new Uint8Array([1, 2, 3])));
      const onnx = await import(root + 'shared/utils/onnx-model-cache.ts');
      await blocked('warm ONNX bytes', () => onnx.fetchOnnxModelBytes(url));
      await blocked('warm ONNX text', () => onnx.fetchOnnxModelText(url));
      await Promise.all([0, 1].map(i => blocked('concurrent ONNX ' + i, () => onnx.fetchOnnxModelBytes(url))));
      if (window.freecut) await blocked('headless URL probe admission', () => window.freecut.probeMedia({ url, fileName: 'renamed.png' }));
      const fonts = await import(root + 'shared/typography/font-loader.ts');
      await fonts.ensureFontsLoaded([]);
      await blocked('font synchronous use', () => fonts.loadFont('Inter'));
      await blocked('font preload', () => fonts.ensureFontsLoaded(['Inter']));
      for (const [file, singleton, method, args] of [
        ['features/editor/services/musicgen-service.ts', 'musicgenService', 'ensureRuntime', ['musicgen-small']],
        ['features/editor/services/kokoro-tts-service.ts', 'kokoroTtsService', 'ensureRuntime', ['fp32']],
        ['features/editor/services/supertonic-tts-service.ts', 'supertonicTtsService', 'ensureRuntime', []],
        ['features/editor/services/moss-tts-service.ts', 'mossTtsService', 'ensurePrepared', []],
      ]) {
        const service = (await import(root + file))[singleton];
        // TypeScript private fields remain JS properties: seed both warm forms.
        service.runtimePromise = Promise.resolve({});
        service.runtimePromises?.set(args[0], Promise.resolve({}));
        await blocked(singleton + ' warm runtime', () => service[method](...args));
      }
      const { Anime4kUpscaler } = await import(root + 'infrastructure/upscale/anime4k-upscaler.ts');
      for (const variant of ['animation', 'liveAction', 'threeD']) {
        const model = new Anime4kUpscaler(variant);
        model.readyPromise = Promise.resolve();
        await blocked('bundled ' + variant, () => model.ready());
      }
      const api = await import(root + 'features/lottie-browser/services/lottiefiles-api.ts');
      await blocked('Lottie browse', () => api.fetchLottieAnimations({ category: 'popular' }));
      const metadata = await import(root + 'infrastructure/lottie/lottie-metadata.ts');
      const blob = URL.createObjectURL(new Blob(['{"v":"5.0","layers":[]}'], { type: 'application/json' }));
      await blocked('Lottie blob metadata', () => metadata.fetchLottieAnimation(blob));
      const { LottieRenderer, LottieExportProvider } = await import(root + 'infrastructure/lottie/lottie-frame-provider.ts');
      await blocked('Lottie blob render', () => new LottieRenderer({ canvas: document.createElement('canvas'), src: blob }));
      const provider = new LottieExportProvider();
      provider.renderers.set('warm', { canvas: document.createElement('canvas') });
      provider.signatures.set('warm', 'same');
      await blocked('warm Lottie preload', () => provider.preload('warm', blob, 16, 16));
      await blocked('warm Lottie rebuild', () => provider.rebuild('warm', blob, 16, 16, undefined, 'same'));
      await blocked('warm Lottie render', () => provider.renderFrame('warm', 0));
      const { mediaLibraryService } = await import(root + 'features/media-library/services/media-library-service.ts');
      await blocked('URL cannot relabel external resource as File', () => mediaLibraryService.importMediaFromUrl(url, 'test-project'));
      await blocked('blob cannot relabel Lottie as user media', () => mediaLibraryService.importMediaFromUrl(blob, 'test-project'));
      await blocked('Lottie File parser', () => mediaLibraryService.parseLottieFile(new File(['{}'], 'renamed.json', { type: 'application/json' })));
      URL.revokeObjectURL(blob);
      // Actual existing media import path: a locally created File, no URL conversion.
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
      canvas.getContext('2d').fillRect(0, 0, 16, 16);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const { setWorkspaceRoot } = await import(root + 'infrastructure/storage/workspace-fs/root.ts');
      setWorkspaceRoot(await navigator.storage.getDirectory());
      const media = await mediaLibraryService.importMediaFileToOpfs(new File([png], 'local-smoke.png', { type: 'image/png' }), 'resource-policy-smoke');
      return { attempts, media: { width: media.width, height: media.height, name: media.fileName } };
    });
    const workers = await page.evaluate(async () => {
      const paths = [
        'infrastructure/analysis/embeddings/embeddings-worker.ts',
        'infrastructure/analysis/embeddings/clip-worker.ts',
        'infrastructure/analysis/gemma-scene-worker.ts',
        'infrastructure/analysis/lfm-scene-worker.ts',
        'infrastructure/llm/gemma-llm-worker.ts',
        'features/media-library/transcription/workers/whisper.worker.ts',
        'features/media-library/transcription/workers/parakeet.worker.ts',
      ];
      const reports = [];
      for (const path of paths) {
        const worker = new Worker('/src/' + path, { type: 'module' });
        const reply = () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Worker timeout: ' + path)), 20000);
          worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
          worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        });
        try {
          let pending = reply(); worker.postMessage({ type: 'init', modelId: 'onnx-community/whisper-tiny_timestamped' });
          const cold = await pending;
          pending = reply(); worker.postMessage({ type: 'init', modelId: 'onnx-community/whisper-tiny_timestamped' });
          const repeated = await pending;
          reports.push({ path, blocked: [cold, repeated].every(v => v.type === 'error' && v.message.includes('FRAMELEAF_RESOURCE_BLOCKED')) });
        } finally { worker.terminate(); }
      }
      return reports;
    });
    assert.ok(workers.every(result => result.blocked), JSON.stringify(workers));
    // The MOSS host page inside the entry page, reached through the iframe's own window.
    const childBlocked = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      frame.src = '/moss-tts/browser_onnx_host.html';
      document.body.appendChild(frame);
      await loaded;
      const child = frame.contentWindow;
      const deadline = performance.now() + 30000;
      while (!child.NanoReaderBrowserModelStore) {
        if (performance.now() > deadline) throw new Error('MOSS host page never exposed its model store');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      try { await child.NanoReaderBrowserModelStore.ensureExternalBrowserOnnxModels(); return false; }
      catch (e) { return String(e).includes('FRAMELEAF_RESOURCE_BLOCKED'); }
    });
    // Then the MOSS pages themselves, one after the other on the same page.
    await page.goto(origin + '/moss-tts/browser_onnx_host.html');
    const mossResult = await page.evaluate(async () => {
      const run = async fn => { try { await fn(); return false; } catch (e) { return String(e).includes('FRAMELEAF_RESOURCE_BLOCKED'); } };
      const runtime = await import('/moss-tts/browser_onnx_runtime.js');
      return [await run(() => globalThis.NanoReaderBrowserModelStore.ensureExternalBrowserOnnxModels()),
        await run(() => runtime.createBrowserOnnxTtsRuntime()), await run(() => new runtime.BrowserOnnxTtsRuntime())];
    });
    assert.deepEqual(mossResult, [true, true, true]);
    await page.goto(origin + '/moss-tts/tokenizer_sandbox.html');
    const tokenizerBlocked = await page.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tokenizer response timeout')), 5000);
      window.addEventListener('message', function receive(event) {
        if (event.data?.type !== 'response') return;
        clearTimeout(timer); window.removeEventListener('message', receive);
        resolve(event.data.ok === false && JSON.stringify(event.data).includes('FRAMELEAF_RESOURCE_BLOCKED'));
      });
      window.postMessage({ source: 'nano-reader-tokenizer-sandbox', type: 'request', requestId: 'admission', action: 'loadTokenizer', modelKey: 'nano', tokenizerBase64: 'AAAA' }, '*');
    }));
    assert.equal(tokenizerBlocked, true);
    Object.assign(observed, { attempts: results.attempts, media: results.media, childBlocked });
    assert.equal(childBlocked, true);
    assert.ok(results.attempts.every(result => result.blocked), JSON.stringify(results));
    assert.deepEqual(results.media, { width: 16, height: 16, name: 'local-smoke.png' });
    assert.deepEqual(external(), [], `${entry}: resource attempt reached network`);
    assert.deepEqual(resourcePayloads, [], `${entry}: same-origin payload attempt reached network`);
    assertNoProxyErrors(harness, origin, entry);
    console.log(`${entry}: ${results.attempts.length} resource refusals; seven workers twice; MOSS pages/iframe/tokenizer blocked; real local PNG import passed`);
    await close(); await harness.close();
  }
  // Owner decision 2026-09-29: every ONNX Runtime WebAssembly the engine loads is served by the
  // engine itself. Each path is same-origin and answers WebAssembly bytes; nothing reaches a CDN.
  if (!process.env.STUDIO_TEST_BUILT) {
    const ortHarness = createHarness({ upstream: origin });
    harnesses.push(ortHarness);
    const ortHarnessOrigin = await ortHarness.listen();
    const session = await openPage(ortHarnessOrigin, 'block', driverOptions);
    drivers.push(session);
    const { page: ortPage, close: closeOrt } = session;
    await ortPage.goto(origin + '/headless.html');
    assertNoProxyErrors(ortHarness, origin, '/headless.html');
    const ort = await ortPage.evaluate(async () => {
      const assets = await import('/src/shared/utils/local-ort-assets.ts');
      const sets = [assets.ORT_WASM_JSEP(), assets.transformersOrtWasmPaths(), assets.TRANSFORMERS_3_ORT_WASM()];
      const checked = [];
      for (const set of sets) {
        for (const [kind, url] of Object.entries(set)) {
          const response = await fetch(url);
          const bytes = new Uint8Array(await response.arrayBuffer());
          checked.push({
            kind,
            sameOrigin: new URL(url).origin === location.origin,
            ok: response.ok,
            wasm: kind !== 'wasm' || (bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d),
          });
        }
      }
      return checked;
    });
    const ortExternal = ortHarness.observations.filter((o) => o.kind === 'blocked').map((o) => o.url);
    report.ort = { browser: session.browser, files: ort, external: ortExternal };
    assert.equal(ort.length, 6);
    assert.ok(ort.every((file) => file.sameOrigin && file.ok && file.wasm), JSON.stringify(ort));
    assert.deepEqual(ortExternal, []);
    assertNoProxyErrors(ortHarness, origin, '/headless.html');
    console.log('ONNX Runtime WebAssembly: 3 builds served same-origin; no CDN request');
    await closeOrt(); await ortHarness.close();
  }
  if (browser === 'chromium') report.modelTransport = await runModelTransportAdmission();
  // A test-only network substitution supplies one approved fixture with a recorded byte digest.
  // Root identities never carry byte digests; this fixture supplies one exact-file binding.
  if (!process.env.STUDIO_TEST_BUILT) {
  const hash = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
  const fixtureUrl = `https://huggingface.co/synthetic-contract/admission/resolve/${'a'.repeat(40)}/fixture.bin`;
  const fixturePolicy = { localRuntime: 'allowed', approvalSha256: hash, sha256: null,
    locator: 'synthetic-contract/admission', revision: 'a'.repeat(40),
    files: { [fixtureUrl]: { url: fixtureUrl, sha256: hash, revision: 'a'.repeat(40), approvalSha256: hash } } };
  // No blocking override here, per studio-editing's review - this pass only ever substitutes the
  // policy; nothing else runs during it. The harness's always-on deny-all for non-upstream hosts
  // still applies underneath (there's no way to disable it - it's the harness's whole point), but
  // that's strictly narrower than "no blocking at all" and nothing in this pass hits it.
  const fixtureHarness = createHarness({
    upstream: origin,
    overrides: [policyOverride({ 'model:synthetic-contract/admission': fixturePolicy })],
  });
  harnesses.push(fixtureHarness);
  const fixtureHarnessOrigin = await fixtureHarness.listen();
  const session = await openPage(fixtureHarnessOrigin, 'block', driverOptions);
  drivers.push(session);
  const { page: fixturePage, close: closeFixture } = session;
  await fixturePage.goto(origin + '/headless.html');
  assertNoProxyErrors(fixtureHarness, origin, '/headless.html');
  const fixture = await fixturePage.evaluate(async (fixtureUrl) => {
    const { verifyResourceBytes } = await import('/src/shared/utils/resource-admission.mjs');
    const accepted = [...await verifyResourceBytes(fixtureUrl, new Uint8Array([1, 2, 3]))];
    const refuses = async (id, bytes) => { try { await verifyResourceBytes(id, bytes); return false; } catch (e) { return String(e).includes('FRAMELEAF_RESOURCE_BLOCKED'); } };
    const blob = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])]));
    const aliasDenied = await refuses(blob, new Uint8Array([1, 2, 3]));
    URL.revokeObjectURL(blob);
    return { accepted, tamperDenied: await refuses(fixtureUrl, new Uint8Array([1, 2, 4])),
      aliasDenied, userImportDenied: await refuses('asset:user-import', new Uint8Array([1, 2, 3])) };
  }, fixtureUrl);
  report.fixture = { browser: session.browser, ...fixture };
  assert.deepEqual(fixture, { accepted: [1, 2, 3], tamperDenied: true, aliasDenied: true, userImportDenied: true });
  assertNoProxyErrors(fixtureHarness, origin, '/headless.html');
  console.log('Test-only approved fixture: bytes accepted; tamper, blob alias and user-import relabeling rejected');
  await closeFixture(); await fixtureHarness.close();
  }
} finally {
  await Promise.allSettled(drivers.map((driver) => driver.close()));
  await Promise.allSettled(harnesses.map((harness) => harness.close()));
  if (process.env.RESOURCE_ADMISSION_REPORT) await writeFile(process.env.RESOURCE_ADMISSION_REPORT, JSON.stringify(report, null, 2));
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runResourceAdmission();
