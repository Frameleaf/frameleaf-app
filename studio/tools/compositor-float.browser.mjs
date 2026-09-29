// Run against the prepared engine's Vite server; CI uses software WebGPU.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  // Import only the production compositor, without starting the editor or acquiring media.
  await page.route(origin + '/float-probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Float compositor regression</title>' }),
  );
  await page.goto(origin + '/float-probe');
  const result = await page.evaluate(async () => {
    if (!navigator.gpu) throw new Error('WebGPU unavailable; compositor float regression cannot run');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter; compositor float regression cannot run');
    const device = await adapter.requestDevice();
    const { CompositorPipeline, DEFAULT_LAYER_PARAMS } =
      await import('/src/infrastructure/gpu-compositor/compositor-pipeline.ts');
    const textures = [];
    const buffers = [];
    let pipeline;
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
      videoCanvas.getContext('2d').fillRect(0, 0, 4, 1);
      frame = new VideoFrame(videoCanvas, { timestamp: 0 });
      const layers = [
        layer,
        { ...layer, params: { ...layer.params, hasMask: true } },
        {
          params: { ...layer.params, opacity: 0 },
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
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      if (error) throw new Error(`Float compositor GPU validation failed: ${error.message}`);
      await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
      return {
        format: composite.texture.format,
        pixels: Array.from(new Float16Array(readback.getMappedRange(), 0, 16)),
        canvasFormat,
        canvasPixels: Array.from(new Uint8Array(canvasReadback.getMappedRange(), 0, 16)),
        adapter: {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          description: adapter.info.description,
        },
      };
    } finally {
      frame?.close();
      pipeline?.destroy();
      for (const texture of textures) texture.destroy();
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
    }
  });
  assert.equal(result.format, 'rgba16float');
  const expected = [-0.5, 2, 0.333251953125, 0.625, 2, 4, -1, 1, 0.25, 0.5, 0.75, 1, 0, 0, 0, 0];
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
  console.log(JSON.stringify({ check: 'compositor float range, mask alpha and SDR output', ...result }));
} finally {
  await browser.close();
}
