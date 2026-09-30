// FL-99 / FL-97: every blend mode through the production media-blend pipeline
// (the compositor shares the same WGSL) on software WebGPU in CI.
// - SDR projects match the pinned reference: Freecut 4d62e80's formulas,
//   restated below, on both the legacy rgba8unorm route and the float route.
// - HDR projects' float route keeps out-of-range values with the declared semantics
//   (arithmetic modes unclamped, soft light signed, [0, 1]-defined modes carry
//   the base's out-of-range offset), checked against the same reference.
// - Every result is finite and re-renders bit-identically; dissolve coverage is
//   all-or-nothing per pixel.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const MODES = ['normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'lighten',
  'screen', 'color-dodge', 'linear-dodge', 'overlay', 'soft-light', 'hard-light', 'vivid-light',
  'linear-light', 'pin-light', 'hard-mix', 'difference', 'exclusion', 'subtract', 'divide', 'hue',
  'saturation', 'color', 'luminosity'];
const W = 8;
const H = 4;
const q = (v) => Math.round(v * 255) / 255;
// Base: grey ramp, colours, extended range (float only), SDR with partial alpha.
const baseRows = [
  Array.from({ length: W }, (_, x) => [q(x / 7), q(x / 7), q(x / 7), 1]),
  [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [q(0.9), q(0.6), q(0.1), 1], [q(0.3), q(0.8), q(0.7), 1],
    [q(0.5), q(0.5), q(0.5), 1], [q(0.8), q(0.4), q(0.2), 1], [q(0.2), q(0.6), q(0.9), 1]],
  [[1.5, 1.5, 1.5, 1], [4, 2, 1, 1], [8, 0.5, 0.25, 1], [-0.25, 0.5, 1.25, 1],
    [2, -0.1, 0.3, 1], [0.5, 3, 0.25, 1], [1.25, 1.25, 6, 1], [-0.5, -0.25, 2, 1]],
  [[q(0.6), q(0.2), q(0.4), q(0.5)], [q(0.1), q(0.9), q(0.3), q(0.25)], [q(0.7), q(0.7), q(0.2), 1],
    [q(0.4), q(0.1), q(0.8), 0], [q(0.5), q(0.5), q(0.5), q(0.75)], [q(0.2), q(0.4), q(0.6), 1],
    [1, q(0.5), 0, q(0.5)], [0, 0, 0, 1]],
];
// Layer: exact branch points (0, 0.5, 1) and mid values, opaque and translucent.
const layerRow = (alpha) => [[0, 0, 0, alpha], [1, 1, 1, alpha], [q(0.5), q(0.5), q(0.5), alpha],
  [q(0.25), q(0.75), q(0.4), alpha], [q(0.8), q(0.2), q(0.6), alpha], [q(0.1), q(0.3), q(0.9), alpha],
  [q(0.6), q(0.6), q(0.1), alpha], [q(0.35), q(0.15), q(0.55), alpha]];
const layerRows = [layerRow(1), layerRow(1), layerRow(1), layerRow(q(0.5))];
const sdrBaseRows = [baseRows[0], baseRows[1], baseRows[0], baseRows[3]];

const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let report;
try {
  const page = await browser.newPage();
  await page.route(origin + '/blend-matrix', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Blend matrix</title>' }),
  );
  await page.goto(origin + '/blend-matrix');
  report = await page.evaluate(async ({ W, H, MODES, base, sdrBase, layer }) => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { MediaBlendPipeline } = await import('/src/infrastructure/gpu-media/media-blend-pipeline.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('WebGPU unavailable; blend matrix cannot run');
    const blend = new MediaBlendPipeline(device);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const upload = (values, format) => {
      const texture = device.createTexture({ size: [W, H], format, usage });
      if (format === 'rgba16float') {
        device.queue.writeTexture({ texture }, new Float16Array(values), { bytesPerRow: W * 8 }, [W, H]);
      } else {
        device.queue.writeTexture({ texture }, new Uint8Array(values.map((v) => Math.round(v * 255))),
          { bytesPerRow: W * 4 }, [W, H]);
      }
      return texture;
    };
    const inputs = {
      rgba16float: { base: upload(base, 'rgba16float'), layer: upload(layer, 'rgba16float') },
      rgba8unorm: { base: upload(sdrBase, 'rgba8unorm'), layer: upload(layer, 'rgba8unorm') },
    };
    const render = async (format, mode, range = 'sdr') => {
      blend.setWorkingRange(range);
      const output = device.createTexture({ size: [W, H], format, usage });
      const buffer = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        device.pushErrorScope('validation');
        const accepted = blend.blend(inputs[format].base, inputs[format].layer, output, mode);
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
          const row = format === 'rgba16float'
            ? new Float16Array(mapped, y * 256, W * 4) : new Uint8Array(mapped, y * 256, W * 4);
          for (const v of row) pixels.push(format === 'rgba16float' ? v : v / 255);
        }
        buffer.unmap();
        return { pixels, inputs: format === 'rgba16float' ? null : null };
      } finally {
        output.destroy();
        buffer.destroy();
      }
    };
    const results = [];
    for (const mode of MODES) {
      results.push({
        mode,
        // HDR project: float route with extended semantics.
        float: await render('rgba16float', mode, 'hdr'),
        again: await render('rgba16float', mode, 'hdr'),
        // SDR project: Freecut's semantics on the float route and on rgba8unorm.
        floatSdr: await render('rgba16float', mode, 'sdr'),
        sdr: await render('rgba8unorm', mode, 'sdr'),
        sdrInHdr: await render('rgba8unorm', mode, 'hdr'),
      });
    }
    // The float inputs as the GPU holds them (half precision).
    const f16 = (values) => Array.from(new Float16Array(values));
    blend.destroy();
    for (const set of Object.values(inputs)) { set.base.destroy(); set.layer.destroy(); }
    const info = (await navigator.gpu.requestAdapter())?.info ?? {};
    return { adapter: { vendor: info.vendor, architecture: info.architecture }, results,
      base16: f16(base), layer16: f16(layer) };
  }, { W, H, MODES, base: baseRows.flat(2), sdrBase: sdrBaseRows.flat(2), layer: layerRows.flat(2) });
} finally {
  await browser.close();
}

// Raw measurements for conformance evidence, written before any assertion.
if (process.env.BLEND_MATRIX_REPORT) await writeFile(process.env.BLEND_MATRIX_REPORT, JSON.stringify(report));

// ─── Pinned reference: Freecut 4d62e80 blend-modes.ts, per component ───
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const rgb2hsl = ([r, g, b]) => {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  // Freecut's rgb2hsl picks the saturation denominators the other way round
  // from CSS/W3C HSL. That is the pinned reference, so it is restated as is.
  const d = mx - mn; const s = l > 0.5 ? d / (mx + mn) : d / (2 - mx - mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
};
const hue2rgb = (p, qq, t) => {
  let tt = t; if (tt < 0) tt += 1; if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (qq - p) * 6 * tt; if (tt < 1 / 2) return qq;
  if (tt < 2 / 3) return p + (qq - p) * (2 / 3 - tt) * 6; return p;
};
const hsl2rgb = ([h, s, l]) => {
  if (s === 0) return [l, l, l];
  const qq = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - qq;
  return [hue2rgb(p, qq, h + 1 / 3), hue2rgb(p, qq, h), hue2rgb(p, qq, h - 1 / 3)];
};
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const setLum = (c, l) => {
  const d = l - lum(c); let r = c.map((v) => v + d);
  const mn = Math.min(...r); const mx = Math.max(...r); const ll = lum(r);
  if (mn < 0) r = r.map((v) => ll + (v - ll) * ll / (ll - mn));
  if (mx > 1) r = r.map((v) => ll + (v - ll) * (1 - ll) / (mx - ll));
  return r;
};
const each = (fn) => (b, l) => b.map((v, i) => fn(v, l[i]));
const burn = (b, l) => (l === 0 ? 0 : 1 - Math.min(1, (1 - b) / Math.max(l, 0.001)));
const dodge = (b, l) => (l === 1 ? 1 : Math.min(1, b / Math.max(1 - l, 0.001)));
const formulas = {
  normal: (b, l) => l,
  dissolve: (b, l) => l,
  darken: each(Math.min),
  multiply: each((b, l) => b * l),
  'color-burn': each(burn),
  'linear-burn': each((b, l) => Math.max(b + l - 1, 0)),
  lighten: each(Math.max),
  screen: each((b, l) => 1 - (1 - b) * (1 - l)),
  'color-dodge': each(dodge),
  'linear-dodge': each((b, l) => Math.min(b + l, 1)),
  overlay: each((b, l) => (b <= 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l))),
  'soft-light': each((b, l) => (l <= 0.5 ? b - (1 - 2 * l) * b * (1 - b)
    : b + (2 * l - 1) * (Math.sign(b) * Math.sqrt(Math.abs(b)) - b))),
  'hard-light': each((b, l) => (l <= 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l))),
  'vivid-light': each((b, l) => (l <= 0.5 ? burn(b, 2 * l) : dodge(b, 2 * (l - 0.5)))),
  'linear-light': each((b, l) => clamp01(b + 2 * l - 1)),
  'pin-light': each((b, l) => (l <= 0.5 ? Math.min(b, 2 * l) : Math.max(b, 2 * (l - 0.5)))),
  'hard-mix': each((b, l) => (b + l >= 1 ? 1 : 0)),
  difference: each((b, l) => Math.abs(b - l)),
  exclusion: each((b, l) => b + l - 2 * b * l),
  subtract: each((b, l) => Math.max(b - l, 0)),
  divide: each((b, l) => Math.min(b / Math.max(l, 0.001), 1)),
  hue: (b, l) => { const bh = rgb2hsl(b); return hsl2rgb([rgb2hsl(l)[0], bh[1], bh[2]]); },
  saturation: (b, l) => { const bh = rgb2hsl(b); return hsl2rgb([bh[0], rgb2hsl(l)[1], bh[2]]); },
  color: (b, l) => { const lh = rgb2hsl(l); return setLum(hsl2rgb([lh[0], lh[1], 0.5]), lum(b)); },
  luminosity: (b, l) => setLum(b, lum(l)),
};
// Declared float-route semantics (FL-97).
const ARITHMETIC = {
  'linear-burn': each((b, l) => b + l - 1),
  'linear-dodge': each((b, l) => b + l),
  'linear-light': each((b, l) => b + 2 * l - 1),
  subtract: each((b, l) => b - l),
};
const UNCLAMPED = new Set(['normal', 'dissolve', 'darken', 'multiply', 'lighten', 'soft-light', 'difference']);
const extended = (mode) => (b, l) => {
  if (ARITHMETIC[mode]) return ARITHMETIC[mode](b, l);
  if (UNCLAMPED.has(mode)) return formulas[mode](b, l);
  const bc = b.map(clamp01);
  return formulas[mode](bc, l.map(clamp01)).map((v, i) => v + (b[i] - bc[i]));
};
const sourceOver = (fn) => (base, layer) => {
  const srcA = clamp01(layer[3]);
  if (srcA <= 0) return base;
  const baseA = clamp01(base[3]);
  const blended = fn(base.slice(0, 3), layer.slice(0, 3));
  const outA = srcA + baseA * (1 - srcA);
  const rgb = blended.map((v, i) => v * baseA * srcA + layer[i] * srcA * (1 - baseA) + base[i] * baseA * (1 - srcA));
  return [...rgb.map((v) => (outA > 0.00001 ? v / outA : 0)), outA];
};

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const texel = (values, i) => values.slice(i * 4, i * 4 + 4);
const sdrBase = sdrBaseRows.flat(2);
const layer = layerRows.flat(2);
for (const { mode, float, again, floatSdr, sdr, sdrInHdr } of report.results) {
  const routes = { float, again, floatSdr, sdr, sdrInHdr };
  for (const [route, result] of Object.entries(routes)) {
    check(!result.error, `${mode} ${route}: ${result.error}`);
  }
  if (Object.values(routes).some((result) => result.error)) continue;
  check(floatSdr.pixels.every(Number.isFinite), `${mode}: non-finite SDR-project float output`);
  // rgba8unorm is Freecut's route in every project.
  check(sdrInHdr.pixels.every((v, i) => v === sdr.pixels[i]), `${mode}: HDR project changed the rgba8 route`);
  check(float.pixels.every(Number.isFinite), `${mode}: non-finite float output`);
  check(float.pixels.every((v, i) => Object.is(v, again.pixels[i])), `${mode}: re-render differs`);
  for (let i = 0; i < W * H; i++) {
    const row = Math.floor(i / W);
    const gotFloat = texel(float.pixels, i);
    const gotSdr = texel(sdr.pixels, i);
    if (mode === 'dissolve') {
      // Coverage is all-or-nothing: each pixel is the base or the full normal blend.
      for (const [route, got, b] of [['float', gotFloat, texel(report.base16, i)],
        ['float', texel(floatSdr.pixels, i), texel(report.base16, i)], ['sdr', gotSdr, texel(sdrBase, i)]]) {
        const covered = sourceOver(formulas.normal)(b, texel(route === 'float' ? report.layer16 : layer, i));
        const same = (x) => x.every((v, c) => Math.abs(v - got[c]) < 2 / 255 + 2e-3);
        check(same(b) || same(covered), `dissolve ${route} pixel ${i}: partial coverage`);
      }
      continue;
    }
    // Legacy rgba8unorm route: exactly Freecut's formula, quantised once.
    const wantSdr = sourceOver(formulas[mode])(texel(sdrBase, i), texel(layer, i)).map(clamp01);
    wantSdr.forEach((v, c) => check(Math.abs(v - gotSdr[c]) <= 1.5 / 255 + 1e-6,
      `${mode} rgba8 pixel ${i} ch ${c}: ${gotSdr[c]} != ${v}`));
    // Float route: declared semantics on half-precision inputs.
    const b16 = texel(report.base16, i);
    const l16 = texel(report.layer16, i);
    const wantFloat = sourceOver(extended(mode))(b16, l16);
    const tolerance = (v) => 3e-3 * Math.max(1, Math.abs(v));
    wantFloat.forEach((v, c) => check(Math.abs(v - gotFloat[c]) <= tolerance(v),
      `${mode} float pixel ${i} ch ${c}: ${gotFloat[c]} != ${v}`));
    // SDR project on the float route: exactly the pinned formula for SDR input.
    if (row !== 2) {
      const gotFloatSdr = texel(floatSdr.pixels, i);
      const pinned = sourceOver(formulas[mode])(b16, l16);
      pinned.forEach((v, c) => check(Math.abs(v - gotFloatSdr[c]) <= 3e-3,
        `${mode} SDR-project float pixel ${i} ch ${c}: ${gotFloatSdr[c]} != ${v}`));
    }
  }
}
if (failures.length) {
  console.error(failures.slice(0, 40).join('\n'));
  assert.fail(`${failures.length} blend-matrix failures on ${report.adapter.vendor}/${report.adapter.architecture}`);
}
console.log(JSON.stringify({ check: 'every blend mode: pinned SDR formula on rgba8 and float routes, declared float semantics, determinism',
  adapter: { vendor: report.adapter.vendor, architecture: report.adapter.architecture }, modes: report.results.length, pixels: W * H }));
