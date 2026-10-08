import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { pixelateReference } from './pixelate-reference.mjs';
import { testedSource } from './lib/working-domain-report.mjs';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const { chromium } = createRequire(new URL('../engine/package.json', import.meta.url))('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const source = await testedSource(new URL(import.meta.url));
const W = 16, H = 16;
const input = Array.from({ length: W * H }, (_, i) => {
  const x = i % W, y = Math.floor(i / W);
  return x < 8 ? [8, -0.25, 2, y < 8 ? 1 : 0.5] : [32, 4, -2, y < 8 ? 0 : 0.25];
}).flat();
const cases = [1, 2, 3, 8, 64].map(size => ({ type: 'gpu-pixelate', params: { size } }));
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  await page.route(origin + '/hdr-pixelate', route => route.fulfill({ contentType: 'text/html', body: `<script type="module">
import R from '/@react-refresh'; R.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>x=>x; window.__vite_plugin_react_preamble_installed__=true;
</script>` }));
  await page.goto(origin + '/hdr-pixelate');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__);
  const report = await page.evaluate(async ({ W, H, input, cases }) => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/index.ts');
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const pipeline = await EffectsPipeline.create();
    if (!pipeline) throw new Error('WebGPU unavailable');
    pipeline.setWorkingRange('hdr');
    const device = pipeline.getDevice();
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const original = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    const output = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    const buffer = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeTexture({ texture: original }, new Float16Array(input), { bytesPerRow: W * 8 }, [W, H]);
    const rows = [];
    try {
      for (const entry of cases) {
        device.pushErrorScope('validation');
        const accepted = pipeline.applyTextureEffectsToTexture(original, [{ id: 'blur', ...entry, enabled: true }], output, W, H);
        if (!accepted) throw new Error('Effect refused');
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [W, H]);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (error) throw new Error(error.message);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const pixels = [];
        for (let y = 0; y < H; ++y) pixels.push(...new Float16Array(mapped, y * 256, W * 4));
        buffer.unmap();
        rows.push({ ...entry, pixels });
      }
      const compositions = [];
      for (const entry of cases) {
        const image = { id: 'image', mediaId: 'image', type: 'image', trackId: 'track', from: 0,
          durationInFrames: 1, src: '', sourceWidth: W, sourceHeight: H,
          transform: { x: 0, y: 0, width: W, height: H, rotation: 0, opacity: 1 },
          effects: [{ id: 'blur', enabled: true, effect: { type: 'gpu-effect', gpuEffectType: entry.type, params: entry.params } }] };
        const composition = { fps: 30, width: W, height: H, durationInFrames: 1, backgroundColor: '#000000',
          colorManagement: { workingRange: 'hdr', referenceWhiteNits: 203, masteringPeakNits: 1000, sdrMonitoring: 'none' },
          tracks: [{ id: 'track', name: 'Photo', order: 0, visible: true, muted: false, solo: false, locked: false, height: 60, items: [image] }],
          keyframes: [], transitions: [] };
        const canvas = new OffscreenCanvas(W, H);
        const renderer = await createCompositionRenderer(composition, canvas, canvas.getContext('2d'), {
          mode: 'export', hdrRasters: { image: { width: W, height: H, transfer: 'linear', rgba: new Float32Array(input), gamut: 0, referenceWhite: 203 } },
        });
        try {
          await renderer.preload?.();
          const frame = await renderer.renderFrameSignal(0, 'pq');
          const pixels = Array.from(frame.rgba);
          const repeated = await renderer.renderFrameSignal(0, 'pq');
          if (JSON.stringify(pixels) !== JSON.stringify(Array.from(repeated.rgba))) throw new Error('Repeated seek changed Pixelate export');
          compositions.push({ ...entry, width: frame.width, height: frame.height, pixels, repeatedSeek: true });
        } finally { renderer.dispose(); }
      }
      return { adapter: device.adapterInfo, rows, compositions };
    } finally {
      original.destroy(); output.destroy(); buffer.destroy(); pipeline.destroy();
    }
  }, { W, H, input, cases });
  for (const row of report.rows) {
    assert.equal(row.type, 'gpu-pixelate');
    const expected = pixelateReference(input, W, H, row.params);
    row.pixels.forEach((v, i) => assert(Number.isFinite(v) && Math.abs(v - expected[i]) <= Math.max(0.004, Math.abs(expected[i]) * 0.003),
      `${row.type} ${JSON.stringify(row.params)} channel ${i}: ${v} vs ${expected[i]}`));
  }
  const pq = nits => {
    const light = Math.max(0, Math.min(1, nits / 10000)) ** (2610 / 16384);
    return ((3424 / 4096 + (2413 / 4096) * 32 * light) / (1 + (2392 / 4096) * 32 * light)) ** ((2523 / 4096) * 128);
  };
  const bt2020 = [[.627404, .329282, .043314], [.069097, .91954, .011361], [.016392, .088013, .895595]];
  assert.equal(report.compositions.length, 5);
  for (const row of report.compositions) {
    assert.deepEqual([row.width, row.height], [W, H]);
    const filtered = pixelateReference(input, W, H, row.params);
    for (let i = 0; i < W * H; ++i) {
      const rgb = filtered.slice(i * 4, i * 4 + 3).map(v => v * filtered[i * 4 + 3]);
      for (let c = 0; c < 3; ++c) {
        const expected = pq(bt2020[c].reduce((sum, value, at) => sum + value * rgb[at] * 203, 0));
        assert(Math.abs(row.pixels[i * 4 + c] - expected) < .004, `${row.type} full export pixel ${i} channel ${c}`);
      }
      assert.equal(row.pixels[i * 4 + 3], 1);
    }
  }
  assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
  if (process.env.STUDIO_MEASUREMENT_REPORT) await writeFile(process.env.STUDIO_MEASUREMENT_REPORT,
    JSON.stringify({ source, ...report, oracle: 'independent premultiplied spatial equations; linear BT.709, straight-alpha output, 203 nits reference white' }, null, 2));
  console.log(JSON.stringify({ check: 'HDR alpha-aware Pixelate', cases: report.rows.length, compositionExports: report.compositions.length, channels: report.rows.length * input.length }));
} finally { await browser.close(); }
