// Real Chromium entrypoint checks. Run against the prepared engine's Vite dev server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
import { readFile } from 'node:fs/promises';
// The generated policy admits what the owner approved (studio/rights-approval.json). These
// entrypoint regressions check the refusal path, so they substitute a policy in which every
// reviewed identity is blocked, as a checkout without an approval would generate.
const generated = JSON.parse(await readFile(new URL('../engine/src/shared/utils/resource-policy.json', import.meta.url), 'utf8'));
const blockedPolicy = Object.fromEntries(Object.entries(generated).map(([id, entry]) => [id, { ...entry, localRuntime: 'blocked', approvalSha256: null }]));
const substitutePolicy = (context, policy) => context.route('**/resource-policy.json*', (route) => {
  const raw = new URL(route.request().url()).pathname.includes('/moss-tts/') && !new URL(route.request().url()).searchParams.has('import');
  return route.fulfill(raw
    ? { contentType: 'application/json', body: JSON.stringify(policy) }
    : { contentType: 'text/javascript', body: `export default ${JSON.stringify(policy)}` });
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const entry of ['/', '/headless.html']) {
    const context = await browser.newContext({ serviceWorkers: process.env.STUDIO_TEST_BUILT ? 'allow' : 'block' });
    const external = [];
    const resourcePayloads = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      // Vite's ?import&url script returns a URL string, not resource bytes.
      const urlModule = route.request().resourceType() === 'script' && url.searchParams.has('import') && url.searchParams.has('url');
      if (!urlModule && /\.(onnx|bin|woff2?|ttf|otf)$/i.test(url.pathname)) {
        resourcePayloads.push(url.href); return route.abort();
      }
      if (url.origin !== origin && /^https?:$/.test(url.protocol)) {
        external.push(route.request().url());
        return route.abort(); // Never acquire real external payloads during a regression.
      }
      return route.continue();
    });
    // Registered after the catch-all: Playwright runs the newest matching route first.
    if (!process.env.STUDIO_TEST_BUILT) await substitutePolicy(context, blockedPolicy);
    const page = await context.newPage();
    await page.goto(origin + entry);
    await page.waitForTimeout(1000);
    assert.deepEqual(external, [], `${entry}: implicit external startup request`);
    assert.deepEqual(resourcePayloads, [], `${entry}: implicit resource payload acquisition`);
    if (entry === '/') await page.getByRole('link', { name: 'Get Started' }).first().waitFor({ timeout: 10000 });
    else await page.waitForFunction(() => Boolean(window.freecut?.ready));
    if (process.env.STUDIO_TEST_BUILT) {
      if (entry === '/headless.html') {
        const frame = await page.evaluate(async () => { const project = window.freecut.createProject({ name: 'Local empty-frame smoke', width: 320, height: 240 }); project.timeline = { tracks: [], items: [], transitions: [], keyframes: [] }; return window.freecut.renderFrame({ project, frame: 0 }); });
        assert.equal(frame.ok, true); assert.ok(frame.fileSize > 0);
      }
      assert.deepEqual(external, []);
      assert.deepEqual(resourcePayloads, []);
      console.log(`${entry}: built page ready; no external acquisition; service workers allowed`);
      await context.close(); continue;
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
    const moss = await context.newPage();
    await moss.goto(origin + '/moss-tts/browser_onnx_host.html');
    const mossResult = await moss.evaluate(async () => {
      const run = async fn => { try { await fn(); return false; } catch (e) { return String(e).includes('FRAMELEAF_RESOURCE_BLOCKED'); } };
      const runtime = await import('/moss-tts/browser_onnx_runtime.js');
      return [await run(() => globalThis.NanoReaderBrowserModelStore.ensureExternalBrowserOnnxModels()),
        await run(() => runtime.createBrowserOnnxTtsRuntime()), await run(() => new runtime.BrowserOnnxTtsRuntime())];
    });
    assert.deepEqual(mossResult, [true, true, true]);
    await moss.goto(origin + '/moss-tts/tokenizer_sandbox.html');
    const tokenizerBlocked = await moss.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tokenizer response timeout')), 5000);
      window.addEventListener('message', function receive(event) {
        if (event.data?.type !== 'response') return;
        clearTimeout(timer); window.removeEventListener('message', receive);
        resolve(event.data.ok === false && JSON.stringify(event.data).includes('FRAMELEAF_RESOURCE_BLOCKED'));
      });
      window.postMessage({ source: 'nano-reader-tokenizer-sandbox', type: 'request', requestId: 'admission', action: 'loadTokenizer', modelKey: 'nano', tokenizerBase64: 'AAAA' }, '*');
    }));
    assert.equal(tokenizerBlocked, true);
    await moss.close();
    const frameReady = page.waitForEvent('framenavigated', frame => frame.url().endsWith('/moss-tts/browser_onnx_host.html'));
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = '/moss-tts/browser_onnx_host.html'; document.body.appendChild(frame); });
    const child = await frameReady;
    await child.waitForFunction(() => Boolean(globalThis.NanoReaderBrowserModelStore));
    const childBlocked = await child.evaluate(async () => {
      try { await globalThis.NanoReaderBrowserModelStore.ensureExternalBrowserOnnxModels(); return false; }
      catch (e) { return String(e).includes('FRAMELEAF_RESOURCE_BLOCKED'); }
    });
    assert.equal(childBlocked, true);
    assert.ok(results.attempts.every(result => result.blocked), JSON.stringify(results));
    assert.deepEqual(results.media, { width: 16, height: 16, name: 'local-smoke.png' });
    assert.deepEqual(external, [], `${entry}: resource attempt reached network`);
    assert.deepEqual(resourcePayloads, [], `${entry}: same-origin payload attempt reached network`);
    console.log(`${entry}: ${results.attempts.length} resource refusals; seven workers twice; MOSS pages/iframe/tokenizer blocked; real local PNG import passed`);
    await context.close();
  }
  // Owner decision 2026-09-29: every ONNX Runtime WebAssembly the engine loads is served by the
  // engine itself. Each path is same-origin and answers WebAssembly bytes; nothing reaches a CDN.
  if (!process.env.STUDIO_TEST_BUILT) {
    const ortContext = await browser.newContext({ serviceWorkers: 'block' });
    const ortExternal = [];
    await ortContext.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin && /^https?:$/.test(url.protocol)) {
        ortExternal.push(url.href);
        return route.abort();
      }
      return route.continue();
    });
    const ortPage = await ortContext.newPage();
    await ortPage.goto(origin + '/headless.html');
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
    assert.equal(ort.length, 6);
    assert.ok(ort.every((file) => file.sameOrigin && file.ok && file.wasm), JSON.stringify(ort));
    assert.deepEqual(ortExternal, []);
    console.log('ONNX Runtime WebAssembly: 3 builds served same-origin; no CDN request');
    await ortContext.close();
  }
  // A test-only network substitution supplies one approved fixture with a recorded byte digest.
  // The generated policy records no byte digests, so byte verification fails closed in production.
  if (!process.env.STUDIO_TEST_BUILT) {
  const fixtureContext = await browser.newContext({ serviceWorkers: 'block' });
  const hash = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
  await substitutePolicy(fixtureContext, { 'fixture:approved': { localRuntime: 'allowed', approvalSha256: hash, sha256: hash, locator: null, revision: null } });
  const fixturePage = await fixtureContext.newPage();
  await fixturePage.goto(origin + '/headless.html');
  const fixture = await fixturePage.evaluate(async () => {
    const { verifyResourceBytes } = await import('/src/shared/utils/resource-admission.mjs');
    const accepted = [...await verifyResourceBytes('fixture:approved', new Uint8Array([1, 2, 3]))];
    const refuses = async (id, bytes) => { try { await verifyResourceBytes(id, bytes); return false; } catch (e) { return String(e).includes('FRAMELEAF_RESOURCE_BLOCKED'); } };
    const blob = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])]));
    const aliasDenied = await refuses(blob, new Uint8Array([1, 2, 3]));
    URL.revokeObjectURL(blob);
    return { accepted, tamperDenied: await refuses('fixture:approved', new Uint8Array([1, 2, 4])),
      aliasDenied, userImportDenied: await refuses('asset:user-import', new Uint8Array([1, 2, 3])) };
  });
  assert.deepEqual(fixture, { accepted: [1, 2, 3], tamperDenied: true, aliasDenied: true, userImportDenied: true });
  console.log('Test-only approved fixture: bytes accepted; tamper, blob alias and user-import relabeling rejected');
  await fixtureContext.close();
  }
} finally { await browser.close(); }
