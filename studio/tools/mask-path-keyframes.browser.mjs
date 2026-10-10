// FL-99: authored pen geometry must animate in root and nested masks on both
// renderer modes. Interior pixels have independent source-over goldens; no
// observed frame supplies an expected answer or qualifies native applications.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let report;
try {
  const page = await browser.newPage();
  await page.route(origin + '/mask-path-keyframes', (route) => route.fulfill({
    contentType: 'text/html', body: `<title>Pen mask keyframes</title>
<script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
</script>` }));
  await page.goto(origin + '/mask-path-keyframes');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  report = await page.evaluate(async () => {
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const { useCompositionsStore } = await import('/src/features/timeline/stores/compositions-store.ts');
    const SIZE = 64;
    const sampleXs = [8, 24, 44, 60];
    const frames = [3, 4, 9, 14, 24, 9]; // Includes inactive boundaries and a backward seek.
    const transform = { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 };
    const track = (item, order) => ({ id: item.trackId, name: item.id, order,
      height: 60, locked: false, visible: true, muted: false, solo: false, items: [item] });
    const content = { id: 'content', trackId: 'content-track', type: 'shape', label: 'Red',
      from: 0, durationInFrames: 32, shapeType: 'rectangle', fillColor: '#ff0000',
      strokeEnabled: false, strokeWidth: 0, transform };
    const prior = useCompositionsStore.getState().compositions;
    const results = [];
    try {
      for (const maskType of ['clip', 'alpha']) {
        for (const inverted of [false, true]) {
          const mask = { id: 'mask', trackId: 'mask-track', type: 'shape', label: 'Pen mask',
            from: 4, durationInFrames: 20, shapeType: 'path', fillColor: '#ffffff',
            strokeEnabled: false, strokeWidth: 0, isMask: true, maskType, maskInvert: inverted,
            pathClosed: true, transform, pathVertices: [[0.25, 0], [1, 0], [1, 1], [0.25, 1]]
              .map((position) => ({ position, inHandle: [0, 0], outHandle: [0, 0] })) };
          const keyframes = [{ itemId: mask.id, properties: [
            ...[0, 3].map((vertex) => ({ property: `pathVertex:${vertex}:positionX`, keyframes: [
              { id: `v${vertex}-start`, frame: 0, value: 0.25, easing: 'linear' },
              { id: `v${vertex}-end`, frame: 10, value: 0.75, easing: 'linear' },
            ] })),
            { property: 'x', keyframes: [
              { id: 'x-start', frame: 0, value: 0, easing: 'linear' },
              { id: 'x-end', frame: 10, value: 8, easing: 'linear' },
            ] },
          ] }];
          const innerTracks = [track(mask, 0), track(content, 1)];
          const inner = { id: 'inner', name: 'Inner', fps: 30, width: SIZE, height: SIZE,
            durationInFrames: 32, backgroundColor: '#000000', transitions: [], keyframes,
            tracks: innerTracks, items: [mask, content] };
          useCompositionsStore.getState().setCompositions([inner]);
          for (const nested of [false, true]) {
            const instance = { id: 'instance', trackId: 'instance-track', type: 'composition',
              compositionId: inner.id, compositionWidth: SIZE, compositionHeight: SIZE,
              from: 2, durationInFrames: 32, label: 'Compose', transform };
            const graph = { fps: 30, width: SIZE, height: SIZE, durationInFrames: 36,
              backgroundColor: '#0000ff', transitions: [],
              tracks: nested ? [track(instance, 0)] : innerTracks,
              keyframes: nested ? [] : keyframes };
            for (const mode of ['preview', 'export']) {
              const canvas = new OffscreenCanvas(SIZE, SIZE);
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              const renderer = await createCompositionRenderer(graph, canvas, ctx, { mode });
              try {
                await renderer.preload?.();
                const samples = [];
                for (const localFrame of frames) {
                  const frame = localFrame + (nested ? instance.from : 0);
                  await renderer.renderFrame(frame);
                  const pixels = Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data);
                  await renderer.renderFrame(frame);
                  const again = Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data);
                  if (pixels.some((value, i) => value !== again[i])) throw new Error('Nondeterministic mask frame');
                  const signal = await renderer.renderFrameSignal(frame, 'sdr-display');
                  samples.push({ localFrame, canvas: sampleXs.map((x) =>
                    pixels.slice((32 * SIZE + x) * 4, (32 * SIZE + x) * 4 + 4).map((v) => v / 255)),
                    signal: sampleXs.map((x) => Array.from(signal.rgba.slice(
                      (32 * SIZE + x) * 4, (32 * SIZE + x) * 4 + 4))) });
                }
                results.push({ maskType, inverted, nested, mode, samples });
              } finally { renderer.dispose(); }
            }
          }
          if (mask.pathVertices[0].position[0] !== 0.25) throw new Error('Mask animation mutated the authored graph');
        }
      }
      return { size: SIZE, sampleXs, results };
    } finally { useCompositionsStore.getState().setCompositions(prior); }
  });
} finally { await browser.close(); }

let channels = 0;
for (const entry of report.results) {
  const label = `${entry.maskType}/${entry.inverted}/${entry.nested}/${entry.mode}`;
  const peer = report.results.find((other) => other.maskType === entry.maskType &&
    other.inverted === entry.inverted && other.nested === entry.nested && other.mode !== entry.mode);
  assert.deepEqual(entry.samples, peer.samples, `${label}: preview/export drift`);
  assert.deepEqual(entry.samples[2], entry.samples[5], `${label}: backward seek drift`);
  for (const sample of entry.samples) {
    const active = sample.localFrame >= 4 && sample.localFrame < 24;
    const progress = Math.max(0, Math.min(1, (sample.localFrame - 4) / 10));
    const edge = (0.25 + 0.5 * progress) * report.size + 8 * progress;
    for (const surface of ['canvas', 'signal']) {
      sample[surface].forEach((pixel, index) => {
        const inside = report.sampleXs[index] + 0.5 >= edge;
        const opacity = !active || inside !== entry.inverted ? 1 : 0;
        [opacity, 0, 1 - opacity, 1].forEach((want, channel) => {
          assert(Math.abs(pixel[channel] - want) <= 2 / 255,
            `${label}/${surface}/${sample.localFrame}/${report.sampleXs[index]}/${channel}: ${pixel[channel]} vs ${want}`);
          channels++;
        });
      });
    }
  }
}
assert.equal(report.results.length, 16);
assert.equal(channels, 3072);
if (process.env.MASK_PATH_KEYFRAMES_REPORT) await writeFile(process.env.MASK_PATH_KEYFRAMES_REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(`Pen mask keyframes: ${report.results.length} routes, ${channels} golden channels; deterministic, preview/export parity.`);
