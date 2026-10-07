// All registered blends: independent pinned SDR formulas and production cases.
// Linear display-referred HDR admits normal source-over; other modes are typed-refused.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { testedSource, domainObservations } from './lib/working-domain-report.mjs';
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

const source = await testedSource(new URL(import.meta.url));
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let report;
try {
  const page = await browser.newPage();
  await page.route(origin + '/blend-matrix', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Blend matrix</title>' }),
  );
  await page.goto(origin + '/blend-matrix');
  report = await page.evaluate(async ({ W, H, MODES, base, sdrBase, layer }) => {
    const { BLEND_MODE_INDEX } = await import('/src/types/blend-modes.ts');
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { HdrRenderUnavailableError } = await import('/src/shared/graphics/color/managed-color.ts');
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
        let accepted;
        try { accepted = blend.blend(inputs[format].base, inputs[format].layer, output, mode); }
        catch (error) {
          const validation = await device.popErrorScope();
          if (validation) throw new Error(validation.message);
          if (!(error instanceof HdrRenderUnavailableError) || range !== 'hdr') throw error;
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
        // Actual registered operator in the linear HDR domain: normal renders, others refuse.
        float: await render('rgba16float', mode, 'hdr'),
        again: await render('rgba16float', mode, 'sdr'),
        // SDR project: Freecut's semantics on the float route and on rgba8unorm.
        floatSdr: await render('rgba16float', mode, 'sdr'),
        sdr: await render('rgba8unorm', mode, 'sdr'),
      });
    }
    // The float inputs as the GPU holds them (half precision).
    const f16 = (values) => Array.from(new Float16Array(values));
    blend.destroy();
    for (const set of Object.values(inputs)) { set.base.destroy(); set.layer.destroy(); }
    const info = (await navigator.gpu.requestAdapter())?.info ?? {};
    return { browser: { name: 'chromium', driver: 'playwright', userAgent: navigator.userAgent }, registeredModes: Object.keys(BLEND_MODE_INDEX),
      adapter: { vendor: info.vendor, architecture: info.architecture }, results,
      base16: f16(base), layer16: f16(layer) };
  }, { W, H, MODES, base: baseRows.flat(2), sdrBase: sdrBaseRows.flat(2), layer: layerRows.flat(2) });
} finally {
  await browser.close();
}

// ─── Per-mode cases through the production renderer (FL-99) ───
// Each blended layer is a real timeline item over a base item: its opacity is
// resolved by the production keyframe resolver and composited by the float route.
//   animated: opacity keyframed 0 → 1; frames 0/5/10 equal the static renders.
//   composed: a second blend (screen) stacked over the mode's result.
//   invalid:  opacity -0.5, 1.5 and NaN draw exactly as the clamped 0, 1 and 0;
//             an unknown mode id draws exactly as normal.
// No channel sits on a mode's branch point (0.5, or base + layer = 1), where half
// precision rather than the formula would decide the branch.
const CASE_COLOURS = { base: [0.6, 0.3, 0.8, 1], layer: [0.7, 0.45, 0.25, 1], second: [0.4, 0.8, 0.55, 1] };
const caseBrowser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await caseBrowser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.route(origin + '/blend-cases', (route) =>
    // The renderer imports React modules, which need the dev server's refresh preamble.
    route.fulfill({ contentType: 'text/html', body: `<title>Blend cases</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  await page.goto(origin + '/blend-cases');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  report.cases = await page.evaluate(async ({ MODES, colours }) => {
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    // Wide, tall columns so each sample is well inside its shapes (no edge coverage).
    const COLUMNS = ['animated', 'static0', 'static1', 'static05', 'composed', 'under', 'over', 'nan'];
    const CW = 6;
    const W = COLUMNS.length * CW;
    const H = 6;
    const css = ([r, g, b]) => `rgb(${r * 100}%, ${g * 100}%, ${b * 100}%)`;
    const shape = (id, column, colour, extra = {}, opacity = 1) => ({
      id, type: 'shape', trackId: `t-${id}`, from: 0, durationInFrames: 30, label: id,
      shapeType: 'rectangle', fillColor: css(colour), strokeEnabled: false, strokeWidth: 0,
      transform: { x: -W / 2 + CW * column + CW / 2, y: 0, width: CW, height: H, rotation: 0, opacity }, ...extra,
    });
    const composition = (items, keyframes = []) => ({
      fps: 30, width: W, height: H, durationInFrames: 30, backgroundColor: '#000000', keyframes,
      tracks: items.map((item, order) => ({ id: `track-${item.id}`, name: item.id, height: 60, locked: false,
        visible: true, muted: false, solo: false, order, items: [item] })),
    });
    const sample = (rgba, column) => {
      const i = (Math.floor(H / 2) * W + column * CW + CW / 2) * 4;
      return Array.from(rgba.slice(i, i + 4));
    };
    const renderFrames = async (comp, frames) => {
      const canvas = new OffscreenCanvas(W, H);
      const renderer = await createCompositionRenderer(comp, canvas, canvas.getContext('2d'), { mode: 'export' });
      try {
        await renderer.preload?.();
        const out = {};
        for (const frame of frames) {
          // An SDR project's explicit output is its working values, clamped: the pinned reference.
          const { rgba } = await renderer.renderFrameSignal(frame, 'sdr-display');
          out[frame] = COLUMNS.map((_, column) => sample(rgba, column));
        }
        return out;
      } finally {
        renderer.dispose();
      }
    };
    const opacityOf = { animated: 1, static0: 0, static1: 1, static05: 0.5, composed: 1, under: -0.5, over: 1.5, nan: NaN };
    const cases = [];
    for (const mode of MODES) {
      // Tracks: lower order draws on top.
      const items = [
        shape('second', 4, colours.second, { blendMode: 'screen' }),
        ...COLUMNS.map((name, column) => shape(`layer-${name}`, column, colours.layer, { blendMode: mode }, opacityOf[name])),
        ...COLUMNS.map((name, column) => shape(`base-${name}`, column, colours.base)),
      ];
      const keyframes = [{ itemId: 'layer-animated', properties: [{ property: 'opacity', keyframes: [
        { id: 'start', frame: 0, value: 0, easing: 'linear' }, { id: 'end', frame: 10, value: 1, easing: 'linear' }] }] }];
      const frames = await renderFrames(composition(items, keyframes), [0, 5, 10]);
      const at = (frame, name) => frames[frame][COLUMNS.indexOf(name)];
      cases.push({ mode, case: 'animated', property: 'opacity', keyframes: [[0, 0], [10, 1]],
        frames: { 0: at(0, 'animated'), 5: at(5, 'animated'), 10: at(10, 'animated') },
        statics: { 0: at(0, 'static0'), 0.5: at(0, 'static05'), 1: at(0, 'static1') } });
      cases.push({ mode, case: 'composed', second: 'screen', got: at(0, 'composed'), under: at(0, 'static1') });
      cases.push({ mode, case: 'invalid', opacity: { '-0.5': at(0, 'under'), '1.5': at(0, 'over'), NaN: at(0, 'nan') },
        clamped: { 0: at(0, 'static0'), 1: at(0, 'static1') },
        stable: [5, 10].every((frame) => ['under', 'over', 'nan'].every((name) =>
          at(frame, name).every((v, c) => Object.is(v, at(0, name)[c])))) });
    }
    // An unknown mode id draws exactly as normal.
    const unknown = await renderFrames(composition([
      shape('unknown', 0, colours.layer, { blendMode: 'not-a-blend-mode' }), shape('normal', 1, colours.layer),
      ...[0, 1].map((column) => shape(`base-${column}`, column, colours.base)),
    ]), [0]);
    cases.push({ mode: '*', case: 'invalid-mode', blendMode: 'not-a-blend-mode', got: unknown[0][0], normal: unknown[0][1] });

    // Dissolve dithers opacity (FL-99 owner decision) on the float route (explicit
    // output) and on the legacy route (the SDR preview/export canvas): coverage density,
    // all-or-nothing pixels, and the same pattern on every frame at a held opacity.
    {
      const OPACITIES = [0.25, 0.5, 0.75];
      const SIDE = 24;
      const DW = OPACITIES.length * SIDE;
      const block = (id, column, colour, extra = {}, opacity = 1) => ({
        id, type: 'shape', trackId: `t-${id}`, from: 0, durationInFrames: 30, label: id,
        shapeType: 'rectangle', fillColor: css(colour), strokeEnabled: false, strokeWidth: 0,
        transform: { x: -DW / 2 + SIDE * column + SIDE / 2, y: 0, width: SIDE, height: SIDE, rotation: 0, opacity }, ...extra,
      });
      const items = [
        ...OPACITIES.map((opacity, column) => block(`dissolve-${column}`, column, colours.layer, { blendMode: 'dissolve' }, opacity)),
        ...OPACITIES.map((_, column) => block(`base-${column}`, column, colours.base)),
      ];
      const comp = { fps: 30, width: DW, height: SIDE, durationInFrames: 30, backgroundColor: '#000000', keyframes: [],
        tracks: items.map((item, order) => ({ id: `track-${item.id}`, name: item.id, height: 60, locked: false,
          visible: true, muted: false, solo: false, order, items: [item] })) };
      const canvas = new OffscreenCanvas(DW, SIDE);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const renderer = await createCompositionRenderer(comp, canvas, ctx, { mode: 'export' });
      const columns = (rgba) => OPACITIES.map((_, column) => {
        const pixels = [];
        // Interior only: shape edges are antialiased.
        for (let y = 2; y < SIDE - 2; y++) {
          for (let x = column * SIDE + 2; x < (column + 1) * SIDE - 2; x++) {
            pixels.push(Array.from(rgba.slice((y * DW + x) * 4, (y * DW + x) * 4 + 3)));
          }
        }
        return pixels;
      });
      try {
        await renderer.preload?.();
        const float = {};
        const legacy = {};
        for (const frame of [3, 7]) {
          float[frame] = columns((await renderer.renderFrameSignal(frame, 'sdr-display')).rgba);
          await renderer.renderFrame(frame);
          legacy[frame] = columns(Array.from(ctx.getImageData(0, 0, DW, SIDE).data, (v) => v / 255));
        }
        // The Canvas2D compositing fallback (no WebGPU) dithers with the same rule.
        const { drawDissolved } = await import('/src/shared/graphics/dissolve-dither.ts');
        const canvas2d = {};
        for (const frame of [3, 7]) {
          const target = new OffscreenCanvas(DW, SIDE);
          const targetCtx = target.getContext('2d', { willReadFrequently: true });
          const layer = new OffscreenCanvas(DW, SIDE);
          const layerCtx = layer.getContext('2d');
          OPACITIES.forEach((opacity, column) => {
            targetCtx.fillStyle = css(colours.base);
            targetCtx.fillRect(column * SIDE, 0, SIDE, SIDE);
            layerCtx.globalAlpha = opacity;
            layerCtx.fillStyle = css(colours.layer);
            layerCtx.fillRect(column * SIDE, 0, SIDE, SIDE);
          });
          drawDissolved(targetCtx, layer);
          canvas2d[frame] = columns(Array.from(targetCtx.getImageData(0, 0, DW, SIDE).data, (v) => v / 255));
        }
        cases.push({ mode: 'dissolve', case: 'dissolve-dither', opacities: OPACITIES, float, legacy, canvas2d });
      } finally {
        renderer.dispose();
      }

      // Preview equals export (owner decision): a translucent Dissolve item whose content
      // has its own soft alpha, drawn by the renderer the preview's engine surface uses
      // and by the export renderer, pixel for pixel. Coverage follows total opacity
      // (item 0.5 x content 0.6 = 0.3), not the item's opacity alone.
      const SOFT = { opacity: 0.5, contentAlpha: 0.6 };
      const softComp = {
        ...comp,
        width: SIDE * 4,
        tracks: [
          { id: 'track-soft', name: 'soft', height: 60, locked: false, visible: true, muted: false, solo: false, order: 0,
            items: [{ ...block('soft', 0, colours.layer, { blendMode: 'dissolve',
              fillColor: `rgba(${colours.layer.slice(0, 3).map((v) => v * 255).join(', ')}, ${SOFT.contentAlpha})` }, SOFT.opacity),
            transform: { x: 0, y: 0, width: SIDE * 4, height: SIDE, rotation: 0, opacity: SOFT.opacity } }] },
          { id: 'track-soft-base', name: 'base', height: 60, locked: false, visible: true, muted: false, solo: false, order: 1,
            items: [{ ...block('soft-base', 0, colours.base), transform: { x: 0, y: 0, width: SIDE * 4, height: SIDE, rotation: 0, opacity: 1 } }] },
        ],
      };
      const surfaces = {};
      for (const mode of ['preview', 'export']) {
        const surface = new OffscreenCanvas(SIDE * 4, SIDE);
        const surfaceCtx = surface.getContext('2d', { willReadFrequently: true });
        const softRenderer = await createCompositionRenderer(softComp, surface, surfaceCtx, { mode });
        try {
          await softRenderer.preload?.();
          await softRenderer.renderFrame(4);
          surfaces[mode] = Array.from(surfaceCtx.getImageData(0, 0, SIDE * 4, SIDE).data);
        } finally {
          softRenderer.dispose();
        }
      }
      cases.push({ mode: 'dissolve', case: 'dissolve-preview-export', ...SOFT, width: SIDE * 4, height: SIDE, surfaces });
    }
    return cases;
  }, { MODES, colours: CASE_COLOURS });
} finally {
  await caseBrowser.close();
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
// Historical encoded-HDR extensions are pinned in commit 24d509f1346e344bb356f92cd0fbed2a59b74ca8.
// Only normal's arithmetic is admitted for current linear HDR.
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
for (const { mode, float, again, floatSdr, sdr } of report.results) {
  const routes = { again, floatSdr, sdr };
  if (mode === 'normal') routes.float = float;
  else check(float.errorType === 'HdrRenderUnavailableError', `${mode}: missing typed HDR refusal`);
  for (const [route, result] of Object.entries(routes)) {
    check(!result.error, `${mode} ${route}: ${result.error}`);
  }
  if (Object.values(routes).some((result) => result.error)) continue;
  check(floatSdr.pixels.every(Number.isFinite), `${mode}: non-finite SDR-project float output`);
  check(floatSdr.pixels.every((v, i) => Object.is(v, again.pixels[i])), `${mode}: SDR re-render differs`);
  for (let i = 0; i < W * H; i++) {
    const row = Math.floor(i / W);
    const gotFloat = mode === 'normal' ? texel(float.pixels, i) : null;
    const gotSdr = texel(sdr.pixels, i);
    if (mode === 'dissolve') {
      // Coverage is all-or-nothing (FL-99 owner decision): the pixel's opacity is dithered,
      // so each pixel is the base or the layer drawn fully opaque.
      for (const [route, got, b] of [['float', texel(floatSdr.pixels, i), texel(report.base16, i)], ['sdr', gotSdr, texel(sdrBase, i)]]) {
        const layerTexel = texel(route === 'float' ? report.layer16 : layer, i);
        const covered = sourceOver(formulas.normal)(b, [...layerTexel.slice(0, 3), layerTexel[3] > 0 ? 1 : 0]);
        const same = (x) => x.every((v, c) => Math.abs(v - got[c]) < 2 / 255 + 2e-3);
        check(same(b) || same(covered), `dissolve ${route} pixel ${i}: partial coverage`);
      }
      continue;
    }
    // Legacy rgba8unorm route: exactly Freecut's formula, quantised once.
    const wantSdr = sourceOver(formulas[mode])(texel(sdrBase, i), texel(layer, i)).map(clamp01);
    wantSdr.forEach((v, c) => check(Math.abs(v - gotSdr[c]) <= 1.5 / 255 + 1e-6,
      `${mode} rgba8 pixel ${i} ch ${c}: ${gotSdr[c]} != ${v}`));
    const b16 = texel(report.base16, i);
    const l16 = texel(report.layer16, i);
    if (mode === 'normal') {
      const wantFloat = sourceOver(formulas.normal)(b16, l16);
      wantFloat.forEach((v, c) => check(Math.abs(v - gotFloat[c]) <= 3e-3 * Math.max(1, Math.abs(v)),
        `normal linear HDR pixel ${i} ch ${c}: ${gotFloat[c]} != ${v}`));
    }
    // SDR project on the float route: exactly the pinned formula for SDR input.
    if (row !== 2) {
      const gotFloatSdr = texel(floatSdr.pixels, i);
      const pinned = sourceOver(formulas[mode])(b16, l16);
      pinned.forEach((v, c) => check(Math.abs(v - gotFloatSdr[c]) <= 3e-3,
        `${mode} SDR-project float pixel ${i} ch ${c}: ${gotFloatSdr[c]} != ${v}`));
    }
  }
}

// Per-mode cases through the production renderer.
const near = (got, want, tolerance = 3e-3) => want.every((v, c) => Math.abs(v - got[c]) <= tolerance);
const same = (got, want) => want.every((v, c) => Object.is(v, got[c]));
const layerAt = (opacity) => [...CASE_COLOURS.layer.slice(0, 3), opacity];
for (const entry of report.cases) {
  const { mode } = entry;
  if (entry.case === 'invalid-mode') {
    check(same(entry.got, entry.normal), `unknown blend mode id did not draw as normal: ${entry.got} != ${entry.normal}`);
    continue;
  }
  if (entry.case === 'dissolve-preview-export') {
    const { preview, export: exported } = entry.surfaces;
    const differing = preview.filter((v, i) => v !== exported[i]).length;
    check(differing === 0, `dissolve preview-export: ${differing} channels differ between the preview surface and export`);
    // Interior pixels (edges are antialiased): all-or-nothing, at the total opacity.
    const base = CASE_COLOURS.base.slice(0, 3).map((v) => v * 255);
    const layer = CASE_COLOURS.layer.slice(0, 3).map((v) => v * 255);
    let covered = 0;
    let partial = 0;
    let counted = 0;
    for (let y = 2; y < entry.height - 2; y++) {
      for (let x = 2; x < entry.width - 2; x++) {
        const p = exported.slice((y * entry.width + x) * 4, (y * entry.width + x) * 4 + 3);
        counted++;
        if (p.every((v, c) => Math.abs(v - layer[c]) <= 2)) covered++;
        else if (!p.every((v, c) => Math.abs(v - base[c]) <= 2)) partial++;
      }
    }
    const fraction = covered / counted;
    check(partial === 0, `dissolve preview-export: ${partial} partially covered pixels`);
    check(Math.abs(fraction - entry.opacity * entry.contentAlpha) <= 0.08,
      `dissolve preview-export: coverage ${fraction.toFixed(3)} is not the total opacity ${entry.opacity * entry.contentAlpha}`);
    continue;
  }
  if (entry.case === 'dissolve-dither') {
    const base = CASE_COLOURS.base.slice(0, 3);
    const layer = CASE_COLOURS.layer.slice(0, 3);
    for (const [route, frames, tolerance] of [['float', entry.float, 3e-3], ['legacy', entry.legacy, 1.5 / 255],
      ['canvas2d', entry.canvas2d, 1.5 / 255]]) {
      entry.opacities.forEach((opacity, column) => {
        const pixels = frames[3][column];
        const isBase = (p) => p.every((v, c) => Math.abs(v - base[c]) <= tolerance);
        const isLayer = (p) => p.every((v, c) => Math.abs(v - layer[c]) <= tolerance);
        const partial = pixels.filter((p) => !isBase(p) && !isLayer(p)).length;
        check(partial === 0, `dissolve ${route} opacity ${opacity}: ${partial} partially covered pixels`);
        const fraction = pixels.filter(isLayer).length / pixels.length;
        check(Math.abs(fraction - opacity) <= 0.08, `dissolve ${route} opacity ${opacity}: coverage ${fraction.toFixed(3)}`);
        check(frames[7][column].every((p, i) => p.every((v, c) => Object.is(v, pixels[i][c]))),
          `dissolve ${route} opacity ${opacity}: the pattern changed between frames at a held opacity`);
      });
    }
    continue;
  }
  const pinned = (base, layerColour) => sourceOver(formulas[mode])(base, layerColour);
  const full = pinned(CASE_COLOURS.base, layerAt(1));
  if (entry.case === 'animated') {
    const { frames, statics } = entry;
    check(same(frames[0], statics[0]), `${mode} animated: frame 0 != static opacity 0`);
    check(same(frames[10], statics[1]), `${mode} animated: frame 10 != static opacity 1`);
    check(same(frames[5], statics[0.5]), `${mode} animated: frame 5 != static opacity 0.5`);
    check(near(statics[0], CASE_COLOURS.base), `${mode} animated: opacity 0 changed the base: ${statics[0]}`);
    check(near(statics[1], full), `${mode} animated: opacity 1 ${statics[1]} != ${full}`);
    if (mode === 'dissolve') {
      // FL-99 owner decision: a translucent Dissolve item dithers its opacity, so the
      // sample is the base or the full layer (coverage density: the dissolve case).
      check(near(statics[0.5], CASE_COLOURS.base) || near(statics[0.5], full),
        `dissolve animated: opacity 0.5 drew a partial mix ${statics[0.5]}`);
    } else {
      const half = pinned(CASE_COLOURS.base, layerAt(0.5));
      check(near(statics[0.5], half), `${mode} animated: opacity 0.5 ${statics[0.5]} != ${half}`);
    }
  } else if (entry.case === 'composed') {
    const want = sourceOver(formulas.screen)(full, CASE_COLOURS.second);
    check(near(entry.under, full), `${mode} composed: first blend ${entry.under} != ${full}`);
    check(near(entry.got, want), `${mode} composed: stack ${entry.got} != sequential ${want}`);
  } else if (entry.case === 'invalid') {
    check(same(entry.opacity['-0.5'], entry.clamped[0]), `${mode} invalid: opacity -0.5 did not draw as 0 (${entry.opacity['-0.5']})`);
    check(same(entry.opacity['1.5'], entry.clamped[1]), `${mode} invalid: opacity 1.5 did not draw as 1 (${entry.opacity['1.5']})`);
    check(same(entry.opacity.NaN, entry.clamped[0]), `${mode} invalid: opacity NaN did not draw as 0 (${entry.opacity.NaN})`);
    check(entry.stable, `${mode} invalid: an invalid opacity changed between frames`);
  }
}
check(report.cases.some((entry) => entry.case === 'dissolve-dither'), 'dissolve: no dithering case measured');
check(report.cases.some((entry) => entry.case === 'dissolve-preview-export'), 'dissolve: no preview/export case measured');
for (const mode of MODES) {
  for (const name of ['animated', 'composed', 'invalid']) {
    check(report.cases.some((entry) => entry.mode === mode && entry.case === name), `${mode}: no ${name} case measured`);
  }
}
if (failures.length) {
  console.error(failures.slice(0, 40).join('\n'));
  assert.fail(`${failures.length} blend-matrix failures on ${report.adapter.vendor}/${report.adapter.architecture}`);
}
assert.deepEqual(report.registeredModes.sort(), [...MODES].sort(), 'every registered blend must be measured');
assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
Object.assign(report, { schemaVersion: 1, kind: 'studio-domain-regression', result: 'passed', source });
report.observations = domainObservations(report);
if (process.env.BLEND_MATRIX_REPORT) await writeFile(process.env.BLEND_MATRIX_REPORT, JSON.stringify(report));
console.log(JSON.stringify({ check: 'every blend mode: pinned SDR formula on rgba8 and float routes, linear HDR normal, typed HDR refusals, SDR determinism; animated, composed and invalid cases through the renderer; dithered Dissolve on float, legacy and Canvas2D routes',
  adapter: { vendor: report.adapter.vendor, architecture: report.adapter.architecture }, modes: report.results.length, pixels: W * H,
  cases: report.cases.length }));
