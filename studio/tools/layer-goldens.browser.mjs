// Renders every case of layer-goldens.mjs through the real engine's production frame renderer
// and writes studio/spec/goldens/layers.json, the numeric half of studio/spec/layers.md.
// Needs the prepared engine served by Vite (studio/spec/README.md):
//   GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
//     node studio/tools/layer-goldens.browser.mjs --write
// Without --write it renders on the canonical backend and checks the committed goldens with the
// native comparison rule (drift gate). --probe prints, per case, how far the prose reference and
// the float route are from the display route, and writes nothing.
// The contract route is the display route: createCompositionRenderer in export mode, renderFrame
// into an 8-bit canvas (what the editor's engine preview and the browser export draw). The float
// route (renderFrameSignal, sdr-display) is rendered too and its distance is recorded per case.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deriveTolerance } from './render-goldens.mjs';
import {
  LAYER_GOLDENS_FORMAT, LAYER_GOLDENS_VERSION, layerCases, layerInputs, pngDataUrl, referenceFrame, validateLayerGoldens,
  encodeBuffer, decodeBuffer, sha256, compareCase,
} from './layer-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const ENCODING = 'rgba8-deflate-base64';
const STATISTICAL = ['blend/dissolve'];
const PROJECTIVE = ['corner-pin/image', 'corner-pin/reference-size'];
const GOLDENS = path.join(studio, 'spec/goldens/layers.json');

// The engine files whose behaviour the goldens pin; their digest is recorded so drift is visible.
const SOURCE_ROOTS = [
  'src/features/export/utils', 'src/infrastructure/gpu-compositor', 'src/infrastructure/gpu-shared', 'src/infrastructure/gpu-media',
  'src/infrastructure/gpu-shapes', 'src/infrastructure/gpu-masks', 'src/shared/graphics/shapes', 'src/shared/graphics/dissolve-dither.ts',
  'src/shared/utils/media-crop.ts', 'src/shared/utils/mask-scope.ts', 'src/shared/utils/transform-parenting.ts',
  'src/runtime/composition-runtime/utils/shape-path.ts', 'src/runtime/composition-runtime/utils/corner-pin.ts',
  'src/runtime/composition-runtime/utils/frame-scene.ts', 'src/runtime/composition-runtime/utils/scene-assembly.ts',
  'src/runtime/composition-runtime/utils/transform-resolver.ts', 'src/types/blend-mode-css.ts',
];
async function sourceDigest() {
  const files = [];
  const walk = async (rel) => {
    const abs = path.join(studio, 'engine', rel);
    if ((await stat(abs)).isFile()) { files.push(rel); return; }
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/test-helpers/.test(entry.name)) files.push(child);
    }
  };
  for (const root of SOURCE_ROOTS) await walk(root);
  files.sort();
  const parts = [];
  for (const file of files) parts.push(`${file}\0${sha256(await readFile(path.join(studio, 'engine', file)))}`);
  return { files: files.length, sha256: sha256(parts.join('\n')) };
}

const PAGE = `<title>Layer goldens</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`;

async function renderAll(chromium, args, cases) {
  const browser = await chromium.launch({ headless: true, args });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('page error:', error.message));
    await page.route(`${origin}/layer-goldens`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto(`${origin}/layer-goldens`);
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
    const media = Object.fromEntries(Object.entries(layerInputs()).map(([id, input]) => [id, pngDataUrl(input)]));
    return await page.evaluate(async ({ cases, media }) => {
      const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
      const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
      const device = await EffectsPipeline.requestCachedDevice();
      if (!device) throw new Error('WebGPU unavailable');
      const info = device.adapterInfo ?? {};
      const environment = { userAgent: navigator.userAgent,
        adapter: Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((key) => [key, String(info[key] ?? '')])) };
      const results = [];
      for (const c of cases) {
        const { metadata, timeline } = c.graph;
        // The graph of protocol section 2 as the engine's composition: each track lists its items.
        const composition = {
          fps: metadata.fps, width: metadata.width, height: metadata.height, durationInFrames: 60,
          ...(metadata.backgroundColor !== undefined ? { backgroundColor: metadata.backgroundColor } : {}),
          keyframes: timeline.keyframes ?? [], transitions: timeline.transitions ?? [],
          tracks: timeline.tracks.map((track) => ({ ...track,
            items: timeline.items.filter((item) => item.trackId === track.id).map((item) => (item.type === 'image' ? { ...item, src: media[item.mediaId] } : item)) })),
        };
        const result = {};
        for (const route of ['display', 'float']) {
          const canvas = new OffscreenCanvas(metadata.width, metadata.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          const renderer = await createCompositionRenderer(composition, canvas, ctx, { mode: 'export' });
          try {
            await renderer.preload?.();
            if (route === 'display') {
              await renderer.renderFrame(c.frame);
              result.pixels = Array.from(ctx.getImageData(0, 0, metadata.width, metadata.height).data, (v) => v / 255);
            } else {
              try { result.float = Array.from((await renderer.renderFrameSignal(c.frame, 'sdr-display')).rgba); }
              catch (error) { result.floatError = `${error.name}: ${error.message}`; }
            }
          } finally { renderer.dispose(); }
        }
        results.push(result);
      }
      // A float-route case (layers.md L16) takes the float route's frame as its picture.
      results.forEach((r, i) => { if (cases[i].route === 'float') { if (!r.float) throw new Error(`${cases[i].name}: ${r.floatError}`); r.display = r.pixels; r.pixels = r.float.map((v) => Math.min(1, Math.max(0, v))); } });
      return { environment, results };
    }, { cases: cases.map(({ name, frame, graph, route }) => ({ name, frame, graph, route })), media });
  } finally {
    await browser.close();
  }
}

const distance = (a, b) => {
  let max = 0; let total = 0; let over = 0;
  a.forEach((v, i) => { const d = Math.abs(v - b[i]); max = Math.max(max, d); total += d; if (d > 2 / 255) over++; });
  return { max: Number(max.toPrecision(3)), mean: Number((total / a.length).toPrecision(3)), over };
};
const SWIFTSHADER = '--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan --disable-accelerated-2d-canvas';
const adapterName = (env) => Object.values(env.adapter).filter(Boolean).join(' / ') || 'unknown adapter';

export async function runLayerGoldens({ write = false, probe = false } = {}) {
  const require = createRequire(path.join(studio, 'engine/package.json'));
  const { chromium } = require('playwright');
  const catalogue = JSON.parse(await readFile(path.join(studio, 'graph-parameters-v1.json'), 'utf8'));
  const engineBuild = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));
  const canonicalArgs = (process.env.FREECUT_CHROME_ARGS_REPLACE || SWIFTSHADER).split(/\s+/).filter(Boolean);
  const cases = layerCases();
  const started = Date.now();
  const canonical = await renderAll(chromium, canonicalArgs, cases);
  const again = write ? await renderAll(chromium, canonicalArgs, cases) : null;
  const crossArgs = process.env.GOLDENS_CROSS_CHECK_ARGS?.split(/\s+/).filter(Boolean);
  const cross = write && crossArgs ? await renderAll(chromium, crossArgs, cases) : null;
  console.log(`rendered ${cases.length} layer cases on ${adapterName(canonical.environment)}${cross ? ` and ${adapterName(cross.environment)}` : ''} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (cross) assert.notDeepEqual(cross.environment.adapter, canonical.environment.adapter, 'the cross-check must use a different GPU backend');

  if (probe) {
    cases.forEach((c, i) => {
      const r = canonical.results[i];
      const reference = c.reference ? distance(r.pixels, referenceFrame(c)) : null;
      const float = r.float ? distance(r.pixels, r.float) : r.floatError;
      console.log(`${c.name.padEnd(46)} reference ${reference ? JSON.stringify(reference) : '-'.padEnd(8)} float ${JSON.stringify(float)}`);
    });
    return { cases: cases.length };
  }

  if (!write) {
    // Drift gate: the committed goldens must still describe the engine, by the native rule.
    const goldens = JSON.parse(await readFile(GOLDENS, 'utf8'));
    validateLayerGoldens(goldens);
    let failures = 0;
    goldens.cases.forEach((g, i) => {
      const expected = decodeBuffer(g.output.data, g.output.encoding);
      const result = compareCase({ ...g, expected }, canonical.results[i].pixels);
      if (!result.pass) {
        failures++;
        console.error(`${g.name}: ${result.missed} channels outside tolerance (worst ${result.worst.toFixed(4)}, mean ${result.mean.toFixed(5)})`);
      }
    });
    assert.equal(failures, 0, `${failures} layer golden cases drifted`);
    console.log('layer goldens hold');
    return { cases: goldens.cases.length };
  }

  // Determinism: two canonical renders of the contract route must agree bit for bit.
  canonical.results.forEach((r, i) => assert.deepEqual(r.pixels, again.results[i].pixels, `${cases[i].name} is not deterministic`));

  const inputs = Object.fromEntries(Object.entries(layerInputs()).map(([id, input]) => {
    const data = encodeBuffer(input.values, ENCODING);
    return [id, { description: input.description, width: input.width, height: input.height, encoding: ENCODING, data, sha256: sha256(data) }];
  }));
  const doc = {
    format: LAYER_GOLDENS_FORMAT, version: LAYER_GOLDENS_VERSION, kind: 'layers',
    contract: 'studio/spec/layers.md',
    engine: { name: 'freecut', revision: catalogue.engine.revision, patches: engineBuild.patches.length, sourceDigest: await sourceDigest() },
    generatedBy: 'studio/tools/layer-goldens.browser.mjs --write',
    route: 'display: createCompositionRenderer(mode export).renderFrame into an 8-bit canvas, read back as straight RGBA. floatRoute records the distance of renderFrameSignal(sdr-display) from it (informative).',
    renderer: { canonical: canonical.environment, crossCheck: cross?.environment ?? null },
    comparison: 'render-goldens.mjs compareCase: every channel finite; at most `outliers` channels differ by more than max(abs, relative * |expected|).',
    inputs,
    cases: cases.map((c, i) => {
      const r = canonical.results[i];
      const stored = decodeBuffer(encodeBuffer(r.pixels, ENCODING), ENCODING);
      const tolerance = deriveTolerance('sdr', stored, cross?.results[i]?.pixels, c.name);
      if (STATISTICAL.includes(c.name)) {
        // The dissolve pattern depends on GPU interpolation precision (layers.md L9): as HASH_DRIVEN in render-goldens.mjs.
        tolerance.class = 'statistical';
        tolerance.outliers = Math.max(tolerance.outliers, Math.ceil(0.1 * stored.length));
        tolerance.meanAbs = Math.max(tolerance.meanAbs, 0.02);
      }
      const floatRoute = r.float ? distance(stored, r.float) : { error: r.floatError };
      if (PROJECTIVE.includes(c.name)) {
        // L11: the contract is the exact projective warp, not the engine's triangle mesh. The tolerance
        // also admits the measured distance between the two.
        const exact = deriveTolerance('sdr', stored, referenceFrame(c), c.name);
        tolerance.abs = Math.max(tolerance.abs, exact.abs);
        tolerance.outliers = Math.max(tolerance.outliers, exact.outliers);
        tolerance.meanAbs = Math.max(tolerance.meanAbs, exact.meanAbs);
        tolerance.class = tolerance.outliers <= 0.1 * stored.length && tolerance.meanAbs <= 0.02 ? 'edge' : 'statistical';
        tolerance.projective = exact.measured;
      }
      return { name: c.name, class: c.class, frame: c.frame, reference: c.reference, ...(c.route ? { route: c.route } : {}), size: { width: c.graph.metadata.width, height: c.graph.metadata.height },
        graph: c.graph, outcome: 'rendered', tolerance, floatRoute, output: { encoding: ENCODING, data: encodeBuffer(r.pixels, ENCODING) } };
    }),
  };
  console.log(JSON.stringify(validateLayerGoldens(doc)));
  const { cases: list, ...rest } = doc;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  await writeFile(GOLDENS, `${head},\n  "cases": [\n${list.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]\n}\n`);
  console.log('wrote studio/spec/goldens/layers.json');
  return { cases: list.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runLayerGoldens({ write: process.argv.includes('--write'), probe: process.argv.includes('--probe') });
  process.exit(0);
}
