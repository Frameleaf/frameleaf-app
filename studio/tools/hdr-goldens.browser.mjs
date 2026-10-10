// Runs every case of hdr-goldens.mjs through the real engine and writes
// studio/spec/goldens/hdr.json, the numeric half of studio/spec/hdr.md. Needs the prepared engine
// served by Vite (see render-goldens.browser.mjs):
//   GOLDENS_CROSS_CHECK_ARGS='--enable-unsafe-webgpu --use-angle=metal --ignore-gpu-blocklist' \
//     node studio/tools/hdr-goldens.browser.mjs --write
// Without --write it is the drift gate: the committed goldens must still describe the engine.
// Stage vectors come from the engine's colour functions in binary64. Image cases come from its
// WebGPU pipelines on the canonical software backend (FREECUT_CHROME_ARGS_REPLACE, CI's); the
// differences from the GOLDENS_CROSS_CHECK_ARGS backend set their tolerances.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './render-goldens.mjs';
import {
  HDR_GOLDENS_FORMAT, HDR_GOLDENS_VERSION, IMAGE_SIZE, IMAGE_ENCODING, STAGE_TOLERANCE, stageCases, imageCases, imageInputs,
  encodeBuffer, decodeBuffer, deriveHdrTolerance, compareStage, compareCase, validateHdrGoldens, referenceStage, referenceImage,
} from './hdr-goldens.mjs';

const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldensPath = path.join(studio, 'spec/goldens/hdr.json');

// The engine files whose behaviour these goldens pin.
const SOURCE_FILES = [
  'src/shared/graphics/color/managed-color.ts', 'src/infrastructure/gpu-color/managed-color-wgsl.ts',
  'src/infrastructure/gpu-color/color-output-pipeline.ts', 'src/infrastructure/gpu-color/hdr-frame-upload.ts',
  'src/features/export/utils/hdr-raster-sources.ts', 'src/features/export/utils/project-color.ts',
];
async function sourceDigest() {
  const parts = [];
  for (const file of SOURCE_FILES) parts.push(`${file}\0${sha256(await readFile(path.join(studio, 'engine', file)))}`);
  return { files: SOURCE_FILES.length, sha256: sha256(parts.join('\n')) };
}

const PAGE = `<title>HDR goldens</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>`;

async function runAll(args, origin) {
  const require = createRequire(path.join(studio, 'engine/package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('page error:', error.message));
    await page.route(`${origin}/hdr-goldens`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await page.goto(`${origin}/hdr-goldens`);
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
    return await page.evaluate(async ({ W, H, stages, images, inputs }) => {
      const color = await import('/src/shared/graphics/color/managed-color.ts');
      const { deriveSourceWorkingRange } = await import('/src/features/export/utils/project-color.ts');
      const { HdrRasterSources, validateHdrRaster } = await import('/src/features/export/utils/hdr-raster-sources.ts');
      const { ColorOutputPipeline, HdrFrameUploader } = await import('/src/infrastructure/gpu-color/index.ts');
      const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/index.ts');

      // Stage vectors: the engine's own functions, in binary64.
      const raster = (spec) => (spec.transfer === 'linear'
        ? { width: spec.width, height: spec.height, transfer: 'linear', gamut: spec.gamut, referenceWhite: spec.referenceWhite, rgba: new Float32Array(spec.pixel.map(Number)) }
        : { width: spec.width, height: spec.height, transfer: spec.transfer, rgb: new Uint16Array(spec.samples) });
      const engine = {
        resolve: (settings, range) => color.resolveColorManagement(settings ?? undefined, range),
        sourceRange: (list) => color.workingRangeOfSources(list),
        timelineRange: (tracks, media, compositions) => deriveSourceWorkingRange(tracks, (id) => media[id], compositions),
        decoderTransfer: (space) => color.transferOfColorSpace(space),
        srgbDecode: color.srgbDecodeExtended,
        srgbEncode: color.srgbEncodeExtended,
        pqEncode: color.pqEncode,
        pqDecode: color.pqDecode,
        hlgOetf: color.hlgOetf,
        hlgInverseOetf: color.hlgInverseOetf,
        hlgSystemGamma: color.hlgSystemGamma,
        hlgOotf: color.hlgOotf,
        hlgInverseOotf: color.hlgInverseOotf,
        bt709ToBt2020: (rgb) => color.multiply(color.BT709_TO_BT2020, rgb),
        bt2020ToBt709: (rgb) => color.multiply(color.BT2020_TO_BT709, rgb),
        ycbcrToSignal: color.ycbcr2020ToSignal,
        signalToWorking: color.signalToWorking,
        workingToSignal: color.workingToSignal,
        eetf: color.bt2390Eetf,
        sdrDisplay: (rgb, settings) => color.workingToSdrDisplay(rgb, color.resolveColorManagement(settings)),
        rasterAdmission: (spec) => { try { validateHdrRaster(raster(spec)); return 'admitted'; } catch { return 'rejected'; } },
      };
      const stageResults = stages.map((c) => {
        const value = engine[c.stage](...c.args);
        return Array.isArray(value) ? Array.from(value) : value;
      });

      // Image cases: the engine's WebGPU pipelines.
      const effects = await EffectsPipeline.create();
      if (!effects) throw new Error('WebGPU unavailable');
      const device = effects.getDevice();
      const info = device.adapterInfo ?? {};
      const environment = { userAgent: navigator.userAgent,
        adapter: Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map((key) => [key, String(info[key] ?? '')])) };
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
      const floatTexture = (values) => {
        const texture = device.createTexture({ size: [W, H], format: 'rgba16float', usage });
        if (values) device.queue.writeTexture({ texture }, new Float16Array(values), { bytesPerRow: W * 8 }, [W, H]);
        return texture;
      };
      const readback = async (texture, bytesPerPixel) => {
        const bytesPerRow = Math.ceil((W * bytesPerPixel) / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [W, H]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const out = [];
        const View = bytesPerPixel === 16 ? Float32Array : Float16Array;
        for (let y = 0; y < H; y++) out.push(...new View(mapped, y * bytesPerRow, W * 4));
        buffer.unmap();
        buffer.destroy();
        return out;
      };
      // Harness only: an exact texel copy, because the raster cache's textures cannot be read back.
      const copyModule = device.createShaderModule({ code: `
        @group(0) @binding(0) var source: texture_2d<f32>;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          return vec4f(f32((i << 1u) & 2u) * 2.0 - 1.0, f32(i & 2u) * 2.0 - 1.0, 0.0, 1.0);
        }
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return textureLoad(source, vec2i(p.xy), 0); }` });
      const copyPipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module: copyModule, entryPoint: 'vs' },
        fragment: { module: copyModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
      const copyOut = (source) => {
        const target = floatTexture();
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(copyPipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: copyPipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: source.createView() }] }));
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
        return target;
      };

      const output = new ColorOutputPipeline(device);
      const uploader = new HdrFrameUploader(device);
      const sources = { working: floatTexture(inputs.working), encoded: floatTexture(inputs.encoded) };
      const planeBytes = new Uint8Array(new Uint16Array([...inputs.planes.y, ...inputs.planes.cb, ...inputs.planes.cr]).buffer);
      const planeLayout = [{ offset: 0, stride: W * 2 }, { offset: W * H * 2, stride: W }, { offset: W * H * 2 + (W / 2) * (H / 2) * 2, stride: W }];
      const imageResults = [];
      for (const c of images) {
        device.pushErrorScope('validation');
        let pixels;
        if (c.stage === 'output') {
          const target = device.createTexture({ size: [W, H], format: 'rgba32float', usage });
          if (!output.convert(sources[c.input], target, c.target, color.resolveColorManagement(c.color))) throw new Error(`${c.name}: rejected`);
          pixels = await readback(target, 16);
          target.destroy();
        } else if (c.source === 'bytes') {
          const source = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage });
          device.queue.writeTexture({ texture: source }, new Uint8Array(inputs.bytes), { bytesPerRow: W * 4 }, [W, H]);
          const target = floatTexture();
          effects.setWorkingRange('hdr');
          if (!effects.applyTextureEffectsToTexture(source, [], target, W, H)) throw new Error(`${c.name}: rejected`);
          effects.setWorkingRange('sdr');
          pixels = await readback(target, 8);
          source.destroy();
          target.destroy();
        } else if (c.source === 'planes') {
          const target = floatTexture();
          const frame = { format: 'I420P10', width: W, height: H, transfer: c.transfer, data: planeBytes, layout: planeLayout };
          if (!uploader.upload(frame, target, c.referenceWhite)) throw new Error(`${c.name}: rejected`);
          pixels = await readback(target, 8);
          target.destroy();
        } else {
          const input = c.source === 'linear'
            ? { width: W, height: H, transfer: 'linear', gamut: c.gamut, referenceWhite: c.rasterWhite, rgba: new Float32Array(inputs.working) }
            : { width: W, height: H, transfer: c.transfer, rgb: new Uint16Array(inputs.signal16) };
          const rasters = new HdrRasterSources({ still: input }, () => device);
          const copy = copyOut(rasters.frameTexture('still', c.referenceWhite).texture);
          pixels = await readback(copy, 8);
          copy.destroy();
          rasters.dispose();
        }
        const validation = await device.popErrorScope();
        if (validation) throw new Error(`${c.name}: ${validation.message}`);
        imageResults.push(pixels);
      }
      for (const texture of Object.values(sources)) texture.destroy();
      uploader.destroy();
      output.destroy();
      return { environment, stageResults, imageResults };
    }, { W: IMAGE_SIZE.width, H: IMAGE_SIZE.height, stages: stageCases(), images: imageCases(), inputs: imageInputs() });
  } finally {
    await browser.close();
  }
}

const SWIFTSHADER = '--enable-unsafe-webgpu --use-angle=swiftshader --use-vulkan=swiftshader --enable-features=Vulkan --disable-accelerated-2d-canvas';

/** Drift gate (write false) or regeneration (write true) of studio/spec/goldens/hdr.json. */
export async function runHdrGoldens({ write = false } = {}) {
  const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
  const canonicalArgs = (process.env.FREECUT_CHROME_ARGS_REPLACE || SWIFTSHADER).split(/\s+/).filter(Boolean);
  const stages = stageCases();
  const images = imageCases();
  const canonical = await runAll(canonicalArgs, origin);
  const adapterName = (env) => Object.values(env.adapter).filter(Boolean).join(' / ') || 'unknown adapter';

  if (!write) {
    const goldens = JSON.parse(await readFile(goldensPath, 'utf8'));
    validateHdrGoldens(goldens);
    let failures = 0;
    goldens.stages.forEach((g, i) => {
      if (compareStage(g, JSON.parse(JSON.stringify(canonical.stageResults[i])))) return;
      failures++;
      console.error(`${g.name}: expected ${JSON.stringify(g.expected)}, engine gives ${JSON.stringify(canonical.stageResults[i])}`);
    });
    goldens.images.forEach((g, i) => {
      const result = compareCase({ ...g, expected: decodeBuffer(g.output.data, g.output.encoding) }, canonical.imageResults[i]);
      if (result.pass) return;
      failures++;
      console.error(`${g.name}: ${result.missed} channels outside tolerance (worst ${result.worst.toFixed(6)}, mean ${result.mean.toExponential(2)})`);
    });
    assert.equal(failures, 0, `${failures} HDR golden cases drifted`);
    console.log(`HDR goldens hold (${goldens.stages.length} stage vectors, ${goldens.images.length} images) on ${adapterName(canonical.environment)}`);
    return;
  }

  // Determinism: two canonical runs must agree bit for bit.
  const again = await runAll(canonicalArgs, origin);
  assert.deepEqual(again.stageResults, canonical.stageResults, 'stage vectors are not deterministic');
  canonical.imageResults.forEach((pixels, i) => assert.deepEqual(again.imageResults[i], pixels, `${images[i].name} is not deterministic`));
  const crossArgs = process.env.GOLDENS_CROSS_CHECK_ARGS?.split(/\s+/).filter(Boolean);
  const cross = crossArgs ? await runAll(crossArgs, origin) : null;
  if (cross) {
    assert.notDeepEqual(cross.environment.adapter, canonical.environment.adapter, 'the cross-check must use a different GPU backend');
    assert.deepEqual(cross.stageResults, canonical.stageResults, 'stage vectors must not depend on the GPU backend');
  }
  console.log(`HDR goldens rendered on ${adapterName(canonical.environment)}${cross ? ` and ${adapterName(cross.environment)}` : ''}`);

  const catalogue = JSON.parse(await readFile(path.join(studio, 'graph-parameters-v1.json'), 'utf8'));
  const engineBuild = JSON.parse(await readFile(path.join(studio, 'engine-build.json'), 'utf8'));
  const inputs = imageInputs();
  const buffer = (description, values, encoding) => {
    const data = encodeBuffer(values, encoding);
    return { description, encoding, data, sha256: sha256(data) };
  };
  const head = {
    format: HDR_GOLDENS_FORMAT, version: HDR_GOLDENS_VERSION,
    contract: 'studio/spec/hdr.md',
    engine: { name: 'freecut', revision: catalogue.engine.revision, patches: engineBuild.patches.length, sourceDigest: await sourceDigest() },
    generatedBy: 'studio/tools/hdr-goldens.browser.mjs --write',
    renderer: { canonical: canonical.environment, crossCheck: cross?.environment ?? null },
    comparison: 'Stage vectors: hdr-goldens.mjs compareStage (exact cases bit for bit in binary64; the others within stageTolerance). '
      + 'Images: render-goldens.mjs compareCase with each case\'s tolerance.',
    size: IMAGE_SIZE,
    stageTolerance: STAGE_TOLERANCE,
    inputs: {
      working: buffer('hdr-goldens.mjs imageInputs().working: linear display-referred BT.709 (1.0 = reference white), straight alpha, binary16', inputs.working, 'f16le-deflate-base64'),
      encoded: buffer('hdr-goldens.mjs imageInputs().encoded: sRGB-encoded BT.709, straight alpha, binary16', inputs.encoded, 'f16le-deflate-base64'),
      bytes: buffer('hdr-goldens.mjs imageInputs().bytes: the encoded picture as 8-bit RGBA', inputs.bytes.map((v) => v / 255), 'rgba8-deflate-base64'),
      signal16: { description: 'hdr-goldens.mjs imageInputs().signal16: opaque full-range 16-bit R\'G\'B\' code values, row-major, three per pixel', values: inputs.signal16 },
      planes: { description: 'hdr-goldens.mjs yuvPlanes: 10-bit limited-range BT.2020 Y\'CbCr 4:2:0 code values; y is 16 x 12, cb and cr are 8 x 6, row-major', values: inputs.planes },
    },
  };
  const stageLines = stages.map((c, i) => ({ ...c, expected: canonical.stageResults[i] }));
  const imageLines = images.map((c, i) => {
    const encoding = IMAGE_ENCODING[c.kind];
    const data = encodeBuffer(canonical.imageResults[i], encoding);
    assert.deepEqual(decodeBuffer(data, encoding), canonical.imageResults[i], `${c.name}: encoding is not lossless`);
    return { ...c, tolerance: deriveHdrTolerance(c.kind, canonical.imageResults[i], cross?.imageResults[i], referenceImage(c, inputs)), output: { encoding, data } };
  });
  const lines = (list) => list.map((c) => `    ${JSON.stringify(c)}`).join(',\n');
  const text = `${JSON.stringify(head, null, 2).replace(/\n}$/, '')},\n  "stages": [\n${lines(stageLines)}\n  ],\n  "images": [\n${lines(imageLines)}\n  ]\n}\n`;
  const doc = JSON.parse(text);
  const counts = validateHdrGoldens(doc);
  const bitExact = doc.stages.filter((c) => JSON.stringify(referenceStage(c)) === JSON.stringify(c.expected)).length;
  await writeFile(goldensPath, text);
  console.log(`wrote studio/spec/goldens/hdr.json ${JSON.stringify({ ...counts, referenceBitExact: bitExact })}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runHdrGoldens({ write: process.argv.includes('--write') });
}
