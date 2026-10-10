#!/usr/bin/env node
// FL-145 dependency: measured hardware compositor readback, NOT worker admission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory } from './engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const engine = path.join(root, 'studio/engine');
const expected = [-0.5, 2, 0.25, 0.5, -0.5, 2, 0.25, 0.5];
const tolerance = 0.001;

export function validateHardwareReadback(result) {
  // Modern WebGPU exposes this on adapter.info; older pinned Chromium exposes it on adapter.
  // Missing identification is not evidence of hardware. Keep unknown devices unqualified.
  assert.equal(result.adapter.isFallbackAdapter, false, 'SOFTWARE_RENDERER_OR_UNKNOWN');
  const identity = [result.adapter.vendor, result.adapter.architecture, result.adapter.device, result.adapter.description];
  assert.ok(identity.some((value) => typeof value === 'string' && value.trim()), 'ADAPTER_IDENTITY_UNAVAILABLE');
  assert.ok(!/swiftshader|llvmpipe|lavapipe|software|microsoft basic|\bwarp\b/i.test(identity.join(' ')), 'SOFTWARE_RENDERER');
  assert.equal(result.format, 'rgba16float');
  assert.equal(result.pixels.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Number.isFinite(result.pixels[i]) && Math.abs(result.pixels[i] - expected[i]) < tolerance,
      `COMPOSITOR_READBACK_MISMATCH channel ${i}`);
  }
}

// Runs entirely in Chromium. The device used to render belongs to the adapter we report.
async function measureCompositor() {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WEBGPU_UNAVAILABLE');
  const info = adapter.info ?? {};
  const identification = {
    vendor: info.vendor ?? '', architecture: info.architecture ?? '',
    device: info.device ?? '', description: info.description ?? '',
    isFallbackAdapter: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null,
  };
  const device = await adapter.requestDevice();
  let pipeline;
  let source;
  let readback;
  let unexpectedError;
  device.addEventListener('uncapturederror', (event) => { unexpectedError = event.error.message; });
  // Also fail if the device disappears during the measurement.
  device.lost.then((info) => { unexpectedError = `GPU_DEVICE_LOST: ${info.reason}`; });
  try {
    const { CompositorPipeline, DEFAULT_LAYER_PARAMS } =
      await import('/src/infrastructure/gpu-compositor/compositor-pipeline.ts');
    device.pushErrorScope('validation');
    pipeline = new CompositorPipeline(device);
    source = device.createTexture({
      size: [2, 1], format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: source },
      new Float16Array([-0.5, 2, 0.25, 0.5, -0.5, 2, 0.25, 0.5]), { bytesPerRow: 16 }, [2, 1]);
    const encoder = device.createCommandEncoder();
    const composite = pipeline.compositeToTexture([{
      params: { ...DEFAULT_LAYER_PARAMS, sourceAspect: 2, outputAspect: 2 },
      textureView: source.createView(),
      // Binding 4 is required even when hasMask is false; the shader will not sample it.
      maskView: source.createView(),
    }], 2, 1, encoder);
    if (!composite) throw new Error('COMPOSITOR_UNAVAILABLE');
    readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: composite.texture }, { buffer: readback, bytesPerRow: 256 }, [2, 1]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = Array.from(new Float16Array(readback.getMappedRange().slice(0, 16)));
    readback.unmap();
    const error = await device.popErrorScope();
    if (error || unexpectedError) throw new Error(error?.message ?? unexpectedError);
    return { adapter: identification, format: composite.texture.format, pixels };
  } finally {
    readback?.destroy();
    source?.destroy();
    pipeline?.destroy();
    device.destroy();
  }
}

export async function main() {
  assert.equal(process.argv.length, 2, 'Usage: node studio/tools/render-worker-probe.mjs');
  const configuration = JSON.parse(await readFile(path.join(root, 'studio/engine-build.json'), 'utf8'));
  assert.equal(process.versions.node, configuration.node, 'Use the pinned Node version');
  // Verify bytes, not merely a manifest claiming that preparation once succeeded.
  const verifySource = async () => {
    const files = await inventory(engine, '', new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']));
    assert.equal(createHash('sha256').update(JSON.stringify(files)).digest('hex'), configuration.sourceSha256,
      'Prepared engine source differs from engine-build.json');
  };
  await verifySource();
  const require = createRequire(path.join(engine, 'package.json'));
  const { chromium } = require('playwright');
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  const { chromeLaunchArgs } = await import(pathToFileURL(path.join(engine, 'headless/lib/cli.mjs')).href);
  // Own the source server so an external URL cannot supply a different engine under this digest.
  const server = await createServer({
    root: engine, configFile: false, publicDir: false, logLevel: 'error',
    resolve: { alias: { '@': path.join(engine, 'src') } },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false },
    plugins: [{
      name: 'worker-probe-document',
      configureServer(server) {
        server.middlewares.use('/worker-probe', (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><title>Frameleaf hardware compositor probe</title>');
        });
      },
    }],
  });
  let browser;
  let timeout;
  const startedAt = new Date().toISOString();
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
    const page = await browser.newPage();
    // This specimen requires no remote media, credentials or network resources.
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/worker-probe`);
    const result = await Promise.race([
      page.evaluate(measureCompositor),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('GPU_PROBE_TIMEOUT')), 30_000); }),
    ]);
    validateHardwareReadback(result);
    await verifySource();
    return {
      schemaVersion: 1, kind: 'hardware-compositor-probe',
      engineRevision: configuration.upstreamCommit, sourceSha256: configuration.sourceSha256,
      browser: browser.version(), startedAt, finishedAt: new Date().toISOString(),
      ...result, expected, tolerance,
      // One float specimen proves neither a codec, a container, nor the full render-worker contract.
      workerAdmissionReady: false, codecs: [], formats: [], gpuMemoryBytes: null,
    };
  } finally {
    clearTimeout(timeout);
    try { await browser?.close(); } finally { await server.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
