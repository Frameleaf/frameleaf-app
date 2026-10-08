// All registered effects: real pinned SDR measurements, linear HDR brightness/contrast and typed refusals.
// HDR refusals never qualify rendered HDR fixtures. Historical encoded-HDR classifications
// are retained in effect-hdr-semantics.json; current HDR is linear display-referred BT.709.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { photometricCases, photometricInput, linearColorCases, photometricTolerance, validatePhotometricResults } from './photometric-goldens.mjs';
import { blurReference, HDR_BLURS } from './blur-reference.mjs';
import { testedSource, domainObservations } from './lib/working-domain-report.mjs';
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
const source = await testedSource(new URL(import.meta.url));
// Per-file hosted adapted-source evidence gate, independent of the whole source
// digest (unrelated approved runtime policy changes may alter that digest).
const photometricSource = {};
for (const [file, expected] of Object.entries({
  'effects/color.ts': '53e8a9b6c748a9c04bfa02edad3d068e14872c5ff9652912ec42e1d6e8e85d5c',
  'common.ts': '5cfea24579d6e76b145ac88d9d20dc31334a62fd88d5cf56f16a0b1f13df8c62',
  'effects/blur.ts': 'd74a29218cc2a0d77ff0a150b81865bb127ab753e6d129d4b20fd6d626c0d416',
  // The shared HDR gate admits reviewed operators and decodes SDR ingress first.
  // Pinned SDR colour and spatial branches remain unchanged; HDR sampling is independently measured.
  'effects-pipeline.ts': '9e40a07734722195000eaeba6cb44f407ed91daac56f33d38ea3f416b6590fec',
})) {
  const observed = createHash('sha256').update(await readFile(new URL(`../engine/src/infrastructure/gpu-effects/${file}`, import.meta.url))).digest('hex');
  assert.equal(observed, expected, `photometric source contract changed: ${file}; numerical qualification requires source review`);
  photometricSource[file] = observed;
}
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
  page.evaluate(async ({ W, H, floatInput, sdrInput, photometricCases, photometricInput, linearColorCases }) => {
    const { HdrRenderUnavailableError } = await import('/src/shared/graphics/color/managed-color.ts');
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
        let accepted;
        try { accepted = pipeline.applyTextureEffectsToTexture(source, effects, output, W, H); }
        catch (error) {
          const validation = await device.popErrorScope();
          if (validation) throw new Error(validation.message);
          if (!(error instanceof HdrRenderUnavailableError)) throw error;
          return { outcome: 'refused', errorType: error.name, message: error.message };
        }
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
      if (['gpu-box-blur','gpu-gaussian-blur','gpu-motion-blur'].includes(definition.id)) entry.hdrSpatial = { cases: [], invalid: [], defaults: getGpuEffectDefaultParams(definition.id) };
      if (['gpu-brightness','gpu-contrast','gpu-exposure','gpu-saturation'].includes(definition.id)) entry.hdr = { cases: [], invalid: [] };
      const hdr = entry.hdr ?? entry.hdrSpatial;
      for (const { name, params } of cases(definition)) {
        const effect = [instance(definition.id, params)];
        // SDR project: Freecut's reference behaviour on both routes.
        pipeline.setWorkingRange('sdr');
        const floatSdr = await render(inputs.rgba16float, effect);
        const sdrFloat = await render(sdrFloatInput, effect);
        const sdr = await render(inputs.rgba8unorm, effect);
        const again = await render(sdrFloatInput, effect);
        entry.cases.push({ name, again, floatSdr, sdrFloat, sdr });
        if (hdr) {
          pipeline.setWorkingRange('hdr');
          hdr.cases.push({ name, amount: params.amount, params, ...await render(inputs.rgba16float, effect) });
        }
      }
      pipeline.setWorkingRange('hdr');
      if (!hdr) entry.hdrRefusal = await render(inputs.rgba16float, [instance(definition.id, getGpuEffectDefaultParams(definition.id))]);
      pipeline.setWorkingRange('sdr');

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
        const hdrFrames = {};
        for (const frame of [0, 5, 10]) {
          const resolved = getGpuEffectInstances(resolveAnimatedGpuEffects([itemEffect], keyframes, frame));
          const value = resolved[0]?.params?.[key];
          const rendered = await render(sdrFloatInput,
            resolved.map((e) => ({ ...e, params: { ...e.params, [EFFECT_CLOCK_PARAM]: 0.75 } })));
          frames[frame] = { value, ...rendered };
          if (hdr) {
            pipeline.setWorkingRange('hdr');
            hdrFrames[frame] = { value, ...await render(inputs.rgba16float, resolved) };
            pipeline.setWorkingRange('sdr');
          }
        }
        const statics = {};
        for (const bound of ['min', 'max']) {
          statics[bound] = await render(sdrFloatInput, [instance(definition.id, { ...defaults, [key]: param[bound] })]);
        }
        entry.animation = { key, min: param.min, max: param.max, frames, statics };
        if (hdr) hdr.animation = { key, min: param.min, max: param.max, frames: hdrFrames };
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
      if (entry.hdr) {
        pipeline.setWorkingRange('hdr');
        const chain = [instance(definition.id, definition.id === 'gpu-exposure' ? {exposure:1,offset:.125,gamma:2} : { amount: definition.id !== 'gpu-brightness' ? 1.5 : .125 }, 'a'), definition.id === 'gpu-saturation' ? instance('gpu-exposure',{exposure:1,offset:.125,gamma:2},'b') : instance('gpu-brightness', { amount: definition.id === 'gpu-brightness' ? -.25 : .125 }, 'b')];
        const stacked = await render(inputs.rgba16float, chain);
        const first = await render(inputs.rgba16float, [chain[0]]);
        if (!first.pixels) throw new Error(`linear ${definition.id} first pass failed`);
        const intermediate = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
        device.queue.writeTexture({ texture: intermediate }, new Float16Array(first.pixels), { bytesPerRow: W * 8 }, [W, H]);
        if (definition.id !== 'gpu-brightness') {
          const limitInput = device.createTexture({ size: [W,H], format: 'rgba16float', usage });
          device.queue.writeTexture({texture:limitInput},new Float16Array(Array.from({length:W*H},(_,i)=>[65504,-65504,.5,i%2 ? .5 : 0]).flat()),{bytesPerRow:W*8},[W,H]);
          try { entry.hdr.rangeLimit=await render(limitInput,[instance(definition.id,definition.id === 'gpu-exposure' ? {exposure:3,offset:.5,gamma:.2} : {amount:3})]); }
          finally { limitInput.destroy(); }
        }
        try { entry.hdr.stack = { stacked, sequential: await render(intermediate, [chain[1]]) };
          if (definition.id !== 'gpu-brightness') entry.hdr.stack.reverse = await render(inputs.rgba16float, [...chain].reverse());
        }
        finally { intermediate.destroy(); pipeline.setWorkingRange('sdr'); }
      }

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
        if (hdr) {
          pipeline.setWorkingRange('hdr');
          hdr.invalid.push({ name, amount: meant.amount, params: meant,
            got: await render(inputs.rgba16float, [instance(definition.id, given)]),
            want: await render(inputs.rgba16float, [instance(definition.id, meant)]) });
          pipeline.setWorkingRange('sdr');
        }
      }
      if (entry.hdrSpatial) {
        pipeline.setWorkingRange('hdr');
        const blur = instance(definition.id, getGpuEffectDefaultParams(definition.id));
        const exposure = instance('gpu-exposure', { exposure: 1, offset: 0, gamma: 1 }, 'exposure');
        entry.hdrSpatial.stack = await render(inputs.rgba16float, [blur, exposure]);
        pipeline.setWorkingRange('sdr');
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
    // Additional independent numerical qualification; existing registry cases,
    // animation, SDR parity, stacks and invalid-parameter oracles stay intact.
    const numericalInput = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    device.queue.writeTexture({ texture: numericalInput }, new Float16Array(photometricInput),
      { bytesPerRow: W * 8 }, [W, H]);
    pipeline.setWorkingRange('sdr');
    const photometric = [];
    for (const entry of photometricCases) {
      if (!GPU_EFFECT_REGISTRY.has(entry.id)) throw new Error(`missing numerical node ${entry.id}`);
      photometric.push({ ...entry, ...await render(numericalInput, [instance(entry.id, entry.params)]) });
    }
    pipeline.setWorkingRange('hdr');
    const linearColor = [];
    for (const entry of linearColorCases)
      linearColor.push({ ...entry, ...await render(numericalInput, [instance(entry.id, entry.params)]) });
    numericalInput.destroy();
    pipeline.destroy();
    for (const texture of [...Object.values(inputs), sdrFloatInput]) texture.destroy();
    device.destroy();
    return { adapter: { vendor: adapter.vendor, architecture: adapter.architecture }, effects, unknownEffect, photometric, linearColor };
  }, { W, H, floatInput, sdrInput, photometricCases, photometricInput, linearColorCases }),
);
report.photometricSource = photometricSource;

if (process.env.EFFECTS_MATRIX_REPORT) {
  await writeFile(process.env.EFFECTS_MATRIX_REPORT, JSON.stringify(report));
}
if (process.env.EFFECTS_MATRIX_EXPLORE) return;

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const photometric = validatePhotometricResults(report.photometric, 'srgb-display-bt709');
const linearColor = validatePhotometricResults(report.linearColor, 'linear-display-bt709-v1');
const declared = new Map(Object.entries(semantics.effects));
const ids = report.effects.map((effect) => effect.id);
assert.deepEqual([...declared.keys()].sort(), [...ids].sort(),
  'effect-hdr-semantics.json must declare every registered GPU effect exactly once');
const pixelIndex = (x, y) => (y * W + x) * 4;
const rows = (pixels, wanted) => wanted.flatMap((y) => pixels.slice(pixelIndex(0, y), pixelIndex(0, y + 1)));
let caseCount = 0;
for (const effect of report.effects) {
  const rule = declared.get(effect.id);
  if (['gpu-brightness','gpu-contrast','gpu-exposure','gpu-saturation'].includes(effect.id)) {
    check(rule.hdr === 'linear-display-bt709-v1', `${effect.id} must declare the measured linear domain`);
    const input = Array.from(new Float16Array(floatInput));
    const transform = (v, p, i, values) => {
      if (effect.id === 'gpu-saturation') {const at=i-i%4;const gray=.299*values[at]+.587*values[at+1]+.114*values[at+2];return gray+(v-gray)*p.amount;}
      if (effect.id === 'gpu-exposure') {const x=v*2**p.exposure+p.offset;return Math.sign(x)*Math.abs(x)**(1/p.gamma);}
      return effect.id === 'gpu-contrast' ? (v-.5)*p.amount+.5 : v+p.amount;
    };
    const expected = (params,values=input) => values.map((v, i) => i % 4 === 3 ? v : Math.max(-65504, Math.min(65504, transform(v,params,i,values))));
    const pixels = (result, want, label) => {
      check(!result.error && !result.errorType && result.pixels?.length === want.length, `${label}: linear render failed`);
      if (result.pixels) want.forEach((v,i) => check(Number.isFinite(result.pixels[i]) && Math.abs(result.pixels[i]-v) <= photometricTolerance(v,i), `${label}: independent channel ${i}`));
    };
    check(effect.hdr.cases.length === (effect.id === 'gpu-exposure' ? 7 : 3), `${effect.id} requires default/min/max HDR cases`);
    if (effect.id === 'gpu-exposure') check(JSON.stringify(effect.hdr.cases.map(e=>e.params)) === JSON.stringify([
      {exposure:0,offset:0,gamma:1},{exposure:-3,offset:0,gamma:1},{exposure:3,offset:0,gamma:1},
      {exposure:0,offset:-.5,gamma:1},{exposure:0,offset:.5,gamma:1},{exposure:0,offset:0,gamma:.2},{exposure:0,offset:0,gamma:3},
    ]),'HDR exposure must retain declared EV/offset/gamma defaults and limits');
    for (const entry of effect.hdr.cases) pixels(entry, expected(entry.params), `HDR ${effect.id} ${entry.name}`);
    for (const frame of [0,5,10]) {
      const entry = effect.hdr.animation.frames[frame];
      check(entry.value === (effect.id === 'gpu-exposure' ? [-3,0,3] : effect.id !== 'gpu-brightness' ? [0,1.5,3] : [-1,0,1])[frame/5], `HDR ${effect.id} animation ${frame}: resolver`);
      pixels(entry, expected(effect.id === 'gpu-exposure' ? {exposure:entry.value,offset:0,gamma:1} : {amount:entry.value}), `HDR ${effect.id} animation ${frame}`);
    }
    const firstParams=effect.id === 'gpu-exposure' ? {exposure:1,offset:.125,gamma:2} : {amount:effect.id !== 'gpu-brightness' ? 1.5 : .125};
    const first = Array.from(new Float16Array(expected(firstParams)));
    const stackWant = first.map((v,i) => i % 4 === 3 ? v : effect.id === 'gpu-saturation' ? Math.sign(v*2+.125)*Math.abs(v*2+.125)**.5 : v+(effect.id === 'gpu-brightness' ? -.25 : .125));
    for (const route of ['stacked','sequential']) pixels(effect.hdr.stack[route],stackWant,`HDR ${effect.id} ${route}`);
    if (effect.id !== 'gpu-brightness') {
      const lifted = Array.from(new Float16Array(input.map((v,i) => i%4 === 3 ? v : effect.id === 'gpu-saturation' ? Math.sign(v*2+.125)*Math.abs(v*2+.125)**.5 : v+.125)));
      const reverseWant = expected(firstParams,lifted);
      pixels(effect.hdr.stack.reverse,reverseWant,`HDR ${effect.id} reverse mixed stack`);
      const limits=Array.from({length:W*H},(_,i)=>[65504,-65504,.5,i%2 ? .5 : 0]).flat();
      pixels(effect.hdr.rangeLimit,expected(effect.id === 'gpu-exposure' ? {exposure:3,offset:.5,gamma:.2} : {amount:3},limits),`HDR ${effect.id} binary16 signed limit and hidden RGB`);
      check(stackWant.some((v,i) => i%4 !== 3 && Math.abs(v-reverseWant[i])>.05),'mixed HDR stack must discriminate order');
    }
    check(effect.hdr.invalid.length === 4, `${effect.id} requires all HDR invalid-number contracts`);
    for (const entry of effect.hdr.invalid) {
      pixels(entry.got,expected(entry.params),`HDR ${effect.id} invalid ${entry.name}`);
      pixels(entry.want,expected(entry.params),`HDR ${effect.id} invalid meaning ${entry.name}`);
    }
  } else if (HDR_BLURS.includes(effect.id)) {
    check(rule.hdr === 'linear-display-bt709-v1', `${effect.id}: linear domain required`);
    const input = Array.from(new Float16Array(floatInput));
    const pixels = (result, want, label) => {
      check(!result.error && !result.errorType && result.pixels?.length === want.length, `${label}: linear render failed`);
      if (result.pixels) want.forEach((v,i) => check(Number.isFinite(result.pixels[i]) && Math.abs(result.pixels[i]-v) <= Math.max(.004,Math.abs(v)*.003), `${label}: independent channel ${i}`));
    };
    check(effect.hdrSpatial.cases.length === effect.cases.length, `${effect.id}: every parameter bound requires HDR measurement`);
    for (const entry of effect.hdrSpatial.cases) pixels(entry, blurReference(input,W,H,effect.id,entry.params), `HDR ${effect.id} ${entry.name}`);
    const { key, min, max, frames } = effect.hdrSpatial.animation;
    for (const frame of [0,5,10]) {
      check(frames[frame].value === min+(max-min)*frame/10, `${effect.id}: HDR animation resolver`);
      pixels(frames[frame],blurReference(input,W,H,effect.id,{...effect.hdrSpatial.defaults,[key]:frames[frame].value}), `HDR ${effect.id} animation ${frame}`);
    }
    for (const entry of effect.hdrSpatial.invalid) {
      const expected = blurReference(input,W,H,effect.id,entry.params);
      pixels(entry.got,expected,`HDR ${effect.id} invalid ${entry.name}`);
      pixels(entry.want,expected,`HDR ${effect.id} invalid meaning ${entry.name}`);
    }
    const filtered = Array.from(new Float16Array(blurReference(input,W,H,effect.id,effect.hdrSpatial.defaults)));
    pixels(effect.hdrSpatial.stack,filtered.map((v,i)=>i%4===3?v:v*2),`HDR ${effect.id} exposure stack`);
  } else {
    check(rule.hdr === 'refused', `${effect.id}: undeclared HDR admission`);
    check(effect.hdrRefusal.errorType === 'HdrRenderUnavailableError', `${effect.id}: missing typed HDR refusal`);
  }
  for (const entry of effect.cases) {
    caseCount++;
    const label = `${effect.id} [${entry.name}]`;
    if(effect.id==='gpu-saturation') {
      const amount=entry.name==='default'?1:entry.name==='amount=min'?0:3;
      const encoded=Array.from(new Float16Array(sdrInput));
      encoded.forEach((v,i)=>{const at=i-i%4,gray=.299*encoded[at]+.587*encoded[at+1]+.114*encoded[at+2];const want=i%4===3?v:Math.max(0,Math.min(1,gray+(v-gray)*amount));check(Math.abs(entry.sdrFloat.pixels[i]-want)<=photometricTolerance(want,i),`${label}: pinned encoded SDR saturation ${i}`);});
    }
    const routes = ['again', 'floatSdr', 'sdrFloat', 'sdr'];
    for (const route of routes) check(!entry[route].error, `${label} ${route}: ${entry[route].error}`);
    if (routes.some((route) => entry[route].error)) continue;
    // SDR projects keep upstream clamps for the effects declared so.
    if (rule.sdrClamped) {
      const sdrHdrRow = rows(entry.floatSdr.pixels, [2]).filter((_, i) => i % 4 !== 3);
      check(sdrHdrRow.every((v) => v >= -1e-3 && v <= 1 + 1e-3), `${label}: SDR project left [0, 1]`);
    }
    check(entry.sdrFloat.pixels.every(Number.isFinite), `${label}: non-finite float output`);
    check(entry.sdrFloat.pixels.every((v, i) => Object.is(v, entry.again.pixels[i])),
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
assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
Object.assign(report, { schemaVersion: 1, kind: 'studio-domain-regression', result: 'passed', source });
report.observations = domainObservations(report);
if (process.env.EFFECTS_MATRIX_REPORT) await writeFile(process.env.EFFECTS_MATRIX_REPORT, JSON.stringify(report));
console.log(JSON.stringify({ check: 'every GPU effect: SDR parameter extremes, independent math, determinism, parity, animation, stack order, invalid parameters; linear HDR tone and alpha-aware spatial blur and remaining typed refusals',
  browser: report.browser, adapter: report.adapter, effects: report.effects.length, cases: caseCount,
  photometric, linearColor, photometricSource,
  invalid: report.effects.reduce((sum, effect) => sum + effect.invalid.length, 0) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runEffectsMatrix();
