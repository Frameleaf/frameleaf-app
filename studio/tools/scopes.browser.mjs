// Scope reference ramps and bars on the real GPU scopes (FL-98), in Chrome's WebGPU.
// Run against the prepared engine's Vite dev server (default http://127.0.0.1:5186):
//   node studio/tools/scopes.browser.mjs
// SCOPES_REPORT=<path> writes every raw measurement as JSON, whether the checks pass or not.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';
const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';

const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let report = null;
try {
  const page = await browser.newPage();
  await page.goto(origin + '/headless.html');
  report = await page.evaluate(async () => {
    const { ScopeRenderer } = await import('/src/infrastructure/gpu-scopes/index.ts');
    const math = await import('/src/features/preview/utils/scope-math.ts');
    const renderer = await ScopeRenderer.create();
    if (!renderer) return { skipped: 'WebGPU is not available in this browser' };

    /** Renders `draw` into a fresh GPU canvas of `w` × `h` and reads its pixels back. */
    const readScope = async (w, h, draw) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = renderer.configureCanvas(canvas);
      draw(ctx);
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const copy = new OffscreenCanvas(w, h).getContext('2d');
      copy.drawImage(canvas, 0, 0);
      return copy.getImageData(0, 0, w, h);
    };
    const pixels = (width, height, pixel) => {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...pixel(x, y), 255], (y * width + x) * 4);
      return new ImageData(data, width, height);
    };
    const brightness = (image, x, y) => {
      const i = (y * image.width + x) * 4;
      return image.data[i] + image.data[i + 1] + image.data[i + 2];
    };

    // A grey ramp across 256 columns: each column's trace sits at its own level.
    renderer.setMatrix(math.BT709_COEFFICIENTS.kr, math.BT709_COEFFICIENTS.kb);
    renderer.setRange(0, 1);
    renderer.uploadFrame(pixels(256, 16, (x) => [x, x, x]));
    const waveform = await readScope(256, 256, (ctx) => renderer.renderWaveforms([{ ctx, mode: 4 }]));
    const columns = [16, 64, 128, 192, 240].map((x) => {
      let best = 0;
      let row = -1;
      for (let y = 0; y < waveform.height; y++) {
        const value = brightness(waveform, x, y);
        if (value > best) { best = value; row = y; }
      }
      // Level of the column's grey, 0 at the bottom row.
      return { x, grey: x, row, expectedRow: Math.round((1 - x / 255) * (waveform.height - 1)) };
    });

    // 75% bars: each trace lands on the target box the graticule overlay draws. The GPU scope
    // draws its own target markers too, so the trace is found as what a bar adds over a grey frame.
    const size = 256;
    renderer.uploadFrame(pixels(8, 8, () => [128, 128, 128]));
    const baseline = await readScope(size, size, (ctx) => renderer.renderVectorscope(ctx));
    const bars = [];
    for (const [label, r, g, b] of [['R', 191, 0, 0], ['Mg', 191, 0, 191], ['B', 0, 0, 191], ['Cy', 0, 191, 191], ['G', 0, 191, 0], ['Yl', 191, 191, 0]]) {
      renderer.uploadFrame(pixels(8, 8, () => [r, g, b]));
      const scope = await readScope(size, size, (ctx) => renderer.renderVectorscope(ctx));
      const target = math.VECTORSCOPE_75_TARGETS.find((entry) => entry.label === label);
      let best = 0;
      let at = null;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const added = brightness(scope, x, y) - brightness(baseline, x, y);
          if (added > best) { best = added; at = { x, y }; }
        }
      }
      bars.push({ label, target: { x: (target.x / 100) * size, y: (target.y / 100) * size }, trace: at, added: best });
    }
    renderer.destroy();
    return { waveform: columns, vectorscope: bars };
  });
  // No silent pass: without WebGPU there is nothing measured.
  assert.equal(report.skipped, undefined, report.skipped);
  {
    for (const column of report.waveform) {
      assert.ok(Math.abs(column.row - column.expectedRow) <= 3, `waveform column ${column.x}: ${JSON.stringify(column)}`);
    }
    for (const bar of report.vectorscope) {
      assert.ok(bar.trace && Math.hypot(bar.trace.x - bar.target.x, bar.trace.y - bar.target.y) <= 4, `vectorscope ${bar.label}: ${JSON.stringify(bar)}`);
    }
    console.log(`Scopes: grey ramp on the waveform diagonal (${report.waveform.length} columns); 75% bars on their targets (${report.vectorscope.length})`);
  }
} finally {
  await browser.close();
  if (process.env.SCOPES_REPORT) await writeFile(process.env.SCOPES_REPORT, JSON.stringify(report, null, 2));
}
