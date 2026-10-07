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
  await page.route(origin + '/nested-probe', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Nested float regression</title>' }),
  );
  await page.goto(origin + '/nested-probe');
  const result = await page.evaluate(async () => {
    const { HdrRenderUnavailableError } = await import('/src/shared/graphics/color/managed-color.ts');
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { MediaRenderPipeline } = await import('/src/infrastructure/gpu-media/media-render-pipeline.ts');
    const { MediaBlendPipeline } = await import('/src/infrastructure/gpu-media/media-blend-pipeline.ts');
    const { ShapeRenderPipeline } = await import('/src/infrastructure/gpu-shapes/shape-render-pipeline.ts');
    const { MaskCombinePipeline } = await import('/src/infrastructure/gpu-masks/mask-combine-pipeline.ts');
    const { TransitionPipeline } = await import('/src/infrastructure/gpu-transitions/transition-pipeline.ts');
    const { GpuTexturePool } = await import('/src/infrastructure/gpu-compositor/gpu-texture-pool.ts');
    const { renderTransitionToGpuTexture } = await import('/src/features/export/utils/canvas-item-renderer/transition.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('WebGPU unavailable; nested float regression cannot run');
    const resources = [];
    const buffers = [];
    try {
      device.pushErrorScope('validation');
      const effects = await EffectsPipeline.create();
      const transition = TransitionPipeline.create(device);
      if (!effects || !transition) throw new Error('GPU pipeline initialization failed');
      const media = new MediaRenderPipeline(device);
      const blend = new MediaBlendPipeline(device);
      const shapePipeline = new ShapeRenderPipeline(device);
      const masks = new MaskCombinePipeline(device);
      const pool = new GpuTexturePool(device);
      resources.push(effects, transition, media, blend, shapePipeline, masks, pool);
      // All positive operator witnesses retain pinned SDR behavior. Admitted
      // linear HDR transport is independently measured by linear-hdr-subtree.
      const projectRange = (range) => {
        for (const pipeline of [effects, transition, blend]) pipeline.setWorkingRange(range);
      };
      projectRange('sdr');
      const readbacks = {};
      const read = (name, texture) => {
        if (texture.format !== 'rgba16float') throw new Error(`${name} lost float allocation`);
        const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        buffers.push(buffer);
        readbacks[name] = buffer;
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture, origin: [4, 4] }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
      };
      const identity = [{ id: 'identity', enabled: true, effect: {
        type: 'gpu-effect', gpuEffectType: 'gpu-vignette', params: { amount: 0 },
      } }];
      let sequence = 0;
      const shape = (fillColor, extra = {}) => ({
        id: `shape-${sequence++}`, type: 'shape', trackId: 'track', from: 0, durationInFrames: 60,
        shapeType: 'rectangle', fillColor, strokeEnabled: false,
        // Overscan keeps the readback away from antialiased shape edges.
        transform: { x: 0, y: 0, width: 16, height: 16, rotation: 0, opacity: 1 }, ...extra,
      });
      const subCompRenderData = new Map();
      const composition = (children, extra = {}) => {
        const id = `comp-${sequence++}`;
        subCompRenderData.set(id, {
          fps: 30, durationInFrames: 60, keyframesMap: new Map(), adjustmentLayers: [],
          sortedTracks: children.map((item, index) => ({
            order: children.length - index, visible: true, items: [item],
          })),
        });
        return {
          id, type: 'composition', compositionId: id, compositionWidth: 8, compositionHeight: 8,
          trackId: 'track', from: 0, durationInFrames: 60,
          transform: { x: 0, y: 0, width: 8, height: 8, rotation: 0, opacity: 1 }, ...extra,
        };
      };
      const rctx = {
        fps: 30, canvasSettings: { width: 8, height: 8, fps: 30 }, renderMode: 'export',
        // Fail instead of letting Canvas2D hide a rejected direct GPU path.
        canvasPool: { acquire() { throw new Error('Unexpected canvas fallback'); }, release() {} },
        videoExtractors: new Map(), videoElements: new Map(), useMediabunny: new Set(),
        mediabunnyDisabledItems: new Set(), mediabunnyFailureCountByItem: new Map(),
        imageElements: new Map(), gifFramesMap: new Map(), keyframesMap: new Map(),
        adjustmentLayers: [], subCompRenderData, gpuPipeline: effects,
        gpuMediaPipeline: media, gpuMediaBlendPipeline: blend, gpuShapePipeline: shapePipeline,
        gpuTransitionPipeline: transition, gpuMaskCombinePipeline: masks, gpuScratchTexturePool: pool,
      };
      const render = async (name, leftClip, rightClip, progress = 0) => {
        const output = pool.acquire(8, 8, 'rgba16float');
        const active = {
          leftClip, rightClip, progress, transitionStart: 0, transitionEnd: 20,
          durationInFrames: 20, leftPortion: 10, rightPortion: 10, cutPoint: 10,
          transition: { id: `transition-${sequence++}`, type: 'crossfade', presentation: 'dissolve',
            timing: 'linear', leftClipId: leftClip.id, rightClipId: rightClip.id,
            trackId: 'track', durationInFrames: 20 },
        };
        if (!await renderTransitionToGpuTexture(output, active, 10, rctx, 0, pool)) {
          throw new Error(`Nested production transition rejected ${name}`);
        }
        read(name, output);
        return output;
      };
      const transparentBlue = composition([shape('rgba(0, 0, 255, 0)')]);
      const add = composition([
        shape('rgb(70%, 70%, 70%)'),
        shape('rgb(60%, 60%, 60%)', { blendMode: 'linear-dodge' }),
      ]);
      // Two levels of real nested composition, plus participant effects, before transition.
      const extended = await render('extended', composition([add], { effects: identity }), transparentBlue);
      await render('recoveredNested', composition([
        add, shape('rgb(30%, 30%, 30%)', { blendMode: 'subtract' }),
      ]), transparentBlue);
      const subtract = await render('subtract', composition([shape('rgb(30%, 30%, 30%)')]), transparentBlue);
      const recovered = pool.acquire(8, 8, 'rgba16float');
      if (!blend.blend(extended, subtract, recovered, 'subtract')) throw new Error('Recovery blend rejected');
      read('recoveredAfterTransition', recovered);

      const half = await render('half', composition([shape('rgba(255, 0, 0, 0.5)')]), transparentBlue);
      const white = await render('white', composition([shape('#ffffff')]), transparentBlue);
      const overWhite = pool.acquire(8, 8, 'rgba16float');
      if (!blend.blend(white, half, overWhite, 'normal')) throw new Error('Source-over rejected');
      read('halfOverWhite', overWhite);
      await render('laterSourceOver', composition([
        shape('rgba(255, 0, 0, 0.5)'), shape('rgba(0, 255, 0, 0.5)'),
      ]), transparentBlue);
      await render('crossfade', composition([shape('#ff0000')]), transparentBlue, 0.5);

      // The inner composition's hard viewport edge creates exact adjacent texels:
      // transparent red on the left and opaque foreground on the right. Moving
      // its parent by half a pixel must not filter hidden red into the foreground.
      for (const [name, color] of [['fractionalEdge', '#00ff00'], ['fractionalSdrExtremeEdge', 'rgb(200%, -50%, 25%)']]) {
        const rightHalf = composition([shape(color)], {
          transform: { x: 2, y: 0, width: 4, height: 8, rotation: 0, opacity: 1 },
        });
        const edge = composition([shape('rgba(255, 0, 0, 0)'), rightHalf], {
          transform: { x: 0.5, y: 0, width: 8, height: 8, rotation: 0, opacity: 1 },
        });
        const shifted = await render(name, edge, transparentBlue);
        const composed = pool.acquire(8, 8, 'rgba16float');
        if (!blend.blend(white, shifted, composed, 'normal')) throw new Error('Edge source-over rejected');
        read(name + 'OverWhite', composed);
      }

      const hdrMasked = composition([
        shape('rgba(200%, -50%, 25%, 0.5)', { effects: identity }),
        shape('#ffffff', { isMask: true, maskType: 'alpha' }),
        shape('#ffffff', { isMask: true, maskType: 'alpha' }),
      ], { effects: identity });
      await render('identityEffectsMasks', hdrMasked, transparentBlue);
      // Real external-image upload and format switches after the float texture path.
      const canvas = new OffscreenCanvas(8, 8);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.fillRect(0, 0, 8, 8);
      const imageItem = { ...shape('#fff'), type: 'image', src: '', effects: identity };
      rctx.imageElements.set(imageItem.id, { source: canvas, width: 8, height: 8 });
      await render('mediaUpload', composition([imageItem]), transparentBlue);
      const legacy = pool.acquire(8, 8, 'rgba8unorm');
      const rect = { x: 0, y: 0, width: 8, height: 8 };
      if (!media.renderTextureToTexture(half, legacy, {
        sourceWidth: 8, sourceHeight: 8, outputWidth: 8, outputHeight: 8, destRect: rect,
      })) throw new Error('Legacy media attachment rejected');
      if (!shapePipeline.renderShapeToTexture(legacy, {
        outputWidth: 8, outputHeight: 8, transformRect: rect, shapeType: 'rectangle', fillColor: [1, 1, 1, 1],
      })) throw new Error('Legacy shape attachment rejected');
      if (!blend.blend(white, half, legacy, 'normal')) throw new Error('Legacy blend attachment rejected');
      // rgba8 inputs retain their existing sampling, including hidden RGB.
      const legacyEdge = pool.acquire(8, 8, 'rgba8unorm');
      device.queue.writeTexture({ texture: legacyEdge }, new Uint8Array(
        Array.from({ length: 64 }, (_, pixel) => pixel % 8 < 4 ? [255, 0, 0, 0] : [0, 255, 0, 255]).flat(),
      ), { bytesPerRow: 32 }, [8, 8]);
      const legacySample = pool.acquire(8, 8, 'rgba16float');
      if (!media.renderTextureToTexture(legacyEdge, legacySample, {
        sourceWidth: 8, sourceHeight: 8, outputWidth: 8, outputHeight: 8,
        destRect: { x: 0.5, y: 0, width: 8, height: 8 },
      })) throw new Error('Legacy edge sampling rejected');
      read('legacyEdgeSampling', legacySample);
      // An SDR project keeps Freecut's display-bounded linear dodge and subtract.
      projectRange('sdr');
      await render('extendedSdr', composition([add], { effects: identity }), transparentBlue);
      await render('recoveredNestedSdr', composition([
        add, shape('rgb(30%, 30%, 30%)', { blendMode: 'subtract' }),
      ]), transparentBlue);
      projectRange('hdr');
      let hdrRefusal;
      try {
        await render('historicalHdrGraph', composition([add], { effects: identity }), transparentBlue);
        throw new Error('Nested HDR operator graph unexpectedly rendered');
      } catch (error) {
        if (!(error instanceof HdrRenderUnavailableError)) throw error;
        hdrRefusal = { errorType: error.name, reason: error.message };
      }
      await device.queue.onSubmittedWorkDone();
      const error = await device.popErrorScope();
      if (error) throw new Error(`Nested GPU validation failed: ${error.message}`);
      await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
      return { ...Object.fromEntries(Object.entries(readbacks).map(([name, buffer]) =>
        [name, Array.from(new Float16Array(buffer.getMappedRange(), 0, 4))],
      )), hdrRefusal };
    } finally {
      for (const resource of resources.reverse()) resource.destroy();
      for (const buffer of buffers) buffer.destroy();
      device.destroy();
    }
  });
  const expected = {
    extended: [1, 1, 1, 1], recoveredNested: [0.7, 0.7, 0.7, 1],
    subtract: [0.3, 0.3, 0.3, 1], recoveredAfterTransition: [0.7, 0.7, 0.7, 1],
    half: [1, 0, 0, 0.5], white: [1, 1, 1, 1], halfOverWhite: [1, 0.5, 0.5, 1],
    laterSourceOver: [1 / 3, 2 / 3, 0, 0.75], crossfade: [1, 0, 0, 0.5],
    identityEffectsMasks: [2, -0.5, 0.25, 0.5], mediaUpload: [1, 0, 0, 128 / 255],
    fractionalEdge: [0, 1, 0, 0.5], fractionalEdgeOverWhite: [0.5, 1, 0.5, 1],
    fractionalSdrExtremeEdge: [2, -0.5, 0.25, 0.5], fractionalSdrExtremeEdgeOverWhite: [1, 0.5, 0.625, 1],
    legacyEdgeSampling: [0.5, 0.5, 0, 0.5],
    extendedSdr: [1, 1, 1, 1], recoveredNestedSdr: [0.7, 0.7, 0.7, 1],
  };
  for (const [name, channels] of Object.entries(expected)) {
    channels.forEach((value, channel) => assert.ok(
      Number.isFinite(result[name][channel]) && Math.abs(result[name][channel] - value) <= 0.003,
      `${name} channel ${channel}: ${result[name][channel]} != ${value}`,
    ));
  }
  assert.equal(result.hdrRefusal.errorType, 'HdrRenderUnavailableError');
  console.log(JSON.stringify({ check: 'SDR nested participants, transition, effects, masks and alpha; typed HDR operator refusal', ...result }));
} finally {
  await browser.close();
}
