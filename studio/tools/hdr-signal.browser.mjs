// FL-97 / FL-107: an edited frame goes through the production renderer's float
// route (shapes, an effect and a blend over a background) and the explicit
// output conversion. PQ and HLG BT.2020 signal must equal the managed-colour
// reference for an HDR project, and an SDR project must deliver Freecut's
// clamped results mapped to reference white.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.route(origin + '/hdr-signal', (route) =>
    // The renderer imports React modules, which need the dev server's refresh preamble.
    route.fulfill({ contentType: 'text/html', body: `<title>HDR signal</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  await page.goto(origin + '/hdr-signal');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  const result = await page.evaluate(async () => {
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const color = await import('/src/shared/graphics/color/managed-color.ts');
    const W = 16;
    const H = 8;
    const shape = (id, x, fillColor, extra = {}) => ({
      id, type: 'shape', trackId: `t-${id}`, from: 0, durationInFrames: 30, label: id,
      shapeType: 'rectangle', fillColor, strokeEnabled: false, strokeWidth: 0,
      transform: { x, y: 0, width: 4, height: 8, rotation: 0, opacity: 1 }, ...extra,
    });
    const track = (order, items) => ({ id: `track-${order}`, name: `T${order}`, height: 60, locked: false,
      visible: true, muted: false, solo: false, order, items });
    const composition = (colorManagement) => ({
      fps: 30, width: W, height: H, durationInFrames: 30, backgroundColor: '#666666', colorManagement,
      tracks: [
        track(0, [shape('highlight', -6, 'rgb(300%, 150%, 50%)')]),
        track(1, [shape('exposed', -2, 'rgb(50%, 50%, 50%)', { effects: [{ id: 'fx', enabled: true,
          effect: { type: 'gpu-effect', gpuEffectType: 'gpu-exposure', params: { exposure: 2, offset: 0, gamma: 1 } } }] })]),
        track(2, [shape('dodge', 2, 'rgb(70%, 70%, 70%)', { blendMode: 'linear-dodge' })]),
        track(3, [{ ...shape('grey', 0, 'rgb(40%, 40%, 40%)'), transform: { x: 0, y: 0, width: 16, height: 8, rotation: 0, opacity: 1 } }]),
      ],
    });
    const renderAll = async (colorManagement) => {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d');
      const renderer = await createCompositionRenderer(composition(colorManagement), canvas, ctx, { mode: 'export' });
      try {
        await renderer.preload?.();
        const out = {};
        for (const target of ['pq', 'hlg']) {
          const { width, height, rgba } = await renderer.renderFrameSignal(0, target);
          out[target] = { width, height, samples: [2, 6, 10, 14].map((x) => Array.from(rgba.slice((4 * W + x) * 4, (4 * W + x) * 4 + 4))) };
        }
        return out;
      } finally {
        renderer.dispose?.();
      }
    };
    const hdr = await renderAll({ workingRange: 'hdr' });
    const sdr = await renderAll(undefined);
    const toSignal = (working, target) => color.workingToSignal(working, target);
    // Working values each region should hold before output conversion.
    const expected = {
      hdr: [[3, 1.5, 0.5], [2, 2, 2], [1.1, 1.1, 1.1], [0.4, 0.4, 0.4]],
      sdr: [[1, 1, 0.5], [1, 1, 1], [1, 1, 1], [0.4, 0.4, 0.4]],
    };
    const want = Object.fromEntries(Object.entries(expected).map(([project, regions]) => [project,
      Object.fromEntries(['pq', 'hlg'].map((target) => [target, regions.map((w) => toSignal(w, target))]))]));
    return { hdr, sdr, want };
  });
  for (const project of ['hdr', 'sdr']) {
    for (const target of ['pq', 'hlg']) {
      const got = result[project][target];
      assert.equal(got.width, 16);
      assert.equal(got.height, 8);
      got.samples.forEach((texel, region) => {
        result.want[project][target][region].forEach((value, channel) => assert.ok(
          Number.isFinite(texel[channel]) && Math.abs(texel[channel] - value) <= 4e-3,
          `${project} ${target} region ${region} channel ${channel}: ${texel[channel]} != ${value}`));
        assert.ok(Math.abs(texel[3] - 1) < 1e-6, `${project} ${target} region ${region}: alpha ${texel[3]}`);
      });
    }
  }
  console.log(JSON.stringify({ check: 'edited frame through the float route and explicit PQ/HLG output', ...result.hdr.pq }));
} finally {
  await browser.close();
}
