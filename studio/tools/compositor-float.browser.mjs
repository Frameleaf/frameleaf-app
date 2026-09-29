// Run against the prepared engine's Vite server; CI uses software WebGPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const softLightBase = [-0.25, 4, 0, 1, 0.0625, 0.25, 0.75, 1, -0.25, 4, 0, 0.5, 0.0625, 0.25, 0.75, 0.5];
const softLightLevels = [0, 0.25, 0.5, 0.75, 1];
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  // Import only the production compositor, without starting the editor or acquiring media.
  await page.route(origin + '/float-probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Float compositor regression</title>' }),
  );
  await page.goto(origin + '/float-probe');
  const probe = async ({ softLightBase, softLightLevels }) => {
    if (!navigator.gpu) throw new Error('WebGPU unavailable; compositor float regression cannot run');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter; compositor float regression cannot run');
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('No effects GPU device');
    const { CompositorPipeline, DEFAULT_LAYER_PARAMS } =
      await import('/src/infrastructure/gpu-compositor/compositor-pipeline.ts');
    const textures = [];
    const buffers = [];
    let pipeline;
    let effectsPipeline;
    let frame;
    try {
      device.pushErrorScope('validation');
      pipeline = new CompositorPipeline(device);
      const pixels = [-0.5, 2, 0.333251953125, 0.5, 2, 4, -1, 1, 0.25, 0.5, 0.75, 1, 0, 0, 0, 0];
      const texture = (values) => {
        const value = device.createTexture({
          size: [4, 1],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        textures.push(value);
        device.queue.writeTexture({ texture: value }, new Float16Array(values), { bytesPerRow: 32 }, [4, 1]);
        return value;
      };
      const source = texture(pixels);
      const mask = texture(Array.from({ length: 4 }, () => [0, 0, 0, 0.5]).flat());
      const layer = {
        params: { ...DEFAULT_LAYER_PARAMS, sourceAspect: 4, outputAspect: 4 },
        textureView: source.createView(),
        maskView: mask.createView(),
      };
      const videoCanvas = new OffscreenCanvas(4, 1);
      // Opaque black on three pixels; retain a transparent pixel for alpha-zero coverage.
      videoCanvas.getContext('2d').fillRect(0, 0, 3, 1);
      frame = new VideoFrame(videoCanvas, { timestamp: 0 });
      const layers = [
        layer,
        { ...layer, params: { ...layer.params, hasMask: true } },
        {
          params: { ...layer.params, opacity: 0.25 },
          externalTexture: device.importExternalTexture({ source: frame }),
          maskView: mask.createView(),
        },
      ];
      const encoder = device.createCommandEncoder();
      const composite = pipeline.compositeToTexture(layers, 4, 1, encoder);
      if (!composite) throw new Error('Compositor rejected float layers');
      const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      buffers.push(readback);
      encoder.copyTextureToBuffer({ texture: composite.texture }, { buffer: readback, bytesPerRow: 256 }, [4, 1]);
      device.queue.submit([encoder.finish()]);

      const canvas = new OffscreenCanvas(4, 1);
      const context = canvas.getContext('webgpu');
      const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({
        device,
        format: canvasFormat,
        alphaMode: 'premultiplied',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      });
      if (!pipeline.compositeToCanvas(layers, 4, 1, context)) throw new Error('Compositor rejected canvas output');
      const canvasReadback = device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      buffers.push(canvasReadback);
      const canvasEncoder = device.createCommandEncoder();
      canvasEncoder.copyTextureToBuffer(
        { texture: context.getCurrentTexture() },
        { buffer: canvasReadback, bytesPerRow: 256 },
        [4, 1],
      );
      device.queue.submit([canvasEncoder.finish()]);
      const softLightSource = texture(softLightBase);
      const softLightReadbacks = [];
      for (const level of softLightLevels) {
        const top = texture(Array.from({ length: 4 }, () => [level, level, level, 0.5]).flat());
        const blendEncoder = device.createCommandEncoder();
        const blended = pipeline.compositeToTexture(
          [
            { ...layer, textureView: softLightSource.createView() },
            { ...layer, textureView: top.createView(), params: { ...layer.params, blendMode: 'soft-light' } },
          ],
          4,
          1,
          blendEncoder,
        );
        if (!blended) throw new Error('Compositor rejected Soft Light layers');
        const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(buffer);
        softLightReadbacks.push(buffer);
        blendEncoder.copyTextureToBuffer({ texture: blended.texture }, { buffer, bytesPerRow: 256 }, [4, 1]);
        device.queue.submit([blendEncoder.finish()]);
      }
      effectsPipeline = await EffectsPipeline.create();
      if (!effectsPipeline) throw new Error('Effects pipeline unavailable');
      const effect = (type, params) => ({ id: type, type, name: type, enabled: true, params });
      const identityEffects = [
        effect('gpu-vignette', { amount: 0 }),
        effect('gpu-pixel-sort-hq', { low: 1, high: 0 }),
        effect('gpu-vignette', { amount: 0 }),
      ];
      const effectTexture = (format, values) => {
        const value = device.createTexture({
          size: [2, 2], format,
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST |
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        textures.push(value);
        if (values) device.queue.writeTexture(
          { texture: value },
          format === 'rgba16float' ? new Float16Array(values) : new Uint8Array(values),
          { bytesPerRow: format === 'rgba16float' ? 16 : 8 }, [2, 2],
        );
        return value;
      };
      const effectReadbacks = [];
      const readEffect = (name, texture) => {
        const buffer = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(buffer);
        effectReadbacks.push({ name, buffer, format: texture.format });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [2, 2]);
        device.queue.submit([encoder.finish()]);
      };
      const runEffects = (name, input, chain, output) => {
        if (!effectsPipeline.applyTextureEffectsToTexture(input, chain, output, 2, 2)) {
          throw new Error(`Effects rejected ${name}`);
        }
        readEffect(name, output);
      };
      const effectInput = effectTexture('rgba16float', [...pixels.slice(0, 12), 1.25, -0.25, 0.0009765625, 0]);
      const floatOutput = effectTexture('rgba16float');
      const sdrOutput = effectTexture('rgba8unorm');
      runEffects('identity', effectInput, identityEffects, floatOutput);
      // A visible fragment operation followed by compute scatter proves neither pass was skipped.
      runEffects('active', effectInput, [
        effect('gpu-vignette', { amount: 0.5, size: 0, softness: 0.5 }),
        effect('gpu-pixel-sort-hq', { low: -100, high: 100, order: 'descending' }),
      ], floatOutput);
      runEffects('sdrExit', effectInput, identityEffects, sdrOutput);
      runEffects('sdrEntry', sdrOutput, identityEffects, floatOutput);
      // Same-size format switches must invalidate texture views and effect bind groups.
      runEffects('legacy', sdrOutput, identityEffects, effectTexture('rgba8unorm'));
      runEffects('floatAgain', effectInput, identityEffects, floatOutput);
      runEffects('emptyExit', effectInput, [], sdrOutput);
      runEffects('emptyEntry', sdrOutput, [], floatOutput);
      const legacyCanvas = new OffscreenCanvas(2, 2);
      const legacy2d = legacyCanvas.getContext('2d');
      legacy2d.fillStyle = 'rgba(128, 64, 32, 0.5)';
      legacy2d.fillRect(0, 0, 2, 2);
      const legacyExpected = Array.from(legacy2d.getImageData(0, 0, 2, 2).data);
      if (!effectsPipeline.applyEffectsToTexture(legacyCanvas, identityEffects, floatOutput)) {
        throw new Error('External canvas to float effects failed');
      }
      readEffect('externalFloat', floatOutput);
      const effectCanvas = effectsPipeline.applyEffectsToCanvas(legacyCanvas, identityEffects);
      if (!effectCanvas) throw new Error('Legacy canvas effects failed after float use');
      const canvasCheck = new OffscreenCanvas(2, 2).getContext('2d');
      canvasCheck.drawImage(effectCanvas, 0, 0);
      const legacyActual = Array.from(canvasCheck.getImageData(0, 0, 2, 2).data);
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      if (error) throw new Error(`Float compositor GPU validation failed: ${error.message}`);
      await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
      return {
        effectPixels: Object.fromEntries(effectReadbacks.map(({ name, buffer, format }) => {
          const View = format === 'rgba16float' ? Float16Array : Uint8Array;
          const mapped = buffer.getMappedRange();
          return [name, [0, 256].flatMap((offset) => Array.from(new View(mapped, offset, 8)))];
        })),
        legacyExpected,
        legacyActual,
        format: composite.texture.format,
        pixels: Array.from(new Float16Array(readback.getMappedRange(), 0, 16)),
        canvasFormat,
        canvasPixels: Array.from(new Uint8Array(canvasReadback.getMappedRange(), 0, 16)),
        softLightPixels: softLightReadbacks.map((buffer) =>
          Array.from(new Float16Array(buffer.getMappedRange(), 0, 16)),
        ),
        adapter: {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          description: adapter.info.description,
        },
      };
    } finally {
      frame?.close();
      pipeline?.destroy();
      effectsPipeline?.destroy();
      for (const texture of textures) texture.destroy();
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
    }
  };
  const result = await page.evaluate(probe, { softLightBase, softLightLevels });
  assert.equal(result.format, 'rgba16float');
  // Black video at 25% opacity must contribute: masked alpha 5/8 becomes 23/32,
  // and its straight RGB is attenuated by (5/8 * 3/4) / (23/32) = 15/23.
  const expected = [
    (-0.5 * 15) / 23,
    (2 * 15) / 23,
    (0.333251953125 * 15) / 23,
    23 / 32,
    1.5,
    3,
    -0.75,
    1,
    0.1875,
    0.375,
    0.5625,
    1,
    0,
    0,
    0,
    0,
  ];
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(result.pixels[i] - expected[i]) < 0.001,
      `Float channel ${i}: ${result.pixels[i]} != ${expected[i]}`,
    );
  }
  assert.ok(['rgba8unorm', 'bgra8unorm'].includes(result.canvasFormat));
  const order = result.canvasFormat === 'bgra8unorm' ? [2, 1, 0, 3] : [0, 1, 2, 3];
  for (let pixel = 0; pixel < 4; pixel++) {
    const rgba = expected.slice(pixel * 4, pixel * 4 + 4);
    const converted = rgba.map((value, channel) =>
      Math.round(Math.min(1, Math.max(0, value)) * (channel === 3 ? 1 : rgba[3]) * 255),
    );
    for (let channel = 0; channel < 4; channel++) {
      assert.ok(
        Math.abs(result.canvasPixels[pixel * 4 + channel] - converted[order[channel]]) <= 1,
        `Canvas pixel ${pixel}, channel ${channel}: explicit premultiplied conversion changed`,
      );
    }
  }
  for (const [index, level] of softLightLevels.entries()) {
    for (let pixel = 0; pixel < 4; pixel++) {
      const baseAlpha = softLightBase[pixel * 4 + 3];
      const alpha = 0.5 + baseAlpha * 0.5;
      for (let channel = 0; channel < 4; channel++) {
        const base = softLightBase[pixel * 4 + channel];
        // Retain the existing SDR formula; use its signed-root extension for negative RGB.
        const blend =
          level <= 0.5
            ? base - (1 - 2 * level) * base * (1 - base)
            : base + (2 * level - 1) * (Math.sign(base) * Math.sqrt(Math.abs(base)) - base);
        const expected =
          channel === 3
            ? alpha
            : (blend * baseAlpha * 0.5 + level * 0.5 * (1 - baseAlpha) + base * baseAlpha * 0.5) / alpha;
        const actual = result.softLightPixels[index][pixel * 4 + channel];
        assert.ok(
          Number.isFinite(actual) && Math.abs(actual - expected) < 0.005,
          `Soft Light ${level}, pixel ${pixel}, channel ${channel}: ${actual} != ${expected}`,
        );
      }
    }
  }
  const effectInput = [-0.5, 2, 0.333251953125, 0.5, 2, 4, -1, 1, 0.25, 0.5, 0.75, 1, 1.25, -0.25, 0.0009765625, 0];
  const quantized = effectInput.map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255));
  const active = [1, 0, 2, 3].flatMap((pixel) =>
    effectInput.slice(pixel * 4, pixel * 4 + 4).map((value, channel) => channel === 3 ? value : value * 0.5),
  );
  const effectExpected = {
    identity: effectInput, active, floatAgain: effectInput,
    sdrExit: quantized, emptyExit: quantized, legacy: quantized,
    sdrEntry: quantized.map((value) => value / 255),
    emptyEntry: quantized.map((value) => value / 255),
    externalFloat: result.legacyExpected.map((value) => value / 255),
  };
  for (const [name, expected] of Object.entries(effectExpected)) {
    for (let i = 0; i < expected.length; i++) {
      const tolerance = ['sdrExit', 'emptyExit', 'legacy'].includes(name) ? 1
        : ['identity', 'active', 'floatAgain'].includes(name) ? 0.0001 : 0.003;
      const actual = result.effectPixels[name][i];
      assert.ok(Number.isFinite(actual) && Math.abs(actual - expected[i]) <= tolerance,
        `Effect ${name}, channel ${i}: ${actual} != ${expected[i]}`);
    }
  }
  for (let i = 0; i < result.legacyExpected.length; i++) {
    assert.ok(Math.abs(result.legacyActual[i] - result.legacyExpected[i]) <= 2,
      `Legacy effects canvas channel ${i}: alpha representation changed`);
  }
  console.log(JSON.stringify({ check: 'compositor and effect float transport, compute scatter, alpha and SDR boundaries', ...result }));
} finally {
  await browser.close();
}
