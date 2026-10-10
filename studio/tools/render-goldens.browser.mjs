// Renders every case of render-goldens.mjs through the real engine and writes
// studio/spec/goldens/{effects,transitions}.json, the numeric half of the native-app
// render contract (studio/spec/README.md). Needs the prepared engine served by Vite:
//   npm --prefix studio/engine run dev -- --host 127.0.0.1 --port 5186 --strictPort
//   FREECUT_CHROME_ARGS_REPLACE='--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan --disable-accelerated-2d-canvas' \
//   GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
//     node studio/tools/render-goldens.browser.mjs --write
// Without --write it renders on the canonical backend and checks the committed goldens
// with the native comparison rule (drift gate); ASCII atlas cases use the prose CPU oracle
// with the current platform glyph atlas as input, independently checked against Canvas 2D. The canonical backend is the software
// WebGPU of FREECUT_CHROME_ARGS_REPLACE (CI's); GOLDENS_CROSS_CHECK_ARGS names a second
// backend whose differences set the tolerances (render-goldens.mjs, deriveTolerance).
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asciiAtlasSpec, validateAsciiAtlas, renderAsciiReference, settleAsciiGuard, ASCII_ATLASES_FORMAT, encodeAsciiAtlas } from './ascii-reference.mjs';
import { runKeyframeGoldens } from './keyframe-goldens.browser.mjs';
import {
  GOLDENS_FORMAT, GOLDENS_VERSION, EFFECT_SIZE, TRANSITION_SIZE, GPU_TRANSITIONS, PROGRESS_CURVE_CASES,
  effectCases, transitionCases, buildIndex, renderIndexMarkdown, replaceIndexMarkdown, effectSdrInput, effectHdrInput, transitionInputs,
  encodeBuffer, decodeBuffer, roundHalf, sha256, deriveTolerance, compareCase, validateGoldens,
} from './render-goldens.mjs';
import { runHdrGoldens } from './hdr-goldens.browser.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(studio, 'engine/package.json'));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const write = process.argv.includes('--write');
const catalogue = JSON.parse(await readFile(path.join(studio, 'graph-parameters-v1.json'), 'utf8'));
const engineBuild = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));

// The engine files whose behaviour the goldens pin; their digest is recorded so drift is visible.
const SOURCE_ROOTS = [
  'src/infrastructure/gpu-effects', 'src/infrastructure/gpu-transitions', 'src/infrastructure/gpu-shared',
  'src/shared/timeline/transitions', 'src/shared/utils/easing.ts', 'src/shared/utils/gpu-curves.ts',
  'src/features/export/utils/canvas-transitions.ts', 'src/runtime/composition-runtime/utils/transition-scene.ts',
];
async function sourceDigest() {
  const files = [];
  const walk = async (rel) => {
    const abs = path.join(studio, 'engine', rel);
    if (rel.endsWith('.ts')) { files.push(rel); return; }
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(child);
    }
  };
  for (const root of SOURCE_ROOTS) await walk(root);
  files.sort();
  const parts = [];
  for (const file of files) parts.push(`${file}\0${sha256(await readFile(path.join(studio, 'engine', file)))}`);
  return { files: files.length, sha256: sha256(parts.join('\n')) };
}

const PAGE = `<title>Render goldens</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`;

async function renderAll(args) {
  const browser = await chromium.launch({ headless: true, args });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('page error:', error.message));
    await page.route(`${origin}/render-goldens`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto(`${origin}/render-goldens`);
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
    return await page.evaluate(async ({ E, T, effects, atlasSpecs, transitions, sdrInput, hdrInput, tA, tB, curveCases, gpuIds, temporalIds }) => {
      const { EffectsPipeline, EFFECT_CLOCK_PARAM } = await import('/src/infrastructure/gpu-effects/index.ts');
      const { ascii } = await import('/src/infrastructure/gpu-effects/effects/stylize.ts');
      const { getGpuEffect } = await import('/src/infrastructure/gpu-effects/registry.ts');
      if (getGpuEffect('gpu-ascii') !== ascii) throw new Error('ASCII atlas capture must use the registered production definition');
      const { HdrRenderUnavailableError } = await import('/src/shared/graphics/color/managed-color.ts');
      const { TransitionPipeline } = await import('/src/infrastructure/gpu-transitions/transition-pipeline.ts');
      const { registerBuiltinTransitions } = await import('/src/shared/timeline/transitions/register-builtins.ts');
      const { transitionRegistry } = await import('/src/shared/timeline/transitions/registry.ts');
      const { renderTransition, resolveTransitionRenderPath } = await import('/src/features/export/utils/canvas-transitions.ts');
      const { calculateTransitionProgress } = await import('/src/runtime/composition-runtime/utils/transition-scene.ts');
      registerBuiltinTransitions();
      const effectsPipeline = await EffectsPipeline.create();
      if (!effectsPipeline) throw new Error('WebGPU unavailable');
      const device = effectsPipeline.getDevice();
      const transitionPipeline = TransitionPipeline.create(device);
      if (!transitionPipeline) throw new Error('Transition pipeline unavailable');
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
      const upload = (values, w, h) => {
        const texture = device.createTexture({ size: [w, h], format: 'rgba16float', usage });
        device.queue.writeTexture({ texture }, new Float16Array(values), { bytesPerRow: w * 8 }, [w, h]);
        return texture;
      };
      const readback = async (texture, w, h) => {
        const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [w, h]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const out = [];
        for (let y = 0; y < h; y++) out.push(...new Float16Array(mapped, y * bytesPerRow, w * 4));
        buffer.unmap();
        buffer.destroy();
        return out;
      };
      const info = device.adapterInfo ?? {};
      const environment = { userAgent: navigator.userAgent,
        adapter: Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((key) => [key, String(info[key] ?? '')])) };

      // Effects: the production GPU compositor route (rgba16float in and out; SDR or linear HDR working range).
      const inputs = { sdr: upload(sdrInput, E.width, E.height), hdr: upload(hdrInput, E.width, E.height) };
      const effectResults = [];
      const capturedAtlases = new Map();
      const referenceAtlases = new Map();
      const buildAtlas = ascii.dataTexture.build;
      ascii.dataTexture.build = (params) => {
        const payload = buildAtlas(params);
        capturedAtlases.set(ascii.dataTexture.key(params), { width: payload.width, height: payload.height, depth: payload.depth, data: Array.from(payload.data) });
        return payload;
      };
      try {
        for (const [caseIndex, c] of effects.entries()) {
          const spec = atlasSpecs[caseIndex];
          if (spec && !referenceAtlases.has(spec.key)) {
            // Independently rasterize the prose's INPUT, never the production builder or GPU frame.
            const canvas = new OffscreenCanvas(spec.width, spec.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw new Error(`${c.name}: reference atlas needs Canvas 2D`);
            ctx.clearRect(0, 0, spec.width, spec.height);
            ctx.fillStyle = '#ffffff';
            ctx.font = spec.font;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            [...spec.ramp].forEach((glyph, i) => ctx.fillText(glyph, 24 * i + 12, 13));
            const rgba = ctx.getImageData(0, 0, spec.width, spec.height).data;
            const data = Array.from(rgba, (_, i) => rgba[(i - i % 4) + 3]);
            referenceAtlases.set(spec.key, { width: spec.width, height: spec.height, depth: spec.depth, data });
          }
          effectsPipeline.setWorkingRange(c.domain);
          const output = device.createTexture({ size: [E.width, E.height], format: 'rgba16float', usage });
          // As in production, only a temporal effect receives the effect clock (C8); the stored object is otherwise passed as it is.
          const instance = { id: 'fx', type: c.id, name: c.id, enabled: true,
            params: temporalIds.includes(c.id) ? { ...c.params, [EFFECT_CLOCK_PARAM]: c.clock } : { ...c.params } };
          try {
            device.pushErrorScope('validation');
            let accepted;
            try { accepted = effectsPipeline.applyTextureEffectsToTexture(inputs[c.domain], [instance], output, E.width, E.height); }
            catch (error) {
              await device.popErrorScope();
              if (error instanceof HdrRenderUnavailableError && c.domain === 'hdr') { effectResults.push({ outcome: 'refused', error: error.name }); continue; }
              throw error;
            }
            const pixels = await readback(output, E.width, E.height);
            const validation = await device.popErrorScope();
            if (!accepted || validation) throw new Error(`${c.name}: ${validation?.message ?? 'rejected'}`);
            const atlas = spec ? capturedAtlases.get(spec.key) : undefined;
            if (spec && !atlas) throw new Error(`${c.name}: production atlas input was not captured`);
            effectResults.push({ outcome: 'rendered', pixels, ...(spec ? { atlas, referenceAtlas: referenceAtlases.get(spec.key) } : {}) });
          } finally { output.destroy(); }
        }
      } finally { ascii.dataTexture.build = buildAtlas; }
      effectsPipeline.setWorkingRange('sdr');

      // Transitions: GPU ids through the GPU compositor route (straight in, straight out, SDR working
      // range); the rest through the Canvas 2D route the compositor falls back to.
      transitionPipeline.setWorkingRange('sdr');
      const left = upload(tA, T.width, T.height);
      const right = upload(tB, T.width, T.height);
      const canvasOf = (values) => {
        const canvas = new OffscreenCanvas(T.width, T.height);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(values.map((v) => Math.round(v * 255))), T.width, T.height), 0, 0);
        return canvas;
      };
      const leftCanvas = canvasOf(tA);
      const rightCanvas = canvasOf(tB);
      const paths = {};
      for (const id of new Set(transitions.map((c) => c.id))) {
        paths[id] = resolveTransitionRenderPath(id, { gpuAvailable: true, hasGpuTransition: (g) => transitionPipeline.has(g) });
        const expected = gpuIds.includes(id) ? 'gpu' : 'registry-canvas';
        if (paths[id] !== expected) throw new Error(`${id}: production path ${paths[id]}, expected ${expected}`);
      }
      const transitionResults = [];
      for (const c of transitions) {
        if (c.route === 'gpu') {
          const gpuId = transitionRegistry.getRenderer(c.id).gpuTransitionId;
          const output = device.createTexture({ size: [T.width, T.height], format: 'rgba16float', usage });
          try {
            device.pushErrorScope('validation');
            const accepted = transitionPipeline.renderTexturesToTexture(gpuId, left, right, output, c.progress, T.width, T.height,
              c.direction ?? undefined, c.properties ?? undefined, 'straight', 'straight');
            const pixels = await readback(output, T.width, T.height);
            const validation = await device.popErrorScope();
            if (!accepted || validation) throw new Error(`${c.name}: ${validation?.message ?? 'rejected'}`);
            transitionResults.push({ outcome: 'rendered', pixels });
          } finally { output.destroy(); }
        } else {
          const out = new OffscreenCanvas(T.width, T.height);
          const ctx = out.getContext('2d');
          renderTransition(ctx, {
            transition: { id: 't', type: 'crossfade', presentation: c.id, direction: c.direction ?? undefined,
              properties: c.properties ?? undefined, durationInFrames: 30, timing: 'linear', alignment: 0.5 },
            progress: c.progress,
          }, leftCanvas, rightCanvas, { width: T.width, height: T.height, fps: 30 }, null);
          const data = ctx.getImageData(0, 0, T.width, T.height).data;
          transitionResults.push({ outcome: 'rendered', pixels: Array.from(data, (v) => v / 255) });
        }
      }
      const curve = curveCases.map((c) => calculateTransitionProgress(c.localFrame, c.duration, c.timing, c.bezierPoints ?? undefined));
      for (const texture of [inputs.sdr, inputs.hdr, left, right]) texture.destroy();
      transitionPipeline.destroy();
      return { environment, effectResults, transitionResults, curve };
    }, {
      E: EFFECT_SIZE, T: TRANSITION_SIZE,
      effects: effectCases(catalogue), transitions: transitionCases(catalogue),
      atlasSpecs: effectCases(catalogue).map((c) => c.id === 'gpu-ascii' && c.domain === 'sdr' ? asciiAtlasSpec(c.params) : null),
      sdrInput: effectSdrInput(), hdrInput: effectHdrInput(),
      tA: transitionInputs().a, tB: transitionInputs().b,
      curveCases: PROGRESS_CURVE_CASES, gpuIds: GPU_TRANSITIONS,
      temporalIds: catalogue.effects.filter((e) => e.temporal).map((e) => e.id),
    });
  } finally {
    await browser.close();
  }
}

const SWIFTSHADER = '--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan --disable-accelerated-2d-canvas';
const canonicalArgs = (process.env.FREECUT_CHROME_ARGS_REPLACE || SWIFTSHADER).split(/\s+/).filter(Boolean);
const started = Date.now();
const canonical = await renderAll(canonicalArgs);
const again = write ? await renderAll(canonicalArgs) : null;
const crossArgs = process.env.GOLDENS_CROSS_CHECK_ARGS?.split(/\s+/).filter(Boolean);
const cross = write && crossArgs ? await renderAll(crossArgs) : null;
const adapterName = (env) => Object.values(env.adapter).filter(Boolean).join(' / ') || 'unknown adapter';
console.log(`rendered on ${adapterName(canonical.environment)}${cross ? ` and ${adapterName(cross.environment)}` : ''} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (cross) assert.notDeepEqual(cross.environment.adapter, canonical.environment.adapter, 'the cross-check must use a different GPU backend');

const eCases = effectCases(catalogue);
const tCases = transitionCases(catalogue);

if (!write) {
  // Drift gate: the committed goldens must still describe the engine, by the native rule.
  let failures = 0;
  const atlasEvidence = [];
  for (const [kind, cases, results] of [['effects', eCases, canonical.effectResults], ['transitions', tCases, canonical.transitionResults]]) {
    const goldens = JSON.parse(await readFile(path.join(studio, `spec/goldens/${kind}.json`), 'utf8'));
    validateGoldens(kind, goldens, catalogue);
    goldens.cases.forEach((g, i) => {
      if (g.outcome === 'refused') { if (results[i].outcome !== 'refused') { failures++; console.error(`${g.name}: no longer refused`); } return; }
      let expected = decodeBuffer(g.output.data, g.output.encoding);
      if (kind === 'effects' && g.id === 'gpu-ascii' && asciiAtlasSpec(g.params)) {
        validateAsciiAtlas(results[i].atlas, results[i].referenceAtlas, g.params);
        const guarded = [];
        const reference = renderAsciiReference(effectSdrInput(), EFFECT_SIZE.width, EFFECT_SIZE.height, g.params, results[i].atlas, guarded);
        // Coverage under the transparent-mode division guard: RGB must lie on the equations' own segment.
        const settled = settleAsciiGuard(reference, results[i].pixels, guarded);
        expected = settled.expected;
        atlasEvidence.push({ caseIndex: i, key: asciiAtlasSpec(g.params).key, width: results[i].atlas.width, height: results[i].atlas.height,
          sha256: sha256(Buffer.from(results[i].atlas.data)), referenceSha256: sha256(Buffer.from(results[i].referenceAtlas.data)),
          guardPixels: settled.pixels });
      }
      const result = compareCase({ ...g, expected }, results[i].pixels);
      if (!result.pass) {
        failures++;
        console.error(`${g.name}: ${result.missed} channels outside tolerance (worst ${result.worst.toFixed(4)})`);
        console.error(JSON.stringify({ kind, caseIndex: i, name: g.name, params: g.params, tolerance: g.tolerance, ...result,
          samples: expected.flatMap((want, channel) => Math.abs(want - results[i].pixels[channel]) > g.tolerance.abs
            ? [{ channel, expected: want, actual: results[i].pixels[channel] }] : []).slice(0, 8) }));
      }
    });
    if (kind === 'transitions') {
      goldens.progressCurve.forEach((c, i) => assert.equal(canonical.curve[i], c.progress, `progress curve ${i}`));
    }
  }
  console.log(JSON.stringify({ check: 'ASCII platform atlas input and independent CPU oracle', environment: canonical.environment, cases: atlasEvidence }));
  assert.equal(failures, 0, `${failures} golden cases drifted`);
  console.log('render goldens hold');
  await runKeyframeGoldens({ write: false, origin });
  await runHdrGoldens({ write: false }); // studio/spec/hdr.md
  process.exit(0);
}

// Determinism: two canonical renders must agree bit for bit.
for (const [label, a, b] of [['effects', canonical.effectResults, again.effectResults], ['transitions', canonical.transitionResults, again.transitionResults]]) {
  a.forEach((r, i) => assert.deepEqual(r, b[i], `${label} case ${i} is not deterministic`));
}

const digest = await sourceDigest();
const header = (kind) => ({
  format: GOLDENS_FORMAT, version: GOLDENS_VERSION, kind,
  contract: 'studio/spec/README.md',
  engine: { name: 'freecut', revision: catalogue.engine.revision, patches: engineBuild.patches.length, sourceDigest: digest },
  generatedBy: 'studio/tools/render-goldens.browser.mjs --write',
  renderer: { canonical: canonical.environment, crossCheck: cross?.environment ?? null },
  comparison: 'render-goldens.mjs compareCase: every channel finite; at most `outliers` channels differ by more than max(abs, relative * |expected|).',
});
const caseLine = (c) => JSON.stringify(c);
const serialise = (doc) => {
  const { cases, progressCurve, ...rest } = doc;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  const curve = progressCurve ? `,\n  "progressCurve": [\n${progressCurve.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]` : '';
  return `${head}${curve},\n  "cases": [\n${cases.map((c) => `    ${caseLine(c)}`).join(',\n')}\n  ]\n}\n`;
};

const effectDoc = {
  ...header('effects'),
  size: EFFECT_SIZE,
  inputs: {
    sdr: { description: 'render-goldens.mjs effectSdrInput: sRGB-encoded, straight alpha, binary16', encoding: 'f16le-deflate-base64', data: encodeBuffer(effectSdrInput(), 'f16le-deflate-base64') },
    hdr: { description: 'render-goldens.mjs effectHdrInput: linear display-referred BT.709 (1.0 = 203 cd/m2), straight alpha, binary16', encoding: 'f16le-deflate-base64', data: encodeBuffer(effectHdrInput(), 'f16le-deflate-base64') },
  },
  cases: eCases.map((c, i) => {
    const r = canonical.effectResults[i];
    const base = { name: c.name, id: c.id, domain: c.domain, params: c.params, clock: c.clock };
    if (r.outcome === 'refused') return { ...base, outcome: 'refused' };
    const crossPixels = cross?.effectResults[i]?.pixels;
    const tolerance = deriveTolerance(c.domain, r.pixels.map(roundHalf), crossPixels?.map(roundHalf), c.id);
    return { ...base, outcome: 'rendered', tolerance, output: { encoding: 'f16le-deflate-base64', data: encodeBuffer(r.pixels, 'f16le-deflate-base64') } };
  }),
};
const ta = transitionInputs();
const transitionDoc = {
  ...header('transitions'),
  size: TRANSITION_SIZE,
  inputs: {
    a: { description: 'render-goldens.mjs transitionInputs().a: outgoing clip, opaque, sRGB-encoded', encoding: 'rgba8-deflate-base64', data: encodeBuffer(ta.a, 'rgba8-deflate-base64') },
    b: { description: 'render-goldens.mjs transitionInputs().b: incoming clip, opaque, sRGB-encoded', encoding: 'rgba8-deflate-base64', data: encodeBuffer(ta.b, 'rgba8-deflate-base64') },
  },
  progressCurve: PROGRESS_CURVE_CASES.map((c, i) => ({ ...c, progress: canonical.curve[i] })),
  cases: tCases.map((c, i) => {
    const r = canonical.transitionResults[i];
    // Values inside [0, 1] are stored as 8-bit (well inside the 2/255 floor); others keep binary16.
    const inRange = r.pixels.every((v) => v >= 0 && v <= 1);
    const encoding = inRange ? 'rgba8-deflate-base64' : 'f16le-deflate-base64';
    const stored = decodeBuffer(encodeBuffer(r.pixels, encoding), encoding);
    const crossPixels = cross?.transitionResults[i]?.pixels;
    const tolerance = deriveTolerance('sdr', stored, crossPixels, c.id);
    return { name: c.name, id: c.id, route: c.route, direction: c.direction, progress: c.progress, properties: c.properties,
      outcome: 'rendered', tolerance, output: { encoding, data: encodeBuffer(r.pixels, encoding) } };
  }),
};
for (const doc of [effectDoc, transitionDoc]) for (const input of Object.values(doc.inputs)) input.sha256 = sha256(input.data);
console.log(JSON.stringify(validateGoldens('effects', effectDoc, catalogue)), JSON.stringify(validateGoldens('transitions', transitionDoc, catalogue)));
await writeFile(path.join(studio, 'spec/goldens/effects.json'), serialise(effectDoc));
await writeFile(path.join(studio, 'spec/goldens/transitions.json'), serialise(transitionDoc));
const indexPath = path.join(studio, 'spec/index.json');
const previousIndex = await readFile(indexPath, 'utf8').then(JSON.parse, () => undefined);
const index = buildIndex(catalogue, effectDoc, transitionDoc, previousIndex);
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
const readmePath = path.join(studio, 'spec/README.md');
await writeFile(readmePath, replaceIndexMarkdown(await readFile(readmePath, 'utf8'), renderIndexMarkdown(index, transitionDoc.progressCurve.length)));
// The glyph atlas strips the font-atlas ASCII goldens were rendered with (gpu-ascii, Glyph atlas):
// the platform input of those cases, published so that a native client can meet them.
const atlases = new Map();
eCases.forEach((c, i) => {
  const spec = c.id === 'gpu-ascii' && c.domain === 'sdr' ? asciiAtlasSpec(c.params) : null;
  if (!spec) return;
  const captured = canonical.effectResults[i].atlas;
  validateAsciiAtlas(captured, canonical.effectResults[i].referenceAtlas, c.params);
  const entry = atlases.get(spec.key) ?? { ...encodeAsciiAtlas(spec, c.params.font, captured), cases: [] };
  assert.equal(entry.sha256, encodeAsciiAtlas(spec, c.params.font, captured).sha256, `${c.name}: atlas ${spec.key} changed within one run`);
  entry.cases.push(c.name);
  atlases.set(spec.key, entry);
});
await writeFile(path.join(studio, 'spec/goldens/ascii-atlases.json'), `${JSON.stringify({
  format: ASCII_ATLASES_FORMAT, version: 1, contract: 'studio/spec/effects/gpu-ascii.md',
  generatedBy: 'studio/tools/render-goldens.browser.mjs --write',
  renderer: canonical.environment,
  layout: 'One 24 x 24 cell per glyph of the ramp, left to right. `data` is the coverage byte of every texel, row-major from the top-left, raw DEFLATE, base64.',
  atlases: [...atlases.values()],
}, null, 2)}\n`);
await runKeyframeGoldens({ write: true, origin });
console.log('wrote studio/spec/goldens/effects.json, transitions.json, ascii-atlases.json, keyframes.json, index.json and the README index');
await runHdrGoldens({ write: true });
