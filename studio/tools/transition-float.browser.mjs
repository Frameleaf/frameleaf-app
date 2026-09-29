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
  await page.route(origin + '/transition-probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Float transition regression</title>' }),
  );
  await page.goto(origin + '/transition-probe');
  const result = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU unavailable; float transition regression cannot run');
    const device = await adapter.requestDevice();
    const { TransitionPipeline } = await import('/src/infrastructure/gpu-transitions/transition-pipeline.ts');
    const textures = [];
    const buffers = [];
    let pipeline;
    try {
      device.pushErrorScope('validation');
      pipeline = TransitionPipeline.create(device);
      if (!pipeline) throw new Error('Transition pipeline initialization failed');
      const texture = (rgba, format = 'rgba16float') => {
        const value = device.createTexture({
          size: [2, 2], format,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
            GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        textures.push(value);
        if (rgba) device.queue.writeTexture(
          { texture: value },
          new Float16Array(Array.from({ length: 4 }, () => rgba).flat()),
          { bytesPerRow: 16 }, [2, 2],
        );
        return value;
      };
      const read = (source) => {
        const buffer = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(buffer);
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: source }, { buffer, bytesPerRow: 256 }, [2, 2]);
        device.queue.submit([encoder.finish()]);
        return buffer;
      };
      // Omit inputAlpha by default: float callers must not inherit the legacy
      // premultiplied default when the nested allocation packet lands.
      const direct = (left, right, progress, inputAlpha, format = 'rgba16float',
        transitionId = 'dissolve', properties, outputAlpha) => {
        const output = texture(null, format);
        if (!pipeline.renderTexturesToTexture(transitionId, texture(left), texture(right), output,
          progress, 2, 2, undefined, properties, inputAlpha, outputAlpha)) throw new Error('Direct transition rejected');
        return read(output);
      };
      const crossfade = direct([1, 0, 0, 1], [0, 0, 1, 0], 0.5);
      const identity = direct([2, -0.5, 0.25, 0.5], [0, 0, 1, 0], 0);
      const transparent = direct([1, 0, 0, 0], [0, 0, 1, 0], 0.5);
      const premultiplied = direct([1, -0.25, 0.125, 0.5], [0, 0, 0, 0], 0, 'premultiplied');
      const legacy = direct([0.5, 0, 0, 0.5], [0, 0, 0, 0], 0, 'premultiplied', 'rgba8unorm');
      const straightSdr = direct([0.5, 0.25, 0, 0.5], [0, 0, 1, 0], 0, 'straight',
        'rgba8unorm', 'dissolve', undefined, 'straight');
      const variantIds = ['additiveDissolve', 'nonAdditiveDissolve', 'lightLeakBurn',
        'filmGateSlip', 'sparkles', 'chromatic', 'lensWarpZoom', 'liquidDistort'];
      const hdr = [2, -0.5, 0.25, 1];
      const properties = { intensity: 0, glow: 0, grain: 0, exposure: 0, spread: 0,
        burn: 0, edgeSoftness: 0.01, chroma: 0, vignette: 0 };
      const variants = variantIds.map((id) => ({ id, readbacks: [0, 0.5, 1].map((progress) =>
        direct(hdr, hdr, progress, undefined, 'rgba16float', id, properties)) }));
      const additive = direct(hdr, hdr, 0.5, undefined, 'rgba16float', 'additiveDissolve');
      const legacyVariant = direct(hdr, hdr, 0, 'premultiplied', 'rgba8unorm', 'additiveDissolve');
      const leftCanvas = new OffscreenCanvas(2, 2);
      const ctx = leftCanvas.getContext('2d');
      ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.fillRect(0, 0, 2, 2);
      const rightCanvas = new OffscreenCanvas(2, 2);
      const canvasFloat = texture(null);
      if (!pipeline.renderToTexture('dissolve', leftCanvas, rightCanvas, canvasFloat, 0, 2, 2)) {
        throw new Error('Canvas to float transition rejected');
      }
      const uploaded = read(canvasFloat);
      const canvasSdr = texture(null, 'rgba8unorm');
      if (!pipeline.renderToTexture('dissolve', leftCanvas, rightCanvas, canvasSdr, 0, 2, 2,
        undefined, undefined, 'straight')) throw new Error('Canvas to straight SDR rejected');
      const uploadedSdr = read(canvasSdr);
      const rendered = pipeline.render('dissolve', leftCanvas, rightCanvas, 0, 2, 2);
      if (!rendered) throw new Error('Legacy canvas transition rejected');
      const legacyCanvas = new OffscreenCanvas(2, 2);
      const legacyCtx = legacyCanvas.getContext('2d');
      legacyCtx.drawImage(rendered, 0, 0);
      const canvasPixels = Array.from(legacyCtx.getImageData(0, 0, 1, 1).data);
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      if (error) throw new Error(`Transition GPU validation failed: ${error.message}`);
      await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
      const floats = (buffer) => Array.from(new Float16Array(buffer.getMappedRange(), 0, 4));
      return {
        crossfade: floats(crossfade), identity: floats(identity), transparent: floats(transparent),
        premultiplied: floats(premultiplied), uploaded: floats(uploaded),
        legacy: Array.from(new Uint8Array(legacy.getMappedRange(), 0, 4)), canvasPixels,
        straightSdr: Array.from(new Uint8Array(straightSdr.getMappedRange(), 0, 4)),
        uploadedSdr: Array.from(new Uint8Array(uploadedSdr.getMappedRange(), 0, 4)),
        legacyVariant: Array.from(new Uint8Array(legacyVariant.getMappedRange(), 0, 4)),
        additive: floats(additive),
        variants: variants.map(({ id, readbacks }) => ({ id, pixels: readbacks.map(floats) })),
      };
    } finally {
      pipeline?.destroy();
      for (const texture of textures) texture.destroy();
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
    }
  });
  const expected = {
    crossfade: [1, 0, 0, 0.5], identity: [2, -0.5, 0.25, 0.5], transparent: [0, 0, 0, 0],
    premultiplied: [2, -0.5, 0.25, 0.5], uploaded: [1, 0, 0, 128 / 255],
    legacy: [128, 0, 0, 128], canvasPixels: [255, 0, 0, 128],
    straightSdr: [128, 64, 0, 128], uploadedSdr: [255, 0, 0, 128],
    legacyVariant: [255, 0, 64, 255], additive: [2.88, -0.72, 0.36, 1],
  };
  for (const [name, channels] of Object.entries(expected)) {
    const tolerance = ['legacy', 'canvasPixels', 'straightSdr', 'uploadedSdr', 'legacyVariant'].includes(name) ? 1 : 0.002;
    channels.forEach((value, channel) => assert.ok(
      Math.abs(result[name][channel] - value) <= tolerance,
      `${name} channel ${channel}: ${result[name][channel]} != ${value}`,
    ));
  }
  for (const { id, pixels } of result.variants) {
    for (const index of [0, 2]) {
      [2, -0.5, 0.25, 1].forEach((value, channel) => assert.ok(
        Math.abs(pixels[index][channel] - value) < 0.002,
        `${id} endpoint ${index / 2} channel ${channel}: ${pixels[index][channel]} != ${value}`,
      ));
    }
    assert.ok(pixels[1].every(Number.isFinite) && pixels[1][0] > 1 && pixels[1][1] < 0,
      `${id} midpoint clipped signed extended-range RGB: ${pixels[1]}`);
  }
  console.log(JSON.stringify({ check: 'transition float range, alpha boundaries and legacy canvas', ...result }));
} finally {
  await browser.close();
}
