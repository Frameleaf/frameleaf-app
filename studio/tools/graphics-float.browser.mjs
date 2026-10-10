// FL-97: SDR text/Lottie enters linear display-light before filtering, including inside Compose.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  await page.route(origin + '/graphics-float', (route) => route.fulfill({ contentType: 'text/html', body: `
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }));
  await page.goto(origin + '/graphics-float');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  const result = await page.evaluate(async () => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { MediaRenderPipeline } = await import('/src/infrastructure/gpu-media/media-render-pipeline.ts');
    const { MediaBlendPipeline } = await import('/src/infrastructure/gpu-media/media-blend-pipeline.ts');
    const { GpuTexturePool } = await import('/src/infrastructure/gpu-compositor/gpu-texture-pool.ts');
    const { LottieExportProvider } = await import('/src/infrastructure/lottie/lottie-frame-provider.ts');
    const { CanvasPool, TextMeasurementCache } = await import('/src/features/export/utils/canvas-pool.ts');
    const { renderItem } = await import('/src/features/export/utils/canvas-item-renderer/render-item.ts');
    const { prepareGpuMediaParticipant } = await import('/src/features/export/utils/canvas-item-renderer/gpu.ts');
    const { renderItemToFloatTexture } = await import('/src/features/export/utils/canvas-item-renderer/transition.ts');
    const { renderTextItem } = await import('/src/features/export/utils/canvas-item-renderer/text.ts');
    const { expandTextTransformToFitContent } = await import('/src/features/export/deps/composition-runtime.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('WebGPU unavailable; graphics float regression cannot run');
    const effects = await EffectsPipeline.create();
    if (!effects) throw new Error('Effects pipeline unavailable');
    effects.setWorkingRange('hdr');
    const media = new MediaRenderPipeline(device);
    media.setWorkingRange('hdr');
    const decode = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    // ImageData rounds straight RGB to bytes; recover the Canvas bitmap's
    // premultiplied byte before independently decoding its straight colour.
    const canvasLinear = (rgb, alpha) => alpha ? decode(Math.round(rgb * alpha / 255) / alpha) : 0;
    const blend = new MediaBlendPipeline(device);
    blend.setWorkingRange('hdr');
    const canvasPool = new CanvasPool(64, 64);
    const texturePool = new GpuTexturePool(device);
    const lottieProvider = new LottieExportProvider();
    const gpuTextTextureCache = new Map();
    const subCompRenderData = new Map();
    const rctx = { fps: 30, canvasSettings: { width: 64, height: 64, fps: 30 }, renderMode: 'export',
      canvasPool, textMeasureCache: new TextMeasurementCache(), renderItem,
      videoExtractors: new Map(), videoElements: new Map(), useMediabunny: new Set(),
      mediabunnyDisabledItems: new Set(), mediabunnyFailureCountByItem: new Map(),
      imageElements: new Map(), gifFramesMap: new Map(), keyframesMap: new Map(), adjustmentLayers: [],
      subCompRenderData, lottieProvider, gpuTextTextureCache, gpuPipeline: effects,
      gpuMediaPipeline: media, gpuMediaBlendPipeline: blend, gpuScratchTexturePool: texturePool,
      // Exercise the production Canvas text ingress when its optional glyph atlas is unavailable.
      gpuTextPipeline: null };
    const transform = { x: 0, y: 0, width: 64, height: 64, rotation: 0, opacity: 1, cornerRadius: 0 };
    const grade = []; // Effect operators are gated separately by linear-hdr-subtree.browser.mjs.
    const text = { id: 'text', type: 'text', trackId: 'graphics', from: 0, durationInFrames: 60,
      text: 'H', color: '#e64000', fontSize: 32, fontFamily: 'Arial', textAlign: 'left',
      verticalAlign: 'top', transform: { ...transform, height: 80 }, effects: grade };
    const lottie = { id: 'lottie', type: 'lottie', trackId: 'graphics', from: 0, durationInFrames: 60,
      src: 'synthetic.json', totalFrames: 60, frameRate: 30, loop: true, transform, effects: grade };
    // Owned synthetic vector: colored half-alpha rectangle with a diagonal edge.
    const animation = { v: '5.12.2', fr: 30, ip: 0, op: 60, w: 64, h: 64, nm: 'Owned HDR ingress fixture', ddd: 0,
      assets: [], layers: [{ ddd: 0, ind: 1, ty: 4, nm: 'Plate', sr: 1, ip: 0, op: 60, st: 0, bm: 0,
        ks: { o: { a: 0, k: 50 }, r: { a: 1, k: [{ t: 0, s: [0], e: [22], o: { x: [0.33], y: [0.33] }, i: { x: [0.67], y: [0.67] } }, { t: 20, s: [22] }] }, p: { a: 0, k: [32, 32, 0] },
          a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
        shapes: [{ ty: 'rc', d: 1, s: { a: 0, k: [48, 48] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
          { ty: 'fl', c: { a: 0, k: [230 / 255, 64 / 255, 0, 1] }, o: { a: 0, k: 100 }, r: 1 }] }] };
    const half = (bits) => {
      const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
      return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
    };
    const read = async (texture) => {
      const buffer = device.createBuffer({ size: texture.height * Math.ceil(texture.width * 8 / 256) * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: Math.ceil(texture.width * 8 / 256) * 256 }, [texture.width, texture.height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const packed = new Uint16Array(buffer.getMappedRange()), values = [];
        const stride = Math.ceil(texture.width * 8 / 256) * 128;
        for (let y = 0; y < texture.height; y++)
          for (let x = 0; x < texture.width * 4; x++) values.push(half(packed[y * stride + x]));
        return values;
      } finally { buffer.destroy(); }
    };
    const compose = (child, opacity, id, size = 64) => {
      subCompRenderData.set(id, { fps: 30, durationInFrames: 60, keyframesMap: new Map(), adjustmentLayers: [],
        sortedTracks: [{ order: 0, visible: true, items: [child] }] });
      return { id, type: 'composition', compositionId: id, compositionWidth: size, compositionHeight: size,
        trackId: 'graphics', from: 0, durationInFrames: 60, transform: { ...transform, width: size, height: size, opacity } };
    };
    const cases = [];
    try {
      await lottieProvider.preload(lottie.id, lottie.src, 64, 64, JSON.stringify(animation));
      for (const item of [text, lottie]) {
        const localTransform = item.type === 'text' ? expandTextTransformToFitContent(item, item.transform) : transform;
        const source = item.type === 'lottie' ? lottieProvider.renderFrame(item.id, 10) : new OffscreenCanvas(Math.ceil(localTransform.width), Math.ceil(localTransform.height));
        if (!source) throw new Error('Synthetic Lottie did not load through production provider');
        if (item.type === 'text') renderTextItem(source.getContext('2d'), item,
          { x: 0, y: 0, width: source.width, height: source.height }, { ...rctx, canvasSettings: { ...rctx.canvasSettings, width: source.width, height: source.height } });
        const pixels = Array.from(source.getContext('2d').getImageData(0, 0, source.width, source.height).data);
        // Independent alpha-weighted bilinear sampling of the SDR raster into
        // its authored destination. Hidden RGB cannot contaminate a visible edge.
        const sample = (x, y) => {
          const sx = x - (64 - source.width) / 2, sy = y - (64 - source.height) / 2;
          const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
          const sum = [0, 0, 0, 0];
          for (const [dx, dy, weight] of [[0, 0, (1-fx)*(1-fy)], [1, 0, fx*(1-fy)], [0, 1, (1-fx)*fy], [1, 1, fx*fy]]) {
            const px = Math.max(0, Math.min(source.width - 1, ix + dx)), py = Math.max(0, Math.min(source.height - 1, iy + dy));
            const index = (py * source.width + px) * 4, alpha = pixels[index + 3] / 255 * weight;
            sum[3] += alpha;
            for (let c = 0; c < 3; c++) sum[c] += canvasLinear(pixels[index + c], pixels[index + 3]) * alpha;
          }
          return [...sum.slice(0, 3).map((v) => sum[3] > 0 ? v / sum[3] : 0), sum[3]];
        };
        for (const nested of [false, true]) {
          const target = nested ? compose(compose(item, 0.6, item.id + '-inner'), 0.7, item.id + '-outer') : item;
          for (let attempt = 0; attempt < 3; attempt++) {
            const output = texturePool.acquire(64, 64, 'rgba16float');
            const canvases = [];
            let actual;
            try {
              if (!await renderItemToFloatTexture(target, 10, 0, rctx, texturePool, output, canvases)) {
                throw new Error('Production float graphics route declined');
              }
              actual = await read(output);
            } finally {
              for (const canvas of canvases) canvasPool.release(canvas);
              texturePool.release(output);
            }
            const opacity = nested ? 0.42 : 1;
            let maxError = 0, comparisons = 0, linearDifferences = 0, alphaEdges = 0, worst;
            for (let i = 0; i < actual.length; i += 4) {
              const input = sample(i / 4 % 64, Math.floor(i / 256));
              const alpha = input[3] * opacity;
              maxError = Math.max(maxError, Math.abs(actual[i + 3] - alpha));
              comparisons++;
              if (alpha <= 0.001) continue;
              if (input[3] > 0 && input[3] < 1) alphaEdges++;
              // Independent CPU reference: decode each authored pixel before alpha-weighted filtering.
              for (let c = 0; c < 3; c++) {
                const want = input[c];
                const error = Math.abs(actual[i + c] - want);
                if (error > maxError) worst = { x: i / 4 % 64, y: Math.floor(i / 256), c, want, actual: actual.slice(i, i + 4), source: input };
                maxError = Math.max(maxError, error);
                linearDifferences += want > .01 && want < .8 ? 1 : 0;
                comparisons++;
              }
            }
            cases.push({ kind: item.type, nested, attempt, maxError, comparisons, linearDifferences, alphaEdges,
              canvasInUse: canvasPool.getStats().inUse, textureInUse: texturePool.getStats().inUse,
              textCacheEntries: gpuTextTextureCache.size, worst, textCacheSize: Array.from(gpuTextTextureCache.values(), ({width, height}) => [width, height]) });
          }
        }
      }
      // A provider canvas is borrowed and mutable. Two simultaneous instances
      // must keep their own frame even when the second call changes that canvas.
      const frames = [5, 15];
      const references = frames.map((frame) => Array.from(lottieProvider.renderFrame(lottie.id, frame)
        .getContext('2d').getImageData(0, 0, 64, 64).data));
      const outputs = frames.map(() => texturePool.acquire(64, 64, 'rgba16float'));
      const borrowedCanvases = frames.map(() => []);
      let snapshots;
      try {
        const rendered = await Promise.all(frames.map((frame, i) =>
          renderItemToFloatTexture(lottie, frame, 0, rctx, texturePool, outputs[i], borrowedCanvases[i])));
        if (!rendered.every(Boolean)) throw new Error('Concurrent Lottie route declined');
        snapshots = await Promise.all(outputs.map(read));
      } finally {
        for (const canvases of borrowedCanvases) for (const canvas of canvases) canvasPool.release(canvas);
        for (const output of outputs) texturePool.release(output);
      }
      const concurrent = { comparisons: 8192, maxAlphaError: 0, sourceDifference: 0,
        canvasInUse: canvasPool.getStats().inUse, textureInUse: texturePool.getStats().inUse };
      for (let i = 3; i < references[0].length; i += 4) {
        concurrent.sourceDifference += Math.abs(references[0][i] - references[1][i]) / 255;
        for (let frame = 0; frame < frames.length; frame++) {
          concurrent.maxAlphaError = Math.max(concurrent.maxAlphaError,
            Math.abs(snapshots[frame][i] - references[frame][i] / 255));
        }
      }
      const failures = [];
      for (const item of [text, lottie]) for (const failure of ['declined', 'thrown']) {
        let allocated = 0, destroyed = 0, rejected = false;
        const cache = new Map();
        const pipeline = { getWorkingRange: () => 'hdr', getDevice: () => ({ createTexture(descriptor) {
          allocated++;
          const texture = device.createTexture(descriptor), destroy = texture.destroy.bind(texture);
          texture.destroy = () => { destroyed++; destroy(); };
          return texture;
        } }), applyEffectsToTexture() { if (failure === 'thrown') throw new Error('Owned upload failure'); return false; } };
        let prepared;
        try {
          prepared = await prepareGpuMediaParticipant({ item, transform: item.transform, effects: grade,
            renderSpan: { from: 0, durationInFrames: 60 } }, 10,
          { ...rctx, gpuPipeline: pipeline, gpuTextTextureCache: cache });
        } catch (error) {
          if (error.message !== 'Owned upload failure') throw error;
          rejected = true;
        }
        if (prepared) throw new Error('Failed graphics ingress produced a participant');
        failures.push({ kind: item.type, failure, rejected, allocated, destroyed, cacheEntries: cache.size,
          canvasInUse: canvasPool.getStats().inUse, textureInUse: texturePool.getStats().inUse });
      }
      const layouts = [], layoutCache = new Map();
      const layoutContext = { ...rctx, gpuTextTextureCache: layoutCache,
        canvasSettings: { ...rctx.canvasSettings, width: 256, height: 256 } };
      const layoutSources = [];
      try {
        for (const spanLayout of ['inline', 'stack']) {
          const item = { ...text, id: 'layout-cache', effects: [], spanLayout,
            transform: { ...transform, width: 256, height: 256 }, text: 'ABCD',
            textSpans: [{ text: 'AB', color: '#e64000' }, { text: 'CD', color: '#0080e6' }] };
          const fresh = new OffscreenCanvas(256, 256);
          renderTextItem(fresh.getContext('2d'), item, { x: 0, y: 0, width: 256, height: 256 }, layoutContext);
          const pixels = Array.from(fresh.getContext('2d').getImageData(0, 0, 256, 256).data);
          layoutSources.push(pixels);
          for (const nested of [false, true]) {
            const target = nested ? compose(item, 1, 'layout-' + spanLayout, 256) : item;
            const output = texturePool.acquire(256, 256, 'rgba16float'), canvases = [];
            let actual;
            try {
              if (!await renderItemToFloatTexture(target, 10, 0, layoutContext, texturePool, output, canvases))
                throw new Error('Layout float route declined');
              actual = await read(output);
            } finally {
              for (const canvas of canvases) canvasPool.release(canvas);
              texturePool.release(output);
            }
            let maxError = 0, comparisons = 0, worst;
            for (let i = 0; i < actual.length; i += 4) {
              maxError = Math.max(maxError, Math.abs(actual[i + 3] - pixels[i + 3] / 255)); comparisons++;
              if (pixels[i + 3] <= 1) continue;
              // Keep the existing strict straight-RGB and alpha tolerances.
              for (let c = 0; c < 3; c++) { const error=Math.abs(actual[i+c]-canvasLinear(pixels[i+c],pixels[i+3]));if(error>maxError)worst={i,c,source:pixels.slice(i,i+4),actual:actual.slice(i,i+4)};maxError=Math.max(maxError,error);comparisons++; }
            }
            layouts.push({ spanLayout, nested, maxError, comparisons, worst, cacheEntries: layoutCache.size,
              canvasInUse: canvasPool.getStats().inUse, textureInUse: texturePool.getStats().inUse });
          }
        }
      } finally { for (const entry of layoutCache.values()) entry.texture.destroy(); }
      const layoutSourceDifference = layoutSources[0].reduce((sum, value, i) => sum + Math.abs(value - layoutSources[1][i]), 0);
      const cacheOwnership = [];
      const validateTexture = async (texture) => {
        const output = texturePool.acquire(2, 2, 'rgba16float');
        device.pushErrorScope('validation');
        try {
          const rendered = media.renderTextureToTexture(texture, output, {
            sourceWidth: texture.width, sourceHeight: texture.height, outputWidth: 2, outputHeight: 2,
            destRect: { x: 0, y: 0, width: 2, height: 2 }, clear: true, blend: false,
          });
          const error = await device.popErrorScope();
          return rendered && !error;
        } finally { texturePool.release(output); }
      };
      for (const scenario of ['oversize', 'simultaneous']) {
        const cache = new Map(), tracked = [];
        const pipeline = { getWorkingRange: () => 'hdr', getDevice: () => ({ createTexture(descriptor) {
          const texture = device.createTexture(descriptor), destroy = texture.destroy.bind(texture);
          const row = { texture, destroyed: 0 }; tracked.push(row);
          texture.destroy = () => { row.destroyed++; destroy(); };
          return texture;
        } }), applyEffectsToTexture: (...args) => effects.applyEffectsToTexture(...args) };
        const width = scenario === 'oversize' ? 4096 : 3840;
        const items = (scenario === 'oversize' ? ['#e64000'] : ['#e64000', '#0080e6']).map((color, i) =>
          ({ ...text, id: scenario + i, color, transform: { ...transform, width, height: 2160 } }));
        const requests = scenario === 'simultaneous' ? [...items, items[0]] : items;
        const participants = await Promise.all(requests.map((item) => prepareGpuMediaParticipant({ item,
          transform: item.transform, effects: [], renderSpan: { from: 0, durationInFrames: 60 } }, 10,
        { ...rctx, gpuPipeline: pipeline, gpuTextTextureCache: cache })));
        if (participants.some((p) => !p)) throw new Error('Large text source declined');
        const beforeClose = tracked.map((row) => row.destroyed);
        const validBeforeClose = [];
        for (const p of participants) validBeforeClose.push(await validateTexture(p.media.texture));
        const closePresent = participants.map((p) => typeof p.media.close === 'function');
        const cacheBeforeClose = cache.size;
        participants[0].media.close?.();
        const afterFirstClose = tracked.map((row) => row.destroyed);
        participants[1]?.media.close?.();
        const afterSecondClose = tracked.map((row) => row.destroyed);
        for (const p of participants.slice(2)) p.media.close?.();
        const finalRetainedBytes = Array.from(cache.values()).reduce((sum, entry) => sum + entry.bytes, 0);
        for (const entry of cache.values()) entry.texture.destroy(); cache.clear();
        cacheOwnership.push({ scenario, beforeClose, validBeforeClose, closePresent, cacheBeforeClose,
          afterFirstClose, afterSecondClose, retainedBytes: finalRetainedBytes, afterCleanup: tracked.map((row) => row.destroyed),
          canvasInUse: canvasPool.getStats().inUse, textureInUse: texturePool.getStats().inUse });
      }
      const domainCache=new Map(),domainTextures=[],domainRows=[];
      try {
        for(const range of ['hdr','sdr','hdr']) {
          effects.setWorkingRange(range);
          const participant=await prepareGpuMediaParticipant({item:text,transform:text.transform,effects:[],renderSpan:{from:0,durationInFrames:60}},10,{...rctx,gpuTextTextureCache:domainCache});
          if(!participant)throw new Error('Text domain-cache route declined');
          domainTextures.push(participant.media.texture);
          domainRows.push({range,format:participant.media.texture.format,keys:[...domainCache.keys()],entries:domainCache.size});
          participant.media.close?.();
        }
        if(domainTextures[0]===domainTextures[1]||domainTextures[0]!==domainTextures[2])throw new Error('Text cache reused another working domain');
      }finally{for(const entry of domainCache.values())entry.texture.destroy();effects.setWorkingRange('hdr');}
      return { cases, concurrent, failures, layouts, layoutSourceDifference, cacheOwnership, domainRows };
    } finally {
      for (const entry of gpuTextTextureCache.values()) entry.texture.destroy();
      lottieProvider.destroy(); canvasPool.dispose(); texturePool.destroy();
      media.destroy(); blend.destroy(); effects.destroy();
    }
  });
  if (process.env.GRAPHICS_FLOAT_REPORT) await writeFile(process.env.GRAPHICS_FLOAT_REPORT, JSON.stringify(result));
  assert.equal(result.cases.length, 12);
  for (const row of result.cases) {
    assert.ok(row.maxError < 0.02, `${row.kind} nested=${row.nested} clipped/changed working values: ${row.maxError}`);
    assert.ok(row.linearDifferences > 0 && row.alphaEdges > 0, 'fixture must distinguish encoded RGB and alpha-edge damage');
    assert.equal(row.canvasInUse, 0); assert.equal(row.textureInUse, 0);
    assert.ok(row.textCacheEntries <= 1, 'static raster ingress cache must not grow per frame');
  }
  assert.ok(result.concurrent.sourceDifference > 1, 'concurrent frames must exercise different provider pixels');
  assert.ok(result.concurrent.maxAlphaError < 0.002, `Lottie provider canvas changed before upload: ${result.concurrent.maxAlphaError}`);
  assert.equal(result.concurrent.canvasInUse, 0); assert.equal(result.concurrent.textureInUse, 0);
  assert.equal(result.failures.length, 4);
  for (const row of result.failures) {
    assert.equal(row.rejected, row.failure === 'thrown');
    assert.equal(row.allocated, 1); assert.equal(row.destroyed, 1);
    assert.equal(row.cacheEntries, 0); assert.equal(row.canvasInUse, 0); assert.equal(row.textureInUse, 0);
  }
  assert.ok(result.layoutSourceDifference > 1000, 'inline and stacked references must differ');
  assert.equal(result.layouts.length, 4);
  for (const row of result.layouts) {
    assert.ok(row.maxError < 0.003, `${row.spanLayout} nested=${row.nested} reused another layout: ${row.maxError}`);
    assert.equal(row.canvasInUse, 0); assert.equal(row.textureInUse, 0);
    assert.equal(row.cacheEntries, row.spanLayout === 'inline' ? 1 : 2);
  }
  assert.deepEqual(result.domainRows.map(r=>[r.range,r.format,r.entries]),[['hdr','rgba16float',1],['sdr','rgba8unorm',2],['hdr','rgba16float',2]]);
  assert(result.domainRows[0].keys[0].startsWith('linear-display-bt709-v1:'));
  for (const row of result.cacheOwnership) {
    assert.ok(row.closePresent.every(Boolean), `${row.scenario} needs participant close`);
    assert.ok(row.validBeforeClose.every(Boolean), `${row.scenario} returned a destroyed texture`);
    assert.ok(row.beforeClose.every((v) => v === 0), `${row.scenario} evicted active participant`);
    assert.equal(row.cacheBeforeClose, row.scenario === 'oversize' ? 0 : 2);
    assert.deepEqual(row.afterFirstClose, row.scenario === 'oversize' ? [1] : [0, 0]);
    assert.deepEqual(row.afterSecondClose, row.scenario === 'oversize' ? [1] : [0, 1]);
    assert.ok(row.retainedBytes <= 64 * 1024 * 1024);
    assert.ok(row.afterCleanup.every((v) => v === 1));
    assert.equal(row.canvasInUse, 0); assert.equal(row.textureInUse, 0);
  }
  console.log(JSON.stringify({ check: 'Production text/Lottie linear ingress and nested source-over', cases: result.cases.length, failedIngressOwnership: result.failures.length, concurrentFrameComparisons: result.concurrent.comparisons, layoutCases: result.layouts.length, layoutComparisons: result.layouts.reduce((sum, row) => sum + row.comparisons, 0), cacheOwnershipCases: result.cacheOwnership.length,
    comparisons: result.cases.reduce((sum, row) => sum + row.comparisons, 0), maxError: Math.max(...result.cases.map((row) => row.maxError)) }));
} finally { await browser.close(); }
