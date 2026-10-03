// FL-99 / FL-97: every registered GPU effect through the shared preview/export
// effect pipeline, on software WebGPU in CI. For each effect and each parameter
// case (defaults, every numeric extreme, every select option, every boolean):
//   - no WebGPU validation error and only finite float output;
//   - rendering the same case twice is bit-identical (temporal effects get a
//     fixed frame clock);
//   - SDR reference behaviour: the float route on in-range input matches the
//     legacy rgba8unorm route within quantization, for the effects declared so;
//   - the declared HDR class in effect-hdr-semantics.json holds on the float
//     route (extended range survives, bounded effects stay within [0, 1]);
//   - keyframed parameters reach the shader (start/end frames equal the static
//     extremes, the midpoint differs) and a two-effect stack equals applying
//     the effects one after the other;
//   - invalid parameters (non-finite, out of range, unknown options, non-boolean
//     flags, undeclared keys) draw exactly as their declared meaning, and an unknown effect id
//     passes the input through. EFFECTS_MATRIX_REPORT carries effects[].invalid.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHarness } from './lib/cross-browser-harness.mjs';
import { createChromiumDriver, createWebDriverClassicDriver } from './lib/browser-driver.mjs';

async function chromiumOptions() {
  const require = createRequire(new URL('../engine/package.json', import.meta.url));
  const { chromeLaunchArgs } = await import('../engine/headless/lib/cli.mjs');
  return { chromium: require('playwright').chromium, args: chromeLaunchArgs() };
}

/** One effects matrix session; the callback retains the same GPU measurement on every browser. */
export async function withEffectsMatrixPage({ origin, browser = 'chromium', endpoint }, measure, dependencies = {}) {
  assert(['chromium', 'firefox', 'safari'].includes(browser), `unsupported effects-matrix browser: ${browser}`);
  if (browser !== 'chromium') assert(endpoint, `${browser} requires WEBDRIVER_ENDPOINT`);
  const runtime = { createHarness, createChromiumDriver, createWebDriverClassicDriver, chromiumOptions, ...dependencies };
  const harness = runtime.createHarness({
    upstream: origin,
    overrides: [{
      test: (url) => url.pathname === '/effects-matrix',
      respond: () => ({ contentType: 'text/html', body: '<title>Effects matrix</title>' }),
    }],
  });
  let driver;
  try {
    const harnessOrigin = await harness.listen();
    driver = browser === 'chromium'
      ? await runtime.createChromiumDriver({ harnessOrigin, ...await runtime.chromiumOptions() })
      : await runtime.createWebDriverClassicDriver({
          endpoint, harnessOrigin,
          capabilities: {
            browserName: browser,
            // The full parameter matrix is one asynchronous GPU evaluation, not a
            // short DOM script. Keep its timeout explicit and bounded in classic drivers.
            timeouts: { script: 300_000 },
            ...(browser === 'firefox' ? {
              'moz:firefoxOptions': { prefs: {
                'dom.webgpu.enabled': true,
                'network.proxy.allow_hijacking_localhost': true,
              } },
            } : {}),
          },
        });
    const page = await driver.newPage();
    await page.goto(`${origin}/effects-matrix`);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const matches = browser === 'firefox' ? /Firefox\//.test(userAgent)
      : browser === 'safari' ? /Safari\//.test(userAgent) && !/(Chrome|Chromium|Firefox)\//.test(userAgent)
      : /(Chrome|Chromium)\//.test(userAgent);
    assert(matches, `${browser} did not report the requested browser: ${userAgent}`);
    const report = await measure(page);
    return { ...report, browser: { name: browser, driver: browser === 'chromium' ? 'playwright' : 'webdriver-classic', userAgent } };
  } finally {
    try { await driver?.close(); }
    finally { await harness.close(); }
  }
}

export async function runEffectsMatrix() {
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = process.env.BROWSER || 'chromium';
const semanticsPath = new URL('../effect-hdr-semantics.json', import.meta.url);
const semantics = process.env.EFFECTS_MATRIX_EXPLORE
  ? { effects: {} }
  : JSON.parse(await readFile(semanticsPath, 'utf8'));
const W = 8;
const H = 4;

// Row 0: SDR grey ramp. Row 1: SDR colours. Row 2: extended range (above 1 and
// negative). Row 3: SDR colours with partial alpha. SDR values are k/255 so the
// rgba8unorm route starts from the same numbers.
const q = (v) => Math.round(v * 255) / 255;
const sdrRows = [
  Array.from({ length: W }, (_, x) => [q(x / 7), q(x / 7), q(x / 7), 1]),
  [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 0, 1], [0, 1, 1, 1], [1, 0, 1, 1],
    [q(0.8), q(0.4), q(0.2), 1], [q(0.2), q(0.6), q(0.9), 1]],
];
const hdrRow = [[1.5, 1.5, 1.5, 1], [4, 2, 1, 1], [8, 8, 8, 1], [-0.25, 0.5, 1.25, 1],
  [2, -0.1, 0.3, 1], [0.5, 3, 0.25, 1], [1.25, 1.25, 6, 1], [q(0.5), q(0.5), q(0.5), 1]];
const alphaRow = [[1, 0, 0, q(0.5)], [0, 1, 0, q(0.25)], [0, 0, 1, q(0.75)], [1, 1, 1, 0],
  [q(0.5), q(0.5), q(0.5), q(0.5)], [q(0.2), q(0.4), q(0.6), 1], [1, q(0.5), 0, q(0.1)], [0, 0, 0, 1]];
const floatInput = [...sdrRows, hdrRow, alphaRow].flat(2);
const sdrInput = [...sdrRows, sdrRows[0], alphaRow].flat(2);

const report = await withEffectsMatrixPage({ origin, browser, endpoint: process.env.WEBDRIVER_ENDPOINT }, async (page) =>
  page.evaluate(async ({ W, H, floatInput, sdrInput }) => {
    const { EffectsPipeline, GPU_EFFECT_REGISTRY, EFFECT_CLOCK_PARAM, getGpuEffectDefaultParams } =
      await import('/src/infrastructure/gpu-effects/index.ts');
    const { resolveAnimatedGpuEffects } =
      await import('/src/features/keyframes/utils/effect-animatable-properties.ts');
    const { buildEffectAnimatableProperty } = await import('/src/types/keyframe.ts');
    const { getGpuEffectInstances } = await import('/src/features/export/utils/canvas-effects.ts');
    const pipeline = await EffectsPipeline.create();
    if (!pipeline) throw new Error('WebGPU unavailable; effects matrix cannot run');
    const device = pipeline.getDevice();
    const adapter = device.adapterInfo ?? {};
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const inputs = {
      rgba16float: device.createTexture({ size: [W, H], format: 'rgba16float', usage }),
      rgba8unorm: device.createTexture({ size: [W, H], format: 'rgba8unorm', usage }),
    };
    device.queue.writeTexture({ texture: inputs.rgba16float }, new Float16Array(floatInput),
      { bytesPerRow: W * 8 }, [W, H]);
    device.queue.writeTexture({ texture: inputs.rgba8unorm },
      new Uint8Array(sdrInput.map((v) => Math.round(v * 255))), { bytesPerRow: W * 4 }, [W, H]);
    const sdrFloatInput = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    device.queue.writeTexture({ texture: sdrFloatInput }, new Float16Array(sdrInput),
      { bytesPerRow: W * 8 }, [W, H]);

    const render = async (source, effects) => {
      const output = device.createTexture({ size: [W, H], format: source.format, usage });
      const buffer = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        device.pushErrorScope('validation');
        const accepted = pipeline.applyTextureEffectsToTexture(source, effects, output, W, H);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [W, H]);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (!accepted) return { error: 'rejected' };
        if (error) return { error: error.message };
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const pixels = [];
        for (let y = 0; y < H; y++) {
          const row = source.format === 'rgba16float'
            ? new Float16Array(mapped, y * 256, W * 4)
            : new Uint8Array(mapped, y * 256, W * 4);
          for (const v of row) pixels.push(source.format === 'rgba16float' ? v : v / 255);
        }
        buffer.unmap();
        return { pixels };
      } finally {
        output.destroy();
        buffer.destroy();
      }
    };

    const instance = (id, params, entryId = 'fx') => ({
      id: entryId, type: id, name: id, enabled: true,
      params: { ...params, [EFFECT_CLOCK_PARAM]: 0.75 },
    });
    const cases = (definition) => {
      const defaults = getGpuEffectDefaultParams(definition.id);
      const list = [{ name: 'default', params: defaults }];
      for (const [key, param] of Object.entries(definition.params)) {
        if (param.type === 'number') {
          for (const bound of ['min', 'max']) {
            if (typeof param[bound] === 'number' && param[bound] !== param.default) {
              list.push({ name: `${key}=${bound}`, params: { ...defaults, [key]: param[bound] } });
            }
          }
        } else if (param.type === 'select') {
          for (const option of param.options ?? []) {
            if (option.value !== param.default) {
              list.push({ name: `${key}=${option.value}`, params: { ...defaults, [key]: option.value } });
            }
          }
        } else if (param.type === 'boolean') {
          list.push({ name: `${key}=${!param.default}`, params: { ...defaults, [key]: !param.default } });
        }
      }
      return list;
    };

    const effects = [];
    for (const definition of GPU_EFFECT_REGISTRY.values()) {
      const entry = { id: definition.id, category: definition.category, cases: [] };
      for (const { name, params } of cases(definition)) {
        const effect = [instance(definition.id, params)];
        // SDR project: Freecut's reference behaviour on both routes.
        pipeline.setWorkingRange('sdr');
        const floatSdr = await render(inputs.rgba16float, effect);
        const sdrFloat = await render(sdrFloatInput, effect);
        const sdr = await render(inputs.rgba8unorm, effect);
        // HDR project: extended range on the float route.
        pipeline.setWorkingRange('hdr');
        const float = await render(inputs.rgba16float, effect);
        const again = await render(inputs.rgba16float, effect);
        const hdrOnSdr = await render(sdrFloatInput, effect);
        const sdrInHdr = await render(inputs.rgba8unorm, effect);
        entry.cases.push({ name, float, again, floatSdr, sdrFloat, sdr, hdrOnSdr, sdrInHdr });
      }
      pipeline.setWorkingRange('hdr');

      // Animation: keyframe the first animatable numeric parameter between its
      // extremes through the production keyframe resolver.
      const animatable = Object.entries(definition.params).find(([, param]) =>
        param.type === 'number' && param.animatable !== false &&
        typeof param.min === 'number' && typeof param.max === 'number');
      if (animatable) {
        const [key, param] = animatable;
        const defaults = getGpuEffectDefaultParams(definition.id);
        const itemEffect = { id: 'fx', enabled: true,
          effect: { type: 'gpu-effect', gpuEffectType: definition.id, params: defaults } };
        const keyframes = { itemId: 'clip', properties: [{
          property: buildEffectAnimatableProperty(definition.id, 'fx', key),
          keyframes: [
            { id: 'start', frame: 0, value: param.min, easing: 'linear' },
            { id: 'end', frame: 10, value: param.max, easing: 'linear' },
          ],
        }] };
        const frames = {};
        for (const frame of [0, 5, 10]) {
          const resolved = getGpuEffectInstances(resolveAnimatedGpuEffects([itemEffect], keyframes, frame));
          const value = resolved[0]?.params?.[key];
          const rendered = await render(sdrFloatInput,
            resolved.map((e) => ({ ...e, params: { ...e.params, [EFFECT_CLOCK_PARAM]: 0.75 } })));
          frames[frame] = { value, ...rendered };
        }
        const statics = {};
        for (const bound of ['min', 'max']) {
          statics[bound] = await render(sdrFloatInput, [instance(definition.id, { ...defaults, [key]: param[bound] })]);
        }
        entry.animation = { key, min: param.min, max: param.max, frames, statics };
      }

      // Stack order: this effect then Brightness equals the two applied in turn.
      const withBrightness = [instance(definition.id, getGpuEffectDefaultParams(definition.id), 'a'),
        instance('gpu-brightness', { amount: 0.1 }, 'b')];
      const stacked = await render(sdrFloatInput, withBrightness);
      const firstOnly = await render(sdrFloatInput, [withBrightness[0]]);
      let sequential = { error: firstOnly.error };
      if (firstOnly.pixels) {
        const intermediate = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
        device.queue.writeTexture({ texture: intermediate }, new Float16Array(firstOnly.pixels),
          { bytesPerRow: W * 8 }, [W, H]);
        sequential = await render(intermediate, [withBrightness[1]]);
        intermediate.destroy();
      }
      entry.stack = { stacked, sequential };

      // Invalid parameters (FL-99): each set draws exactly as its declared meaning, the
      // test's own restatement of the contract (not the engine's sanitiser): a finite
      // number outside [min, max] is clamped, a non-finite number, an unknown select
      // option and a non-boolean flag fall back to the default.
      const declared = getGpuEffectDefaultParams(definition.id);
      const invalidSets = {
        'non-finite-and-unknown': (key, param) => param.type === 'number' ? Number.NaN
          : param.type === 'select' ? 'not-an-option' : param.type === 'boolean' ? 'yes' : undefined,
        'below-range': (key, param) => param.type === 'number' && typeof param.min === 'number' ? param.min - 1000 : undefined,
        'above-range': (key, param) => param.type === 'number' && typeof param.max === 'number' ? param.max + 1000 : undefined,
        infinite: (key, param) => param.type === 'number' ? Number.POSITIVE_INFINITY : undefined,
      };
      entry.invalid = [];
      for (const [name, pick] of Object.entries(invalidSets)) {
        const given = { ...declared };
        const meant = { ...declared };
        let touched = 0;
        for (const [key, param] of Object.entries(definition.params)) {
          const value = pick(key, param);
          if (value === undefined) continue;
          touched++;
          given[key] = value;
          meant[key] = param.type === 'number' && Number.isFinite(value)
            ? Math.min(param.max ?? Infinity, Math.max(param.min ?? -Infinity, value)) : param.default;
        }
        if (touched === 0) continue;
        const got = await render(sdrFloatInput, [instance(definition.id, given)]);
        const want = await render(sdrFloatInput, [instance(definition.id, meant)]);
        entry.invalid.push({ name, touched, got, want });
      }
      // A parameter the effect does not declare is ignored.
      entry.invalid.push({ name: 'undeclared', touched: 1,
        got: await render(sdrFloatInput, [instance(definition.id, { ...declared, 'not-a-parameter': Number.NaN })]),
        want: await render(sdrFloatInput, [instance(definition.id, declared)]) });
      effects.push(entry);
    }
    // An unknown effect id is skipped: the input passes through unchanged.
    const unknownEffect = { ...(await render(sdrFloatInput, [instance('gpu-not-an-effect', {})])),
      input: Array.from(new Float16Array(sdrInput)) };
    pipeline.destroy();
    for (const texture of [...Object.values(inputs), sdrFloatInput]) texture.destroy();
    device.destroy();
    return { adapter: { vendor: adapter.vendor, architecture: adapter.architecture }, effects, unknownEffect };
  }, { W, H, floatInput, sdrInput }),
);

if (process.env.EFFECTS_MATRIX_REPORT) {
  await writeFile(process.env.EFFECTS_MATRIX_REPORT, JSON.stringify(report));
}
if (process.env.EFFECTS_MATRIX_EXPLORE) return;

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const declared = new Map(Object.entries(semantics.effects));
const ids = report.effects.map((effect) => effect.id);
assert.deepEqual([...declared.keys()].sort(), [...ids].sort(),
  'effect-hdr-semantics.json must declare every registered GPU effect exactly once');
const pixelIndex = (x, y) => (y * W + x) * 4;
const rows = (pixels, wanted) => wanted.flatMap((y) => pixels.slice(pixelIndex(0, y), pixelIndex(0, y + 1)));
let caseCount = 0;
for (const effect of report.effects) {
  const rule = declared.get(effect.id);
  let extendedSeen = false;
  for (const entry of effect.cases) {
    caseCount++;
    const label = `${effect.id} [${entry.name}]`;
    const routes = ['float', 'again', 'floatSdr', 'sdrFloat', 'sdr', 'hdrOnSdr', 'sdrInHdr'];
    for (const route of routes) check(!entry[route].error, `${label} ${route}: ${entry[route].error}`);
    if (routes.some((route) => entry[route].error)) continue;
    // The rgba8unorm route is physically SDR in every project.
    check(entry.sdrInHdr.pixels.every((v, i) => v === entry.sdr.pixels[i]),
      `${label}: an HDR project changed the rgba8unorm route`);
    // In an HDR project, in-range results agree with the SDR project; only the
    // values the SDR project clipped may differ.
    const eps = 2e-3;
    let disagreements = 0;
    entry.sdrFloat.pixels.forEach((v, i) => {
      if (v > eps && v < 1 - eps && Math.abs(v - entry.hdrOnSdr.pixels[i]) > eps) disagreements++;
    });
    check(disagreements === 0, `${label}: ${disagreements} in-range channels differ between SDR and HDR projects`);
    // SDR projects keep upstream clamps for the effects declared so.
    if (rule.hdr !== 'bounded' && rule.sdrClamped) {
      const sdrHdrRow = rows(entry.floatSdr.pixels, [2]).filter((_, i) => i % 4 !== 3);
      check(sdrHdrRow.every((v) => v >= -1e-3 && v <= 1 + 1e-3), `${label}: SDR project left [0, 1]`);
    }
    check(entry.float.pixels.every(Number.isFinite), `${label}: non-finite float output`);
    check(entry.float.pixels.every((v, i) => Object.is(v, entry.again.pixels[i])),
      `${label}: two renders of the same frame differ`);
    // SDR reference behaviour: in-range float result equals the 8-bit route.
    if (rule.sdrParity) {
      const tolerance = rule.sdrTolerance ?? 2 / 255;
      const budget = rule.sdrMismatchBudget ?? 0;
      let mismatches = 0;
      entry.sdrFloat.pixels.forEach((v, i) => {
        const expected = Math.min(1, Math.max(0, v));
        if (Math.abs(expected - entry.sdr.pixels[i]) > tolerance) mismatches++;
      });
      check(mismatches <= budget, `${label}: ${mismatches} channels differ from the rgba8 SDR route`);
    }
    // HDR class on the extended-range row (row 2), colour channels only.
    const hdr = rows(entry.float.pixels, [2]).filter((_, i) => i % 4 !== 3);
    if (rule.hdr === 'bounded' || (rule.hdr === 'palette' && entry.name === 'default')) {
      check(hdr.every((v) => v >= -1e-3 && v <= 1 + 1e-3), `${label}: declared ${rule.hdr} but left [0, 1]`);
    }
    if (Math.max(...hdr) > 1.01) extendedSeen = true;
  }
  if (rule.hdr === 'extended') {
    check(extendedSeen, `${effect.id}: declared extended but no case kept light above reference white`);
  }
  if (effect.animation) {
    const { frames, statics, key } = effect.animation;
    const label = `${effect.id} animated ${key}`;
    check(frames[0].value === effect.animation.min && frames[10].value === effect.animation.max,
      `${label}: keyframes did not resolve to the extremes`);
    if (!frames[0].error && !statics.min.error) {
      check(frames[0].pixels.every((v, i) => Object.is(v, statics.min.pixels[i])), `${label}: frame 0 != static min`);
      check(frames[10].pixels.every((v, i) => Object.is(v, statics.max.pixels[i])), `${label}: frame 10 != static max`);
    }
    check(Math.abs(frames[5].value - (effect.animation.min + effect.animation.max) / 2) < 1e-9,
      `${label}: midpoint keyframe value`);
  }
  const { stacked, sequential } = effect.stack;
  if (!stacked.error && !sequential.error) {
    const worst = Math.max(...stacked.pixels.map((v, i) => Math.abs(v - sequential.pixels[i])));
    check(worst <= 2e-3, `${effect.id}: stacked chain differs from sequential application by ${worst}`);
  } else {
    check(false, `${effect.id}: stack render failed (${stacked.error ?? sequential.error})`);
  }
}
// Invalid parameters and an unknown effect id (FL-99).
for (const effect of report.effects) {
  check(effect.invalid.length > 0, `${effect.id}: no invalid-parameter case measured`);
  for (const { name, got, want } of effect.invalid) {
    if (got.error || want.error) {
      check(false, `${effect.id} invalid ${name}: ${got.error ?? want.error}`);
      continue;
    }
    check(got.pixels.every(Number.isFinite), `${effect.id} invalid ${name}: non-finite output`);
    check(got.pixels.every((v, i) => Object.is(v, want.pixels[i])),
      `${effect.id} invalid ${name}: does not draw as the declared meaning`);
  }
}
check(!report.unknownEffect.error && report.unknownEffect.pixels.every((v, i) => Object.is(v, report.unknownEffect.input[i])),
  `unknown effect id did not pass the input through: ${report.unknownEffect.error ?? ''}`);
if (failures.length) {
  console.error(failures.join('\n'));
  assert.fail(`${failures.length} effects-matrix failures on ${report.adapter.vendor}/${report.adapter.architecture}`);
}
console.log(JSON.stringify({ check: 'every GPU effect: parameter extremes, determinism, SDR parity, HDR class, animation, stack order, invalid parameters',
  browser: report.browser, adapter: report.adapter, effects: report.effects.length, cases: caseCount,
  invalid: report.effects.reduce((sum, effect) => sum + effect.invalid.length, 0) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runEffectsMatrix();
