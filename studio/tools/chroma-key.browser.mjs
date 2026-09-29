// FL-99: effect.gpu-chroma-key and readme.effects-masks-compositing.5.
// Hosted software-WebGPU readback of the shared preview/export effect pipeline.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  await page.route(origin + '/chroma-probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Chroma key regression</title>' }),
  );
  await page.goto(origin + '/chroma-probe');
  const { cases: results, precision } = await page.evaluate(async () => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { resolveAnimatedGpuEffects } =
      await import('/src/features/keyframes/utils/effect-animatable-properties.ts');
    const { buildEffectAnimatableProperty } = await import('/src/types/keyframe.ts');
    const { getGpuEffectInstances } = await import('/src/features/export/utils/canvas-effects.ts');
    const pipeline = await EffectsPipeline.create();
    if (!pipeline) throw new Error('WebGPU unavailable; chroma regression cannot run');
    const device = pipeline.getDevice();
    const textures = [];
    const buffers = [];
    const results = [];
    const precision = [];
    try {
      device.pushErrorScope('validation');
      const texture = () => {
        const value = device.createTexture({
          size: [2, 2], format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        textures.push(value);
        return value;
      };
      for (const keyColor of ['green', 'blue']) {
        const swap = (rgba) => keyColor === 'green' ? rgba : [rgba[0], rgba[2], rgba[1], rgba[3]];
        const pixels = [
          [0, 1, 0, 1], // Exact key: zero softness and tolerance must still remove it.
          [0.25, 0.75, 0.25, 0.5], // Visible spill, with partial source alpha.
          [0.75, 0.25, 0.25, 1], // Foreground with no spill.
          [0.125, 0.875, 0.125, 1], // Soft boundary coverage.
        ].map(swap).flat();
        const input = texture();
        const output = texture();
        device.queue.writeTexture({ texture: input }, new Float16Array(pixels), { bytesPerRow: 16 }, [2, 2]);
        const canvas = new OffscreenCanvas(2, 2);
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.map((v) => v * 255)), 2, 2), 0, 0);
        // Account for the Canvas2D source's own alpha quantization before uploading it.
        const canvasInput = Array.from(ctx.getImageData(0, 0, 2, 2).data, (v) => v / 255);
        for (const softness of [0, 0.2]) {
          const entry = {
            id: 'key', enabled: true,
            effect: { type: 'gpu-effect', gpuEffectType: 'gpu-chroma-key',
              params: { keyColor, tolerance: 0, softness, spillSuppression: 0 } },
          };
          const keyframes = { itemId: 'clip', properties: [{
            property: buildEffectAnimatableProperty('gpu-chroma-key', 'key', 'spillSuppression'),
            keyframes: [
              { id: 'start', frame: 0, value: 0, easing: 'linear' },
              { id: 'end', frame: 10, value: 1, easing: 'linear' },
            ],
          }] };
          for (const frame of [0, 5, 10]) {
            const effects = getGpuEffectInstances(resolveAnimatedGpuEffects([entry], keyframes, frame));
            if (!pipeline.applyTextureEffectsToTexture(input, effects, output, 2, 2)) {
              throw new Error('Native texture effect output rejected');
            }
            const buffer = device.createBuffer({ size: 512,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            buffers.push(buffer);
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [2, 2]);
            device.queue.submit([encoder.finish()]);
            const rendered = pipeline.applyEffectsToCanvas(canvas, effects);
            if (!rendered) throw new Error('Preview canvas effect output rejected');
            const readCtx = new OffscreenCanvas(2, 2).getContext('2d');
            readCtx.drawImage(rendered, 0, 0);
            results.push({ keyColor, softness, frame, params: effects[0].params, pixels, canvasInput,
              canvasOutput: Array.from(readCtx.getImageData(0, 0, 2, 2).data, (v) => v / 255), buffer });
          }
        }
      }
      // Backend precision witness (FL-97): an exact key must stay transparent on every
      // backend, while one 10-bit code value off the key must stay opaque.
      const code = 1 / 1023;
      for (const keyColor of ['green', 'blue']) {
        const dominant = keyColor === 'green' ? 1 : 2;
        const key = [0, 0, 0, 1];
        key[dominant] = 1;
        const nearDominant = key.slice();
        nearDominant[dominant] = 1 - code;
        const nearRed = key.slice();
        nearRed[0] = code;
        const pixels = [key, nearDominant, key, nearRed].flat();
        const input = texture();
        const output = texture();
        device.queue.writeTexture({ texture: input }, new Float16Array(pixels), { bytesPerRow: 16 }, [2, 2]);
        const effects = getGpuEffectInstances(resolveAnimatedGpuEffects([{
          id: 'key', enabled: true,
          effect: { type: 'gpu-effect', gpuEffectType: 'gpu-chroma-key',
            params: { keyColor, tolerance: 0, softness: 0, spillSuppression: 0 } },
        }], undefined, 0));
        if (!pipeline.applyTextureEffectsToTexture(input, effects, output, 2, 2)) {
          throw new Error('Native texture effect output rejected');
        }
        const buffer = device.createBuffer({ size: 512,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(buffer);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [2, 2]);
        device.queue.submit([encoder.finish()]);
        precision.push({ keyColor, buffer });
      }
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      if (error) throw new Error(`Chroma GPU validation failed: ${error.message}`);
      await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
      const texels = (buffer) => {
        const mapped = buffer.getMappedRange();
        return [0, 256].flatMap((offset) => Array.from(new Float16Array(mapped, offset, 8)));
      };
      return {
        cases: results.map(({ buffer, ...result }) => ({ ...result, textureOutput: texels(buffer) })),
        precision: precision.map(({ buffer, ...result }) => ({ ...result, alpha: texels(buffer)
          .filter((_, index) => index % 4 === 3) })),
      };
    } finally {
      pipeline.destroy();
      for (const buffer of buffers) buffer.destroy();
      for (const texture of textures) texture.destroy();
      device.destroy();
    }
  });
  for (const result of results) {
    const { keyColor, softness, frame } = result;
    const suppression = frame / 10;
    assert.equal(result.params.spillSuppression, suppression, 'Authored spill animation must reach the shader');
    const key = keyColor === 'green' ? [0, 1, 0] : [0, 0, 1];
    const chroma = ([r, g, b]) => {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      return [0.564 * (b - y), 0.713 * (r - y)];
    };
    const keyChroma = chroma(key);
    for (const route of ['texture', 'canvas']) {
      const input = route === 'texture' ? result.pixels : result.canvasInput;
      const actual = result[route + 'Output'];
      for (let pixel = 0; pixel < 4; pixel++) {
        const rgba = input.slice(pixel * 4, pixel * 4 + 4);
        const cbcr = chroma(rgba);
        const distance = Math.hypot(cbcr[0] - keyChroma[0], cbcr[1] - keyChroma[1]);
        // Mirrors the shader's hard-edge key width (2^-16 in CbCr).
        const t = softness === 0 ? Number(distance > 1 / 65536) : Math.min(1, distance / softness);
        const alpha = rgba[3] * t * t * (3 - 2 * t);
        const dominant = keyColor === 'green' ? 1 : 2;
        const other = dominant === 1 ? 2 : 1;
        const spill = Math.max(0, rgba[dominant] - Math.max(rgba[0], rgba[other])) * suppression;
        const expected = rgba.slice();
        expected[dominant] -= spill;
        expected[0] += spill / 2;
        expected[other] += spill / 2;
        expected[3] = alpha;
        for (let channel = 0; channel < 4; channel++) {
          // Canvas readback loses RGB at alpha zero; compare premultiplied color there.
          const observed = actual[pixel * 4 + channel] *
            (route === 'canvas' && channel < 3 ? actual[pixel * 4 + 3] : 1);
          const wanted = expected[channel] * (route === 'canvas' && channel < 3 ? alpha : 1);
          assert.ok(Number.isFinite(observed) && Math.abs(observed - wanted) < (route === 'canvas' ? 0.012 : 0.002),
            `${route} ${keyColor} softness=${softness} spill=${suppression} pixel=${pixel} channel=${channel}: ${observed} != ${wanted}`);
        }
      }
    }
  }
  for (const { keyColor, alpha } of precision) {
    assert.deepEqual(alpha, [0, 1, 0, 1],
      `${keyColor} hard key must remove the exact key and keep colors one 10-bit code value away`);
  }
  console.log(JSON.stringify({ check: 'chroma hard/soft alpha and animated green/blue spill', cases: results.length,
    precision: precision.length,
    manifestIds: ['effect.gpu-chroma-key', 'readme.effects-masks-compositing.5'] }));
} finally {
  await browser.close();
}
