// FL-97 / FL-107: the GPU output conversion equals the managed-colour reference
// (src/shared/graphics/color/managed-color.ts) for PQ and HLG BT.2020 delivery,
// SDR clipping and the explicit BT.2390 monitoring policy, on software WebGPU in CI.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  await page.route(origin + '/color-output', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Colour output</title>' }),
  );
  await page.goto(origin + '/color-output');
  const result = await page.evaluate(async () => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { ColorOutputPipeline } = await import('/src/infrastructure/gpu-color/index.ts');
    const color = await import('/src/shared/graphics/color/managed-color.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('WebGPU unavailable; colour output regression cannot run');
    // Working values: black, SDR greys and colours, reference white, highlights to
    // the PQ peak, wide-gamut negatives and translucent texels.
    const working = [
      [0, 0, 0, 1], [0.01, 0.01, 0.01, 1], [0.18, 0.18, 0.18, 1], [0.5, 0.5, 0.5, 1],
      [1, 1, 1, 1], [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1],
      [1.5, 1.5, 1.5, 1], [2.25, 1.8, 1.2, 1], [3, 3, 3, 1], [5, 4, 3, 1],
      [-0.2, 1.1, -0.05, 1], [1.2, -0.1, -0.1, 1], [0.8, 0.6, 0.2, 0.5], [7, 7, 7, 0.25],
    ];
    const W = 4;
    const H = 4;
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const input = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
    device.queue.writeTexture({ texture: input }, new Float16Array(working.flat()), { bytesPerRow: W * 8 }, [W, H]);
    const pipeline = new ColorOutputPipeline(device);
    const run = async (target, settings) => {
      const output = device.createTexture({ size: [W, H], format: 'rgba32float', usage });
      const buffer = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      device.pushErrorScope('validation');
      if (!pipeline.convert(input, output, target, color.resolveColorManagement(settings))) throw new Error('rejected');
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [W, H]);
      device.queue.submit([encoder.finish()]);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      await buffer.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(buffer.getMappedRange()));
      buffer.destroy();
      output.destroy();
      return Array.from({ length: W * H }, (_, i) => values.slice((Math.floor(i / W) * 64) + (i % W) * 4, (Math.floor(i / W) * 64) + (i % W) * 4 + 4));
    };
    const half = Array.from(new Float16Array(working.flat()));
    const inputs = working.map((_, i) => half.slice(i * 4, i * 4 + 4));
    const hdr = { workingRange: 'hdr' };
    const cases = {
      pq: { got: await run('pq', hdr), want: inputs.map((c) => color.workingToSignal(c.slice(0, 3), 'pq')) },
      hlg: { got: await run('hlg', hdr), want: inputs.map((c) => color.workingToSignal(c.slice(0, 3), 'hlg')) },
      sdrClip: { got: await run('sdr-display', hdr),
        want: inputs.map((c) => color.workingToSdrDisplay(c.slice(0, 3), color.resolveColorManagement(hdr))) },
      sdrToneMap: { got: await run('sdr-display', { ...hdr, sdrMonitoring: 'bt2390' }),
        want: inputs.map((c) => color.workingToSdrDisplay(c.slice(0, 3),
          color.resolveColorManagement({ ...hdr, sdrMonitoring: 'bt2390' }))) },
      sdrProject: { got: await run('sdr-display', { sdrMonitoring: 'bt2390' }),
        want: inputs.map((c) => c.slice(0, 3).map((v) => Math.min(1, Math.max(0, v)))) },
    };
    const alpha = inputs.map((c) => Math.min(1, Math.max(0, c[3])));
    pipeline.destroy();
    input.destroy();
    device.destroy();
    return { cases, alpha };
  });
  // Raw measurements for conformance evidence, written before any assertion.
  if (process.env.COLOR_OUTPUT_REPORT) await writeFile(process.env.COLOR_OUTPUT_REPORT, JSON.stringify(result));
  let compared = 0;
  for (const [name, { got, want }] of Object.entries(result.cases)) {
    got.forEach((texel, i) => {
      want[i].forEach((value, channel) => {
        compared++;
        assert.ok(Number.isFinite(texel[channel]) && Math.abs(texel[channel] - value) <= 2e-4,
          `${name} texel ${i} channel ${channel}: ${texel[channel]} != ${value}`);
      });
      assert.ok(Math.abs(texel[3] - result.alpha[i]) < 1e-6, `${name} texel ${i}: alpha ${texel[3]}`);
    });
  }
  console.log(JSON.stringify({ check: 'GPU output conversion equals managed-colour reference', targets: Object.keys(result.cases), compared }));
} finally {
  await browser.close();
}
