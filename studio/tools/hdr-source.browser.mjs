// FL-97: an HDR project reads real HDR pixels for library clips. The Studio HDR
// intermediate (10-bit AV1, BT.2020, PQ or HLG, made with the server's encoder
// settings) is decoded with WebCodecs and uploaded straight into working values:
// the GPU upload equals the managed-colour reference on the decoded planes, and a
// clip's PQ/HLG signal survives the whole float route to delivery, highlights
// included. Without the intermediate the SDR route cannot carry them.
import assert from 'node:assert/strict';
import { testedSource } from './lib/working-domain-report.mjs';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';
import { validateMaskedRasterDiagnostic } from './hdr-source-validation.mjs';

const source = await testedSource(new URL(import.meta.url));
const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const SIZE = 64;
const FPS = 30;
// Three solid ten-frame segments per clip, as R'G'B' signal.
const SEGMENTS = {
  pq: [[0.508078, 0.508078, 0.508078], [0.751827, 0.751827, 0.751827], [0.7, 0.45, 0.25]],
  hlg: [[0.5, 0.5, 0.5], [0.9, 0.9, 0.9], [0.8, 0.55, 0.3]],
};
const TRC = { pq: ['smpte2084', 16], hlg: ['arib-std-b67', 18] };

const dir = mkdtempSync(join(tmpdir(), 'hdr-source-'));
const fixtures = {};
try {
  for (const [transfer, segments] of Object.entries(SEGMENTS)) {
    const frame = (rgb) => {
      const buf = Buffer.alloc(SIZE * SIZE * 6);
      for (let i = 0; i < SIZE * SIZE; i++) {
        rgb.forEach((v, c) => buf.writeUInt16LE(Math.round(v * 65535), i * 6 + c * 2));
      }
      return buf;
    };
    const raw = Buffer.concat(segments.flatMap((rgb) => Array.from({ length: 10 }, () => frame(rgb))));
    const [trc, code] = TRC[transfer];
    const out = join(dir, `${transfer}.mp4`);
    // The server's Studio HDR intermediate settings (server/src/utils/studio-hdr-proxy.ts).
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${SIZE}x${SIZE}`, '-r', String(FPS),
      '-i', '-', '-vf',
      `scale=out_range=tv:out_color_matrix=bt2020,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc:range=tv`,
      '-c:v', 'libsvtav1', '-preset', '10', '-crf', '23',
      '-svtav1-params', `color-primaries=9:transfer-characteristics=${code}:matrix-coefficients=9:color-range=0`,
      '-g', String(FPS), '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', trc,
      '-colorspace', 'bt2020nc', '-color_range', 'tv', '-movflags', '+faststart', '-f', 'mp4', '-y', out,
    ], { input: raw, env: { ...process.env, SVT_LOG: '1' } });
    fixtures[transfer] = readFileSync(out);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  for (const [transfer, body] of Object.entries(fixtures)) {
    await page.route(`${origin}/hdr-fixture/${transfer}.mp4`, (route) =>
      route.fulfill({ contentType: 'video/mp4', body }),
    );
  }
  await page.route(origin + '/hdr-source', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<title>HDR source</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  await page.goto(origin + '/hdr-source');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  const result = await page.evaluate(async ({ SIZE, FPS }) => {
    const color = await import('/src/shared/graphics/color/managed-color.ts');
    const { VideoFrameExtractor } = await import('/src/features/export/utils/canvas-video-extractor.ts');
    const { HdrFrameUploader } = await import('/src/infrastructure/gpu-color/hdr-frame-upload.ts');
    const { registerHdrSourceUrl } = await import('/src/features/export/utils/hdr-video-sources.ts');
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('WebGPU unavailable; HDR source regression cannot run');
    // Reconstructed HEIC/gain-map pixels enter the same float compositor.
    // Alpha and source reference white must scale radiance, never HDR code values.
    const linearRasters = [];
    for (const gamut of [0, 1, 2]) {
      for (const referenceWhite of [100, 203]) {
        const rgba = new Float32Array(SIZE * SIZE * 4);
        for (let i = 0; i < rgba.length; i += 4) rgba.set([0.8, 4, 1, 0.25], i);
        const canvas = new OffscreenCanvas(SIZE, SIZE);
        const item = { id: 'linear-photo', type: 'image', mediaId: 'linear-photo', trackId: 'linear-track',
          src: '', label: 'linear HDR', from: 0, durationInFrames: 30,
          sourceWidth: SIZE, sourceHeight: SIZE,
          transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } };
        const renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
          durationInFrames: 30, backgroundColor: '#000000', colorManagement: { workingRange: 'hdr' },
          tracks: [{ id: 'linear-track', name: 'Photo', height: 60, locked: false, visible: true,
            muted: false, solo: false, order: 0, items: [item] }] }, canvas, canvas.getContext('2d'),
          { mode: 'export', hdrRasters: { 'linear-photo': { width: SIZE, height: SIZE,
            transfer: 'linear', gamut, referenceWhite, rgba } } });
        try {
          const frame = await renderer.renderFrameSignal(0, 'pq');
          const at = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
          linearRasters.push({ gamut, referenceWhite, rgba: Array.from(frame.rgba.slice(at, at + 4)) });
        } finally { renderer.dispose(); rgba.fill(0); }
      }
    }
    const c = SIZE / 2;
    const out = {};
    const historicalHdrRefusals = [];
    const expectHdrOperatorRefusal = async (composition, options, frame, scenario) => {
      const canvas = new OffscreenCanvas(composition.width, composition.height);
      const renderer = await createCompositionRenderer(composition, canvas, canvas.getContext('2d'), { mode: 'export', ...options });
      try {
        await renderer.preload?.();
        await renderer.renderFrameSignal(frame, 'pq');
        throw new Error(`${scenario}: historical HDR operator unexpectedly rendered`);
      } catch (error) {
        if (!(error instanceof color.HdrRenderUnavailableError)) throw error;
        historicalHdrRefusals.push({ scenario, errorType: error.name, reason: error.message, emitted: 0 });
      } finally { renderer.dispose(); }
    };
    for (const transfer of ['pq', 'hlg']) {
      const url = `/hdr-fixture/${transfer}.mp4`;
      // 1. Upload of the decoded planes equals the CPU reference.
      const extractor = new VideoFrameExtractor(url, `probe-${transfer}`);
      if (!(await extractor.init())) throw new Error(`${transfer}: the intermediate did not open`);
      const uploader = new HdrFrameUploader(device);
      const texture = device.createTexture({ size: [SIZE, SIZE], format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
      const uploads = [];
      for (const segment of [0, 1, 2]) {
        const frame = await extractor.captureHdrFrame((segment * 10 + 5) / FPS);
        if (!frame || frame === 'unsupported') throw new Error(`${transfer}: decoder gave ${frame}`);
        const u16 = (plane, x, y) => {
          const { offset, stride } = frame.layout[plane];
          return frame.data[offset + y * stride + x * 2] | (frame.data[offset + y * stride + x * 2 + 1] << 8);
        };
        const chroma = (plane) => {
          const at = (c + 0.5) * 0.5 - 0.5;
          const x0 = Math.floor(at);
          const w = at - x0;
          const row = (y) => u16(plane, x0, y) * (1 - w) + u16(plane, x0 + 1, y) * w;
          return row(x0) * (1 - w) + row(x0 + 1) * w;
        };
        const want = color.signalToWorking(
          color.ycbcr2020ToSignal(u16(0, c, c), chroma(1), chroma(2)), frame.transfer);
        if (!uploader.upload(frame, texture)) throw new Error('upload refused');
        const buffer = device.createBuffer({ size: 256 * SIZE * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 512 }, [SIZE, SIZE]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const half = new Float16Array(buffer.getMappedRange());
        const got = Array.from(half.slice(c * 256 + c * 4, c * 256 + c * 4 + 3));
        buffer.destroy();
        uploads.push({ transfer: frame.transfer, format: frame.format, got, want });
      }
      extractor.dispose();
      uploader.destroy();
      texture.destroy();

      // 2. The clip's signal survives the float route to delivery.
      const item = { id: `clip-${transfer}`, type: 'video', trackId: 'track-0', mediaId: `media-${transfer}`,
        src: url, label: 'clip', from: 0, durationInFrames: 30, sourceStart: 0, sourceEnd: 30, sourceFps: FPS,
        sourceDuration: 30, speed: 1, sourceWidth: SIZE, sourceHeight: SIZE,
        transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } };
      const composition = { fps: FPS, width: SIZE, height: SIZE, durationInFrames: 30, backgroundColor: '#000000',
        colorManagement: { workingRange: 'hdr' },
        tracks: [{ id: 'track-0', name: 'V1', height: 60, locked: false, visible: true, muted: false, solo: false,
          order: 0, items: [item] }] };
      const deliver = async () => {
        const canvas = new OffscreenCanvas(SIZE, SIZE);
        const renderer = await createCompositionRenderer(composition, canvas, canvas.getContext('2d'), { mode: 'export' });
        try {
          await renderer.preload?.();
          const signals = [];
          for (const segment of [0, 1, 2]) {
            const { rgba, width } = await renderer.renderFrameSignal(segment * 10 + 5, transfer);
            signals.push(Array.from(rgba.slice((c * width + c) * 4, (c * width + c) * 4 + 3)));
          }
          return signals;
        } finally {
          renderer.dispose();
        }
      };
      registerHdrSourceUrl(item.mediaId, url);
      const hdr = await deliver();
      registerHdrSourceUrl(item.mediaId, null);
      const sdr = await deliver();
      out[transfer] = { uploads, hdr, sdr, sdrWhite: color.workingToSignal([1, 1, 1], transfer) };
    }

    // 3. Both real decoded transfers coexist with SDR graphics in one frame.
    // Read references from the decoded planes, not the lossy encoder's input.
    // Effect-free straight-alpha source-over blends decoded linear display RGB
    // with SDR reference-white graphics, before either explicit output policy.
    const width = SIZE * 3;
    const background = [0.2, 0.2, 0.2].map(color.srgbDecodeExtended);
    const sources = [
      { transfer: 'pq', x: -SIZE, opacity: 0.5, exposure: 1 },
      { transfer: 'hlg', x: 0, opacity: 0.75, exposure: -0.5 },
    ];
    const mixedTracks = sources.map(({ transfer, x, opacity, exposure }, order) => ({
      id: `mixed-track-${order}`, name: transfer, height: 60, locked: false,
      visible: true, muted: false, solo: false, order,
      items: [{ id: `mixed-${transfer}`, type: 'video', trackId: `mixed-track-${order}`,
        mediaId: `mixed-media-${transfer}`, src: `/hdr-fixture/${transfer}.mp4`, label: transfer,
        from: 0, durationInFrames: 30, sourceStart: 0, sourceEnd: 30, sourceFps: FPS,
        sourceDuration: 30, speed: 1, sourceWidth: SIZE, sourceHeight: SIZE,
        transform: { x, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity },
        effects: [{ id: `mixed-exposure-${transfer}`, enabled: true,
          effect: { type: 'gpu-effect', gpuEffectType: 'gpu-exposure',
            params: { exposure, offset: 0, gamma: 1 } } }] }],
    }));
    const sdrRgb = [0.25, 0.5, 0.75].map(color.srgbDecodeExtended);
    const sdrOpacity = 0.5;
    mixedTracks.push({ id: 'mixed-track-2', name: 'SDR graphic', height: 60, locked: false,
      visible: true, muted: false, solo: false, order: 2,
      items: [{ id: 'mixed-sdr', type: 'shape', trackId: 'mixed-track-2', label: 'SDR graphic',
        from: 0, durationInFrames: 30, shapeType: 'rectangle',
        fillColor: 'rgb(25%, 50%, 75%)', strokeEnabled: false, strokeWidth: 0,
        transform: { x: SIZE, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: sdrOpacity } }],
    });
    const mixedCanvas = new OffscreenCanvas(width, SIZE);
    for (const { transfer } of sources) {
      registerHdrSourceUrl(`mixed-media-${transfer}`, `/hdr-fixture/${transfer}.mp4`);
    }
    let mixedRenderer;
    const mixed = [];
    try {
      const historicalMixed = { fps: FPS, width, height: SIZE, durationInFrames: 30,
        backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' }, tracks: mixedTracks };
      await expectHdrOperatorRefusal(historicalMixed, {}, 15, 'mixed decoded PQ/HLG with exposure');
      const admittedTracks = mixedTracks.map(track => ({ ...track, items: track.items.map(item => ({ ...item, effects: [] })) }));
      mixedRenderer = await createCompositionRenderer({ ...historicalMixed, tracks: admittedTracks },
        mixedCanvas, mixedCanvas.getContext('2d'), { mode: 'export' });
      await mixedRenderer.preload?.();
      for (const segment of [0, 1, 2]) {
        const working = sources.map(({ transfer, opacity, exposure }) =>
          out[transfer].uploads[segment].want.map((v, channel) =>
            v * opacity + background[channel] * (1 - opacity)));
        working.push(sdrRgb.map((v, channel) => v * sdrOpacity + background[channel] * (1 - sdrOpacity)));
        // Counterfactual: clipping a decoded source before its effect/alpha
        // cannot produce the expected highlight/wide-gamut output.
        const clipped = sources.map(({ transfer, opacity, exposure }) =>
          out[transfer].uploads[segment].want.map((v, channel) =>
            Math.max(0, Math.min(1, v)) * opacity + background[channel] * (1 - opacity)));
        const nonnegative = sources.map(({ transfer, opacity, exposure }) =>
          out[transfer].uploads[segment].want.map((v, channel) =>
            Math.max(0, v) * opacity + background[channel] * (1 - opacity)));
        for (const target of ['pq', 'hlg']) {
          const frame = await mixedRenderer.renderFrameSignal(segment * 10 + 5, target);
          mixed.push({ segment, target, width: frame.width, height: frame.height, working,
            got: [0, 1, 2].map((region) => Array.from(frame.rgba.slice(
              (c * frame.width + region * SIZE + c) * 4,
              (c * frame.width + region * SIZE + c) * 4 + 4))),
            want: working.map((rgb) => color.workingToSignal(rgb, target)),
            clipped: clipped.map((rgb) => color.workingToSignal(rgb, target)),
            nonnegative: nonnegative.map((rgb) => color.workingToSignal(rgb, target)),
          });
        }
      }
    } finally {
      mixedRenderer?.dispose();
      for (const { transfer } of sources) registerHdrSourceUrl(`mixed-media-${transfer}`, null);
    }

    // 4. Functional masks and two nested viewports retain the same decoded
    // working values. The inner alpha mask removes the lower half of the HDR
    // clip, but not the SDR graphic above its track. The outer instance occupies
    // the right half of a transparent viewport. Translating that viewport by
    // quarter pixels produces a genuine premultiplied-alpha filtering ramp.
    const { useCompositionsStore } = await import('/src/features/timeline/stores/compositions-store.ts');
    const previousCompositions = useCompositionsStore.getState().compositions;
    const nestedAlpha = [];
    const nestedTrack = (id, order, items) => ({ id, name: id, height: 60, locked: false,
      visible: true, muted: false, solo: false, order, items });
    const nestedItem = (id, compositionId, transform) => ({ id, type: 'composition', compositionId,
      compositionWidth: SIZE, compositionHeight: SIZE, trackId: `${id}-track`,
      from: 0, durationInFrames: 30, label: id, transform });
    const storeComposition = (id, tracks) => ({ id, name: id, fps: FPS, width: SIZE, height: SIZE,
      durationInFrames: 30, backgroundColor: '#000000', transitions: [], keyframes: [], tracks,
      items: tracks.flatMap((track) => track.items) });
    try {
      for (const transfer of ['pq', 'hlg']) {
        const mediaId = `nested-media-${transfer}`;
        registerHdrSourceUrl(mediaId, `/hdr-fixture/${transfer}.mp4`);
        try {
          const clip = { id: `nested-${transfer}`, type: 'video', trackId: 'nested-video', mediaId,
            src: `/hdr-fixture/${transfer}.mp4`, label: transfer, from: 0, durationInFrames: 30,
            sourceStart: 0, sourceEnd: 30, sourceFps: FPS, sourceDuration: 30, speed: 1,
            sourceWidth: SIZE, sourceHeight: SIZE,
            transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 },
            effects: [{ id: `nested-exposure-${transfer}`, enabled: true,
              effect: { type: 'gpu-effect', gpuEffectType: 'gpu-exposure',
                params: { exposure: 1, offset: 0, gamma: 1 } } }] };
          const mask = { id: `nested-mask-${transfer}`, type: 'shape', trackId: 'nested-mask',
            from: 0, durationInFrames: 30, label: 'upper-half alpha mask', shapeType: 'rectangle',
            fillColor: '#ffffff', strokeEnabled: false, strokeWidth: 0, isMask: true, maskType: 'alpha',
            transform: { x: 0, y: -SIZE / 4, width: SIZE + 16, height: SIZE / 2, rotation: 0, opacity: 1 } };
          const graphic = { id: `nested-sdr-${transfer}`, type: 'shape', trackId: 'nested-sdr',
            from: 0, durationInFrames: 30, label: 'SDR over masked HDR', shapeType: 'rectangle',
            fillColor: 'rgb(25%, 50%, 75%)', strokeEnabled: false, strokeWidth: 0,
            transform: { x: 3 * SIZE / 8, y: 0, width: SIZE / 4, height: SIZE + 16,
              rotation: 0, opacity: 0.5 } };
          const innerId = `nested-inner-${transfer}`;
          const outerId = `nested-outer-${transfer}`;
          const inner = storeComposition(innerId, [nestedTrack('nested-sdr', 0, [graphic]),
            nestedTrack('nested-mask', 1, [mask]), nestedTrack('nested-video', 2, [clip])]);
          const innerInstance = nestedItem(`inner-instance-${transfer}`, innerId,
            { x: SIZE / 4, y: 0, width: SIZE / 2, height: SIZE, rotation: 0, opacity: 1 });
          const outer = storeComposition(outerId, [nestedTrack(innerInstance.trackId, 0, [innerInstance])]);
          useCompositionsStore.getState().setCompositions([inner, outer]);
          const historicalInstance = nestedItem(`historical-instance-${transfer}`, outerId,
            { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 0.5 });
          await expectHdrOperatorRefusal({ fps: FPS, width: SIZE, height: SIZE, durationInFrames: 30,
            backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
            tracks: [nestedTrack(historicalInstance.trackId, 0, [historicalInstance])] }, {}, 15, `nested exposure ${transfer}`);
          const admittedInner = storeComposition(innerId, [nestedTrack('nested-sdr', 0, [graphic]),
            nestedTrack('nested-mask', 1, [mask]), nestedTrack('nested-video', 2, [{ ...clip, effects: [] }])]);
          useCompositionsStore.getState().setCompositions([admittedInner, outer]);
          for (const shift of [0, 0.25, 0.5, 0.75, 1]) {
            const outerInstance = nestedItem(`outer-instance-${transfer}`, outerId,
              { x: shift, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 0.5 });
            const canvas = new OffscreenCanvas(SIZE, SIZE);
            let renderer;
            try {
              renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
                durationInFrames: 30, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
                tracks: [nestedTrack(outerInstance.trackId, 0, [outerInstance])] },
              canvas, canvas.getContext('2d'), { mode: 'export' });
              await renderer.preload?.();
              for (const segment of [0, 1, 2]) {
                const hdrRgb = out[transfer].uploads[segment].want;
                const coverage = 1 - shift;
                const over = (rgb, alpha) => rgb.map((value, channel) =>
                  value * alpha + background[channel] * (1 - alpha));
                // Source-over algebra on decoded helper values checks CPU/GPU parity.
                // The separate linear-hdr-subtree runner supplies physical equations.
                const points = [
                  { name: 'outside-viewport', x: 24, y: 16, rgb: background },
                  { name: 'hdr-fractional-edge', x: 32, y: 16, rgb: over(hdrRgb, 0.5 * coverage) },
                  { name: 'hdr-plateau', x: 48, y: 16, rgb: over(hdrRgb, 0.5) },
                  { name: 'mask-excluded', x: 48, y: 48, rgb: background },
                  { name: 'sdr-over-hdr', x: 60, y: 16,
                    rgb: over(hdrRgb.map((value, channel) => (value + sdrRgb[channel]) * 0.5), 0.5) },
                  { name: 'sdr-over-mask-excluded', x: 60, y: 48, rgb: over(sdrRgb, 0.25) },
                ];
                const unweightedEdge = over(hdrRgb.map((value) => value * coverage), 0.5 * coverage);
                const nonnegativePlateau = over(hdrRgb.map((value) => Math.max(0, value)), 0.5);
                for (const target of ['pq', 'hlg']) {
                  const frame = await renderer.renderFrameSignal(segment * 10 + 5, target);
                  nestedAlpha.push({ transfer, segment, shift, target, width: frame.width, height: frame.height,
                    points: points.map(({ name, x, y, rgb }) => ({ name, working: rgb,
                      got: Array.from(frame.rgba.slice((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4)),
                      want: color.workingToSignal(rgb, target) })),
                    unweightedEdge: color.workingToSignal(unweightedEdge, target),
                    nonnegativePlateau: color.workingToSignal(nonnegativePlateau, target) });
                }
              }
            } finally {
              renderer?.dispose();
            }
          }
        } finally {
          registerHdrSourceUrl(mediaId, null);
        }
      }
    } finally {
      useCompositionsStore.getState().setCompositions(previousCompositions);
    }

    // GPU nested-mask contracts are bound in mask-coverage-source-contract.md.
    // Quantize only the bounded matte attachments, never the HDR picture.
    const quantizeMatte = (alpha) => Math.round(Math.max(0, Math.min(1, alpha)) * 255) / 255;
    const featherCoverage = (distance, feather) => {
      const width = Math.max(feather, 0.75);
      const t = Math.max(0, Math.min(1, (distance + width) / (2 * width)));
      return 1 - t * t * (3 - 2 * t);
    };
    const alphaMask = (id, { x = 16, y = 0, width = SIZE / 2, height = SIZE + 16,
      strength = 100, opacity = 1, invert = false, feather = 0 } = {}) => ({
      id, type: 'shape', trackId: id, label: id, from: 0, durationInFrames: 30,
      shapeType: 'rectangle', fillColor: '#ffffff', strokeEnabled: false, strokeWidth: 0,
      isMask: true, maskType: 'alpha', maskOpacity: strength, maskInvert: invert, maskFeather: feather,
      transform: { x, y, width, height, rotation: 0, opacity },
    });
    const qa = quantizeMatte(0.75 * 0.9);
    const qb = quantizeMatte(0.8 * 0.65);
    const qi = quantizeMatte(0.6 * 0.75);
    const quadrants = [
      { name: 'upper-left', x: 16, y: 16 }, { name: 'upper-right', x: 48, y: 16 },
      { name: 'lower-left', x: 16, y: 48 }, { name: 'lower-right', x: 48, y: 48 },
    ];
    const featherPoints = [16, 28, 30, 32, 34, 36, 48].map((x) => ({ name: `edge-${x}`, x, y: 32 }));
    const variants = [
      { name: 'inverted', masks: [alphaMask('variant-inverted', { strength: 60, opacity: 0.75, invert: true })],
        points: [{ name: 'outside', x: 16, y: 32 }, { name: 'inside', x: 48, y: 32 }],
        alpha: ({ x }) => x < 32 ? 1 : 1 - qi,
        counterfactual: ({ x }) => x < 32 ? 0 : qi },
      { name: 'combined', masks: [alphaMask('variant-a', { strength: 75, opacity: 0.9 }),
        alphaMask('variant-b', { x: 0, y: -16, width: SIZE + 16, height: SIZE / 2, strength: 80, opacity: 0.65 })],
        points: quadrants, alpha: ({ x, y }) => quantizeMatte((x < 32 ? 0 : qa) * (y < 32 ? qb : 0)),
        counterfactual: ({ x }) => x < 32 ? 0 : qa },
      { name: 'combined-inverted', masks: [alphaMask('variant-ai', { strength: 75, opacity: 0.9 }),
        alphaMask('variant-bi', { x: 0, y: -16, width: SIZE + 16, height: SIZE / 2, strength: 80, opacity: 0.65, invert: true })],
        points: quadrants, alpha: ({ x, y }) => quantizeMatte((x < 32 ? 0 : qa) * (1 - (y < 32 ? qb : 0))),
        counterfactual: ({ x, y }) => quantizeMatte((x < 32 ? 0 : qa) * (y < 32 ? qb : 0)) },
      ...[false, true].map((invert) => ({ name: invert ? 'feather-inverted' : 'feather',
        masks: [alphaMask(`variant-feather-${invert}`, { x: 16.5, feather: 4, invert })], points: featherPoints,
        // The edge is at x=32.5, so the texel center at x=32 has signed distance 0.
        alpha: ({ x }) => {
          const alpha = quantizeMatte(featherCoverage(32 - x, 4));
          return invert ? 1 - alpha : alpha;
        },
        counterfactual: ({ x }) => {
          const alpha = quantizeMatte(featherCoverage(32 - x, 0));
          return invert ? 1 - alpha : alpha;
        } })),
    ];
    const maskVariants = [];
    try {
      for (const transfer of ['pq', 'hlg']) {
        const mediaId = `variant-media-${transfer}`;
        registerHdrSourceUrl(mediaId, `/hdr-fixture/${transfer}.mp4`);
        try {
          for (const variant of variants) {
            const clip = { id: `variant-video-${transfer}-${variant.name}`, type: 'video', trackId: 'variant-video',
              mediaId, src: `/hdr-fixture/${transfer}.mp4`, label: transfer, from: 0, durationInFrames: 30,
              sourceStart: 0, sourceEnd: 30, sourceFps: FPS, sourceDuration: 30, speed: 1,
              sourceWidth: SIZE, sourceHeight: SIZE,
              transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 },
              effects: [{ id: `variant-exposure-${transfer}-${variant.name}`, enabled: true,
                effect: { type: 'gpu-effect', gpuEffectType: 'gpu-exposure', params: { exposure: 1, offset: 0, gamma: 1 } } }] };
            const id = `variant-comp-${transfer}-${variant.name}`;
            const variantTracks = [...variant.masks.map((mask, order) => nestedTrack(mask.trackId, order, [mask])),
              nestedTrack('variant-video', variant.masks.length, [clip])];
            useCompositionsStore.getState().setCompositions([storeComposition(id, variantTracks)]);
            const instance = nestedItem(`variant-instance-${transfer}-${variant.name}`, id,
              { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 0.75 });
            await expectHdrOperatorRefusal({ fps: FPS, width: SIZE, height: SIZE, durationInFrames: 30,
              backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
              tracks: [nestedTrack(instance.trackId, 0, [instance])] }, {}, 15, `mask exposure ${transfer}/${variant.name}`);
            useCompositionsStore.getState().setCompositions([storeComposition(id,
              variantTracks.map(track => ({ ...track, items: track.items.map(item => ({ ...item, effects: [] })) })))]);
            const canvas = new OffscreenCanvas(SIZE, SIZE);
            let renderer;
            try {
              renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
                durationInFrames: 30, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
                tracks: [nestedTrack(instance.trackId, 0, [instance])] }, canvas, canvas.getContext('2d'), { mode: 'export' });
              await renderer.preload?.();
              for (const segment of [0, 1, 2]) {
                const source = out[transfer].uploads[segment].want;
                const over = (rgb, matte) => rgb.map((value, channel) =>
                  value * matte * 0.75 + background[channel] * (1 - matte * 0.75));
                for (const target of ['pq', 'hlg']) {
                  const frame = await renderer.renderFrameSignal(segment * 10 + 5, target);
                  maskVariants.push({ variant: variant.name, transfer, segment, target, source,
                    width: frame.width, height: frame.height,
                    points: variant.points.map((point) => {
                      const matte = variant.alpha(point);
                      const working = over(source, matte);
                      return { ...point, matte, working,
                        got: Array.from(frame.rgba.slice((point.y * frame.width + point.x) * 4,
                          (point.y * frame.width + point.x) * 4 + 4)),
                        want: color.workingToSignal(working, target),
                        counterfactual: color.workingToSignal(over(source, variant.counterfactual(point)), target),
                        nonnegative: color.workingToSignal(over(source.map((value) => Math.max(0, value)), matte), target) };
                    }) });
                }
              }
            } finally {
              renderer?.dispose();
            }
          }
        } finally {
          registerHdrSourceUrl(mediaId, null);
        }
      }
    } finally {
      useCompositionsStore.getState().setCompositions(previousCompositions);
    }

    const { CanvasPool } = await import('/src/features/export/utils/canvas-pool.ts');
    const { GpuTexturePool } = await import('/src/infrastructure/gpu-compositor/gpu-texture-pool.ts');
    const { useMediaLibraryStore } = await import('/src/features/media-library/stores/media-library-store.ts');
    const pools = { canvas: new Set(), texture: new Set() };
    const acquireCanvas = CanvasPool.prototype.acquire;
    const acquireTexture = GpuTexturePool.prototype.acquire;
    CanvasPool.prototype.acquire = function (...args) { pools.canvas.add(this); return acquireCanvas.apply(this, args); };
    GpuTexturePool.prototype.acquire = function (...args) { pools.texture.add(this); return acquireTexture.apply(this, args); };
    const poolUsage = () => Object.fromEntries(Object.entries(pools).map(([kind, entries]) =>
      [kind, [...entries].reduce((sum, pool) => sum + pool.getStats().inUse, 0)]));

    // 5. Admitted masked raster cuts stay in float; the old transition graph refuses. Section 6
    // explicitly disables its GPU capability to test the Canvas refusal.
    // This source regression does not qualify other GPU backends or hardware.
    const rasterCodes = [0.7, 0.45, 0.25].map((value) => Math.round(value * 65535));
    const rasterInput = { width: SIZE, height: SIZE, transfer: 'pq',
      rgb: new Uint16Array(Array.from({ length: SIZE * SIZE }, () => rasterCodes).flat()) };
    const rasterWorking = color.signalToWorking(rasterCodes.map((value) => value / 65535), 'pq');
    const rasterClip = (id, from) => ({ id, type: 'image', mediaId: 'masked-raster', trackId: 'raster-clips',
      label: id, from, durationInFrames: 30, src: '', sourceWidth: SIZE, sourceHeight: SIZE,
      transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } });
    const rasterMask = { id: 'raster-mask', type: 'shape', trackId: 'raster-mask', label: 'raster mask',
      from: 0, durationInFrames: 60, shapeType: 'rectangle', fillColor: '#ffffff',
      strokeEnabled: false, strokeWidth: 0, isMask: true, maskType: 'alpha',
      transform: { x: 0, y: -SIZE / 4, width: SIZE + 16, height: SIZE / 2, rotation: 0, opacity: 1 } };
    const { TransitionPipeline } = await import('/src/infrastructure/gpu-transitions/transition-pipeline.ts');
    const renderTextureTransition = TransitionPipeline.prototype.renderTexturesToTexture;
    const hasRasterTransition = TransitionPipeline.prototype.has;
    let rasterGpuCalls = 0;
    TransitionPipeline.prototype.renderTexturesToTexture = function (...args) {
      rasterGpuCalls++;
      return renderTextureTransition.apply(this, args);
    };
    const rightCodes = [0.65, 0.45, 0.25].map((value) => Math.round(value * 65535));
    const rightInput = { ...rasterInput,
      rgb: new Uint16Array(Array.from({ length: SIZE * SIZE }, () => rightCodes).flat()) };
    const rightWorking = color.signalToWorking(rightCodes.map((value) => value / 65535), 'pq');
    const rasterTransition = [{ id: 'masked-raster-cut', type: 'crossfade', presentation: 'dissolve', timing: 'linear',
      trackId: 'raster-clips', leftClipId: 'raster-left', rightClipId: 'raster-right', durationInFrames: 20, alignment: 0.5 }];
    const rasterOutputs = [];
    const rasterCutCases = [];
    let maskedRasterCuts;
    let maskUploadFailure;
    let maskUploadPreview;
    let maskContextFailure;
    let rasterForcedRefusal;
    await expectHdrOperatorRefusal({ fps: FPS, width: SIZE, height: SIZE, durationInFrames: 60,
      backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
      tracks: [nestedTrack('raster-mask', 0, [rasterMask]), nestedTrack('raster-clips', 1,
        [rasterClip('raster-left', 0), { ...rasterClip('raster-right', 30), mediaId: 'masked-raster-right' }])],
      transitions: rasterTransition }, { hdrRasters: { 'masked-raster': rasterInput, 'masked-raster-right': rightInput } },
      30, 'masked HDR raster transition');
    try {
      for (const [variant, invert, opacity] of [['opaque', false, 1], ['inverted-partial', true, 0.65]]) {
        const canvas = new OffscreenCanvas(SIZE, SIZE);
        const renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
          durationInFrames: 60, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
          tracks: [nestedTrack('raster-mask', 0, [{ ...rasterMask, maskInvert: invert,
            transform: { ...rasterMask.transform, opacity } }]),
            nestedTrack('raster-clips', 1, [rasterClip('raster-left', 0),
              { ...rasterClip('raster-right', 30), mediaId: 'masked-raster-right' }])],
          transitions: [] }, canvas, canvas.getContext('2d'),
        { mode: 'export', hdrRasters: { 'masked-raster': rasterInput, 'masked-raster-right': rightInput } });
        try {
          await renderer.preload?.();
          for (const frameNumber of [25, 30, 35]) {
            const source = frameNumber < 30 ? rasterWorking : rightWorking;
            for (const target of ['pq', 'hlg']) {
              const before = poolUsage();
              const frame = await renderer.renderFrameSignal(frameNumber, target);
              const points = [16, 48].map((y) => {
                const matte = (invert ? y > 32 : y < 32) ? Math.round(opacity * 255) / 255 : 0;
                const over = (rgb) => rgb.map((value, channel) =>
                  value * matte + background[channel] * (1 - matte));
                const working = over(source);
                return { got: Array.from(frame.rgba.slice((y * frame.width + 48) * 4,
                    (y * frame.width + 48) * 4 + 4)), working,
                  want: color.workingToSignal(working, target),
                  clipped: color.workingToSignal(over(source.map((value) => Math.max(0, Math.min(1, value)))), target),
                  nonnegative: color.workingToSignal(over(source.map((value) => Math.max(0, value))), target) };
              });
              const output = { target, width: frame.width, height: frame.height, points };
              rasterCutCases.push({ variant, frameNumber, source, before, after: poolUsage(), ...output });
              if (variant === 'opaque' && frameNumber === 30) rasterOutputs.push(output);
            }
          }
          if (variant === 'opaque') {
            const before = poolUsage();
            const copyExternal = device.queue.copyExternalImageToTexture;
            device.queue.copyExternalImageToTexture = () => { throw new Error('forced mask upload failure'); };
            try {
              await renderer.renderFrameSignal(30, 'pq');
              throw new Error('Failed mask upload emitted a signal');
            } catch (error) {
              if (!['forced mask upload failure', 'Float layer mask could not be rendered'].includes(error.message)) throw error;
              maskUploadFailure = { before, after: poolUsage(), emitted: 0, name: error.name, reason: error.message };
            } finally { device.queue.copyExternalImageToTexture = copyExternal; }
            // Mount the real pump, stage and Player. The renderer's upload
            // exception must hide the decoded SDR surface until managed recovery.
            // Reuse Vite's versioned dependency URLs so hooks and createRoot
            // share the same React dispatcher as the production components.
            const entry = await fetch('/src/main.tsx').then((response) => response.text());
            const reactUrl = entry.match(/from "([^"]+\/react\.js\?[^"]*)"/)[1];
            const clientUrl = entry.match(/from "([^"]+\/react-dom_client\.js\?[^"]*)"/)[1];
            const reactModule = await import(reactUrl);
            const React = reactModule.default ?? reactModule;
            const clientModule = await import(clientUrl);
            const { createRoot } = clientModule.default ?? clientModule;
            const { PreviewStage } = await import('/src/features/preview/components/preview-stage.tsx');
            const { usePreviewRuntimeRefs } = await import('/src/features/preview/hooks/use-preview-runtime-refs.ts');
            const { usePreviewOverlayController } = await import('/src/features/preview/hooks/use-preview-overlay-controller.ts');
            const { usePreviewRenderPump } = await import('/src/features/preview/hooks/use-preview-render-pump-controller.ts');
            const { usePlaybackStore } = await import('/src/shared/state/playback/index.ts');
            const { usePreviewBridgeStore } = await import('/src/shared/state/preview-bridge/index.ts');
            const { resetPlaybackPreviewState } = await import('/src/shared/state/playback-preview-test-helpers.ts');
            const host = document.createElement('div');
            document.body.append(host);
            const root = createRoot(host);
            const noop = () => {}, no = () => false, nothing = () => null;
            const calls = [], failures = [];
            const managedRenderer = { ...renderer, renderFrame: async (frame) => {
              calls.push(frame);
              try { await renderer.renderFrame(frame); }
              catch (error) { failures.push({ frame, name: error.name, reason: error.message }); throw error; }
            } };
            const props = { fps: FPS, width: SIZE, height: SIZE, durationInFrames: 60,
              backgroundColor: '#000000', transitions: [], keyframes: [], tracks: [nestedTrack('player-sdr', 0,
                [{ id: 'decoded-sdr', type: 'video', trackId: 'player-sdr', src: '/hdr-fixture/pq.mp4',
                  from: 20, durationInFrames: 30, sourceStart: 0, sourceEnd: 30, sourceFps: FPS,
                  sourceDuration: 30, speed: 1, transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } }])] };
            function Harness() {
              const refs = usePreviewRuntimeRefs();
              const overlay = usePreviewOverlayController({ bypassPreviewSeekRef: refs.bypassPreviewSeekRef,
                setDisplayedFrame: usePreviewBridgeStore.getState().setDisplayedFrame });
              const params = React.useMemo(() => ({ ...refs.renderPumpRefs, fps: FPS,
                forceFastScrubOverlay: true, useProxy: false, combinedTracks: [],
                fastScrubBoundaryFrames: [], fastScrubBoundarySources: [], playbackTransitionOverlayWindows: [],
                playbackTransitionLookaheadFrames: 0, playbackTransitionCooldownFrames: 0,
                playbackTransitionPrerenderRunwayFrames: 0, previewPerfRef: { current: {} },
                ensureFastScrubRenderer: async () => { refs.scrubOffscreenCanvasRef.current = canvas; return managedRenderer; },
                ensureBgTransitionRenderer: async () => null, disposeFastScrubRenderer: noop,
                shouldPreferPlayerForPreview: no, shouldPreserveHighFidelityBackwardPreview: no,
                getTransitionWindowByStartFrame: nothing, getTransitionWindowForFrame: nothing,
                getPlayingAnyTransitionPrewarmStartFrame: nothing, getPausedTransitionPrewarmStartFrame: nothing,
                getPinnedTransitionElementForItem: nothing, pinTransitionPlaybackSession: nothing,
                clearTransitionPlaybackSession: noop, cacheTransitionSessionFrame: noop,
                preparePlaybackTransitionFrame: async () => false, pushTransitionTrace: noop,
                isPausedTransitionOverlayActive: no, trackPlayerSeek: noop,
                setDisplayedFrame: usePreviewBridgeStore.getState().setDisplayedFrame,
                hideFastScrubOverlay: overlay.hideFastScrubOverlay, hidePlaybackTransitionOverlay: overlay.hidePlaybackTransitionOverlay,
                showFastScrubOverlayForFrame: overlay.showFastScrubOverlayForFrame,
                showPlaybackTransitionOverlayForFrame: overlay.showPlaybackTransitionOverlayForFrame,
                showFastScrubOverlayRef: overlay.showFastScrubOverlayRef }), [refs.renderPumpRefs]);
              const unavailable = usePreviewRenderPump(params);
              return React.createElement(PreviewStage, { backgroundRef: { current: null }, playerRef: refs.playerRef,
                scrubCanvasRef: refs.scrubCanvasRef, gpuEffectsCanvasRef: refs.gpuEffectsCanvasRef,
                needsOverflow: false, playerSize: { width: SIZE, height: SIZE }, playerRenderSize: { width: SIZE, height: SIZE },
                overlayRenderSize: { width: SIZE, height: SIZE }, totalFrames: 60, fps: FPS, initialFrame: 30,
                isResolving: false, isRenderedOverlayVisible: overlay.isRenderedOverlayVisible,
                hdrPreviewUnavailable: unavailable, colorGradeComparisonMode: 'split', inputProps: props,
                onBackgroundClick: noop, onFrameChange: noop, onPlayStateChange: noop, setPlayerContainerRefCallback: noop });
            }
            const waitUntil = async (ready) => {
              const deadline = performance.now() + 10000;
              while (!ready()) {
                if (performance.now() > deadline) throw new Error('Mask preview regression timed out');
                await new Promise(requestAnimationFrame);
              }
              await new Promise(requestAnimationFrame);
              await new Promise(requestAnimationFrame);
            };
            const state = () => {
              const player = host.querySelector('[data-player-container] [data-player-container]');
              if (!player) throw new Error('Production Player surface missing');
              return { playerVisibility: getComputedStyle(player).visibility,
                unavailable: Boolean(host.querySelector('[role="alert"]')),
                displayedFrame: usePreviewBridgeStore.getState().displayedFrame };
            };
            const beforePreview = poolUsage();
            resetPlaybackPreviewState(30);
            device.queue.copyExternalImageToTexture = () => { throw new Error('forced mask upload failure'); };
            try {
              root.render(React.createElement(Harness));
              await waitUntil(() => failures.length > 0);
              const first = state();
              maskUploadPreview = { first, calls, failures, before: beforePreview };
              if (failures[0].name === 'HdrRenderUnavailableError') {
                const firstFailures = failures.length;
                usePlaybackStore.getState().setPreviewFrame(31);
                await waitUntil(() => failures.length > firstFailures && failures.some((error) => error.frame === 31));
                maskUploadPreview.seek = state();
                maskUploadPreview.afterRefusals = poolUsage();
                device.queue.copyExternalImageToTexture = copyExternal;
                usePlaybackStore.getState().setPreviewFrame(32);
                await waitUntil(() => usePreviewBridgeStore.getState().displayedFrame === 32);
                maskUploadPreview.recovery = state();
              }
            } finally {
              device.queue.copyExternalImageToTexture = copyExternal;
              root.unmount(); host.remove(); resetPlaybackPreviewState();
            }
            const getContext = OffscreenCanvas.prototype.getContext;
            const acquireBeforeContextFailure = CanvasPool.prototype.acquire;
            const beforeContextFailure = poolUsage();
            let maskContextArmed = false;
            CanvasPool.prototype.acquire = function (...args) {
              const entry = acquireBeforeContextFailure.apply(this, args);
              maskContextArmed = true;
              return entry;
            };
            // The content surface remains available; only the following colorless
            // matte lacks a context. HDR participants have no Canvas ingress.
            OffscreenCanvas.prototype.getContext = function (type, ...args) {
              return type === '2d' && maskContextArmed ? null : getContext.call(this, type, ...args);
            };
            try {
              await renderer.renderFrameSignal(30, 'pq');
              throw new Error('Missing mask context emitted a signal');
            } catch (error) {
              if (error.name !== 'HdrRenderUnavailableError' || error.message !== 'Float layer mask could not be rendered') throw error;
              maskContextFailure = { before: beforeContextFailure, after: poolUsage(), emitted: 0, reason: error.message };
            } finally {
              OffscreenCanvas.prototype.getContext = getContext;
              CanvasPool.prototype.acquire = acquireBeforeContextFailure;
            }
            const { MediaRenderPipeline } = await import('/src/infrastructure/gpu-media/media-render-pipeline.ts');
            const renderMedia = MediaRenderPipeline.prototype.renderTextureToTexture;
            MediaRenderPipeline.prototype.renderTextureToTexture = () => false;
            const beforeRefusal = poolUsage();
            try {
              await renderer.renderFrameSignal(30, 'pq');
              throw new Error('Forced raster Canvas fallback emitted a signal');
            } catch (error) {
              if (error.name !== 'Error' || error.message !== 'HDR raster cannot fall back to a canvas') throw error;
              rasterForcedRefusal = { before: beforeRefusal, after: poolUsage(), emitted: 0, name: error.name, reason: error.message, qualification: 'known forced raster transport decline; ordinary Error, not typed operator coverage' };
            } finally { MediaRenderPipeline.prototype.renderTextureToTexture = renderMedia; }
          }
        } finally { renderer.dispose(); }
      }
      maskedRasterCuts = { coverage: 'source-regression-only', status: 'preserved',
        operation: 'hard-cuts', working: rightWorking, outputs: rasterOutputs };
    } finally {
      TransitionPipeline.prototype.renderTexturesToTexture = renderTextureTransition;
      TransitionPipeline.prototype.has = hasRasterTransition;
    }
    maskedRasterCuts.gpuTextureTransitions = rasterGpuCalls;
    // 6. Force GPU transition capability unavailable. Registered HDR videos must refuse that path
    // before a signal is emitted, rather than importing their SDR playback.
    const poolRefusals = [];
    const refuseWithReleasedPools = async (renderer, frame, target, scenario, expectedReason = 'Transitions are not migrated to linear HDR working colour') => {
      const before = poolUsage();
      let emitted = 0;
      try {
        await renderer.renderFrameSignal(frame, target);
        emitted++;
        throw new Error('HDR Canvas fallback emitted a signal');
      } catch (error) {
        if (!(error instanceof color.HdrRenderUnavailableError) || error.message !== expectedReason) throw error;
        const after = poolUsage();
        if (before.canvas !== after.canvas || before.texture !== after.texture) {
          throw new Error(`${scenario}: refusal retained pooled resources: ${JSON.stringify({ before, after })}`);
        }
        poolRefusals.push({ scenario, target, before, after });
        return { emitted, reason: error.message };
      }
    };
    const canvasRefusals = [];
    const hasTransition = TransitionPipeline.prototype.has;
    TransitionPipeline.prototype.has = () => false;
    try {
      for (const transfer of ['pq', 'hlg']) {
        const mediaId = `canvas-refusal-${transfer}`;
        const url = `/hdr-fixture/${transfer}.mp4`;
        registerHdrSourceUrl(mediaId, url);
        let renderer;
        try {
          const canvas = new OffscreenCanvas(SIZE, SIZE);
          const clip = (id, from) => ({ id, type: 'video', mediaId, trackId: 'refusal-clips',
            src: url, label: id, from, durationInFrames: 30, sourceStart: 0, sourceEnd: 30,
            sourceFps: FPS, sourceDuration: 30, speed: 1, sourceWidth: SIZE, sourceHeight: SIZE,
            transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } });
          renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
            durationInFrames: 60, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
            tracks: [nestedTrack('raster-mask', 0, [rasterMask]),
              nestedTrack('refusal-clips', 1, [clip('refusal-left', 0), clip('refusal-right', 30)])],
            transitions: [{ id: 'refusal-cut', type: 'crossfade', presentation: 'dissolve', timing: 'linear',
              trackId: 'refusal-clips', leftClipId: 'refusal-left', rightClipId: 'refusal-right',
              durationInFrames: 20, alignment: 0.5 }] }, canvas, canvas.getContext('2d'), { mode: 'export' });
          await renderer.preload?.();
          for (const target of ['pq', 'hlg']) {
            for (let attempt = 0; attempt < 3; attempt++) {
              const refusal = await refuseWithReleasedPools(renderer, 30 + attempt, target, `masked-${transfer}`);
              canvasRefusals.push({ transfer, target, attempt, ...refusal });
            }
          }
        } finally {
          renderer?.dispose();
          registerHdrSourceUrl(mediaId, null);
        }
      }
      // Metadata identifies HDR even while no float intermediate is registered.
      // Retain the renderer across failures; successful sibling results must drain
      // and release before the rejection, including the parallel export lane.
      const previousMedia = useMediaLibraryStore.getState().mediaById;
      const mediaId = 'pending-hdr-source';
      useMediaLibraryStore.setState({ mediaById: { ...previousMedia, [mediaId]: { colorTransfer: 'pq' } } });
      try {
        for (const scenario of ['item', 'transition']) {
          const clip = (id, from) => ({ id, type: 'video', mediaId, trackId: 'pending-clips',
            src: '/hdr-fixture/pq.mp4', label: id, from, durationInFrames: 30,
            sourceStart: 0, sourceEnd: 30, sourceFps: FPS, sourceDuration: 30, speed: 1,
            transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } });
          const graphic = { id: 'pending-sibling', type: 'shape', trackId: 'pending-sibling',
            label: 'SDR sibling', from: 0, durationInFrames: 60, shapeType: 'rectangle',
            fillColor: '#406080', strokeEnabled: false, strokeWidth: 0,
            transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 0.5 } };
          for (const mode of ['preview', 'export']) {
            const canvas = new OffscreenCanvas(SIZE, SIZE);
            const renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
              durationInFrames: 60, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
              tracks: [nestedTrack('pending-sibling', 2, [graphic]), nestedTrack('pending-clips', 1,
                scenario === 'item' ? [clip('pending-left', 0)] : [clip('pending-left', 0), clip('pending-right', 30)])],
              transitions: scenario === 'item' ? [] : [{ id: 'pending-cut', type: 'crossfade',
                presentation: 'dissolve', timing: 'linear', trackId: 'pending-clips',
                leftClipId: 'pending-left', rightClipId: 'pending-right', durationInFrames: 20, alignment: 0.5 }] },
              canvas, canvas.getContext('2d'), { mode });
            try {
              await renderer.preload?.();
              for (let attempt = 0; attempt < 3; attempt++) {
                await refuseWithReleasedPools(renderer, (scenario === 'item' ? 0 : 30) + attempt,
                  'pq', `pending-${scenario}-${mode}`, scenario === 'item' ? 'HDR video cannot be drawn through a canvas' : 'Transitions are not migrated to linear HDR working colour');
              }
            } finally { renderer.dispose(); }
          }
        }
      } finally { useMediaLibraryStore.setState({ mediaById: previousMedia }); }
    } finally {
      CanvasPool.prototype.acquire = acquireCanvas;
      GpuTexturePool.prototype.acquire = acquireTexture;
      TransitionPipeline.prototype.has = hasTransition;
    }
    // 7. An inner transition must join its delayed SDR decoder before it
    // rejects for HDR or restores/releases the participant state.
    const { renderTransitionToCanvas } = await import('/src/features/export/utils/canvas-item-renderer/transition.ts');
    const { renderItem } = await import('/src/features/export/utils/canvas-item-renderer/render-item.ts');
    const contextForPool = (canvasPool) => ({ fps: FPS, canvasSettings: { width: SIZE, height: SIZE, fps: FPS },
      renderMode: 'preview', canvasPool, renderItem, keyframesMap: new Map(), adjustmentLayers: [],
      subCompRenderData: new Map(), videoExtractors: new Map(), videoElements: new Map(),
      useMediabunny: new Set(), mediabunnyDisabledItems: new Set(), mediabunnyFailureCountByItem: new Map(),
      imageElements: new Map(), gifFramesMap: new Map() });
    const transform = { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1, cornerRadius: 0 };
    const hdrItem = { id: 'owner-hdr', type: 'video', mediaId: 'owner-hdr', trackId: 'owner-track',
      src: 'unused-hdr.mp4', from: 0, durationInFrames: 30, sourceFps: FPS, sourceDuration: 30,
      speed: 1, transform };
    const raster = new OffscreenCanvas(SIZE, SIZE);
    const rasterCtx = raster.getContext('2d');
    for (const [x, y, fill] of [[0, 0, '#f04020'], [SIZE / 2, 0, '#30a050'],
      [0, SIZE / 2, '#2050e0'], [SIZE / 2, SIZE / 2, '#d0b030']]) {
      rasterCtx.fillStyle = fill; rasterCtx.fillRect(x, y, SIZE / 2, SIZE / 2);
    }
    const bitmap = await createImageBitmap(raster);
    const transitionPool = new CanvasPool(SIZE, SIZE, 2, 2);
    const delayedCtx = contextForPool(transitionPool);
    const gate = Promise.withResolvers();
    const started = Promise.withResolvers();
    const drawn = Promise.withResolvers();
    const waitForDecoder = (promise) => Promise.race([promise, new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SDR participant did not reach controlled decode/draw')), 5000))]);
    delayedCtx.isRenderingTransition = false;
    delayedCtx.waitForInflightPredecodedBitmap = async () => { started.resolve(); return gate.promise; };
    let acquireCount = 0;
    let drawOwnership;
    const acquireParticipant = transitionPool.acquire.bind(transitionPool);
    transitionPool.acquire = () => {
      const acquired = acquireParticipant();
      if (++acquireCount === 2) {
        const drawImage = acquired.ctx.drawImage.bind(acquired.ctx);
        acquired.ctx.drawImage = (...args) => {
          drawImage(...args);
          drawOwnership = { inUse: transitionPool.getStats().inUse, transitionFlag: delayedCtx.isRenderingTransition };
          drawn.resolve();
        };
      }
      return acquired;
    };
    registerHdrSourceUrl(hdrItem.mediaId, '/hdr-fixture/pq.mp4');
    let delayedTransition;
    let canvasStateReuse;
    try {
      const right = { ...hdrItem, id: 'owner-sdr', mediaId: undefined, src: 'delayed-sdr.mp4', from: 30 };
      const active = { transition: { id: 'owner-cut', type: 'crossfade', presentation: 'dissolve',
        timing: 'linear', trackId: 'owner-track', leftClipId: hdrItem.id, rightClipId: right.id, durationInFrames: 20 },
        leftClip: hdrItem, rightClip: right, progress: 0.5, transitionStart: 20, transitionEnd: 40,
        durationInFrames: 20, leftPortion: 10, rightPortion: 10, cutPoint: 30 };
      let settled = false;
      const target = new OffscreenCanvas(SIZE, SIZE);
      const transitionTask = renderTransitionToCanvas(target.getContext('2d'), active, 30, delayedCtx, 0)
        .then(() => { settled = true; return null; }, (error) => { settled = true; return error; });
      await waitForDecoder(started.promise);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const beforeDecode = { settled, inUse: transitionPool.getStats().inUse,
        transitionFlag: delayedCtx.isRenderingTransition };
      gate.resolve(bitmap);
      const error = await transitionTask;
      await waitForDecoder(drawn.promise);
      await new Promise((resolve) => setTimeout(resolve, 0));
      delayedTransition = { beforeDecode, drawOwnership, reason: error?.message,
        afterDecode: { inUse: transitionPool.getStats().inUse, transitionFlag: delayedCtx.isRenderingTransition } };

      // The same-size pool intentionally retains the canvas/context. An HDR
      // throw after rotate/flip/clip must not contaminate its next SDR raster.
      const reusedPool = new CanvasPool(SIZE, SIZE, 1, 1);
      const freshPool = new CanvasPool(SIZE, SIZE, 1, 1);
      try {
        const stateCtx = contextForPool(reusedPool);
        const first = reusedPool.acquire();
        try {
          await renderItem(first.ctx, { ...hdrItem, transform: { ...transform, flipHorizontal: true } },
            { ...transform, x: 11, y: -7, width: 24, height: 32, rotation: 37, opacity: 0.5, cornerRadius: 7 }, 0, stateCtx);
          throw new Error('HDR state test did not refuse');
        } catch (error) {
          if (error.message !== 'HDR video cannot be drawn through a canvas') throw error;
        } finally { reusedPool.release(first.canvas); }
        const image = { id: 'owner-raster', type: 'image', from: 0, durationInFrames: 30, transform };
        stateCtx.imageElements.set(image.id, { source: bitmap, width: SIZE, height: SIZE });
        const reused = reusedPool.acquire();
        const fresh = freshPool.acquire();
        const freshCtx = contextForPool(freshPool);
        freshCtx.imageElements = stateCtx.imageElements;
        await renderItem(reused.ctx, image, transform, 0, stateCtx);
        await renderItem(fresh.ctx, image, transform, 0, freshCtx);
        const got = reused.ctx.getImageData(0, 0, SIZE, SIZE).data;
        const want = fresh.ctx.getImageData(0, 0, SIZE, SIZE).data;
        canvasStateReuse = { sameCanvas: reused.canvas === first.canvas, comparedChannels: want.length,
          mismatchedChannels: got.reduce((count, value, index) => count + Number(value !== want[index]), 0),
          freshOpaquePixels: want.filter((value, index) => index % 4 === 3 && value === 255).length };
        reusedPool.release(reused.canvas); freshPool.release(fresh.canvas);
      } finally { reusedPool.dispose(); freshPool.dispose(); }
    } finally {
      gate.resolve(bitmap);
      registerHdrSourceUrl(hdrItem.mediaId, null);
      transitionPool.dispose(); bitmap.close();
    }
    // 8. The historical mixed-failure graph still refuses before output. The
    // linear HDR item guard now wins before its legacy transition path runs.
    const mixedFailures = [];
    const priorityMedia = 'priority-hdr-video';
    registerHdrSourceUrl(priorityMedia, '/hdr-fixture/pq.mp4');
    TransitionPipeline.prototype.has = () => false;
    try {
      for (const hdrSide of ['right', 'left']) {
        const video = (id, from) => ({ id, type: 'video', mediaId: priorityMedia, trackId: 'priority-track',
          src: '/hdr-fixture/pq.mp4', from, durationInFrames: 30, sourceStart: 0, sourceEnd: 30,
          sourceFps: FPS, sourceDuration: 30, speed: 1, sourceWidth: SIZE, sourceHeight: SIZE, transform });
        const image = (id, from) => ({ ...rasterClip(id, from), trackId: 'priority-track' });
        const left = hdrSide === 'left' ? video('priority-left', 0) : image('priority-left', 0);
        const right = hdrSide === 'right' ? video('priority-right', 30) : image('priority-right', 30);
        const sibling = { ...rasterClip('priority-sibling', 0), trackId: 'priority-sibling', durationInFrames: 60,
          cornerPin: { topLeft: [0, 0], topRight: [24, -12], bottomRight: [10, 16], bottomLeft: [-18, 8] },
          transform: { ...transform, opacity: 0.5 } };
        const canvas = new OffscreenCanvas(SIZE, SIZE);
        const renderer = await createCompositionRenderer({ fps: FPS, width: SIZE, height: SIZE,
          durationInFrames: 60, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
          tracks: [nestedTrack('raster-mask', 0, [rasterMask]), nestedTrack('priority-track', 1, [left, right]),
            nestedTrack('priority-sibling', 2, [sibling])],
          transitions: [{ id: 'priority-cut', type: 'crossfade', presentation: 'dissolve', timing: 'linear',
            trackId: 'priority-track', leftClipId: left.id, rightClipId: right.id, durationInFrames: 20, alignment: 0.5 }] },
          canvas, canvas.getContext('2d'), { mode: 'export', hdrRasters: { 'masked-raster': rasterInput } });
        try {
          await renderer.preload?.();
          await renderer.renderFrame(30);
          throw new Error('Mixed-failure HDR frame unexpectedly rendered');
        } catch (error) {
          mixedFailures.push({ hdrSide, name: error.name, reason: error.message });
        } finally { renderer.dispose(); }
      }
    } finally {
      registerHdrSourceUrl(priorityMedia, null);
      TransitionPipeline.prototype.has = hasTransition;
    }
    device.destroy();
    return { workingDomain: color.HDR_WORKING_DOMAIN, alpha: 'straight', referenceWhiteNits: 203, expectation: 'production helper parity only; independent physical oracle is linear-hdr-subtree', linearRasters, historicalHdrRefusals, ...out, mixed, nestedAlpha, maskVariants, maskedRasterCuts, rasterCutCases, maskUploadFailure, maskUploadPreview, maskContextFailure, rasterForcedRefusal, canvasRefusals, poolRefusals,
      delayedTransition, canvasStateReuse, mixedFailures };
  }, { SIZE, FPS });
  // Raw measurements for conformance evidence, written before any assertion.
  if (process.env.HDR_SOURCE_REPORT) await writeFile(process.env.HDR_SOURCE_REPORT, JSON.stringify(result));

  assert.deepEqual(result.canvasRefusals.map(({ transfer, target, emitted }) => [transfer, target, emitted]),
    [['pq', 'pq', 0], ['pq', 'hlg', 0], ['hlg', 'pq', 0], ['hlg', 'hlg', 0]].flatMap((row) => Array.from({ length: 3 }, () => row)),
    'every real HDR Canvas fallback must refuse without emitting a signal');
  assert.deepEqual(result.poolRefusals.map(({ scenario }) => scenario),
    [['masked-pq', 6], ['masked-hlg', 6], ['pending-item-preview', 3], ['pending-item-export', 3],
      ['pending-transition-preview', 3], ['pending-transition-export', 3]]
      .flatMap(([scenario, count]) => Array(count).fill(scenario)));
  console.log(JSON.stringify({ check: 'HDR refusal resource ownership', attempts: result.poolRefusals.length,
    retainedAllocations: 0 }));

  assert.deepEqual(result.delayedTransition.beforeDecode,
    { settled: false, inUse: 2, transitionFlag: true }, 'HDR refusal must join the delayed SDR participant');
  assert.deepEqual(result.delayedTransition.drawOwnership,
    { inUse: 2, transitionFlag: true }, 'SDR draws before participant release and flag restoration');
  assert.deepEqual(result.delayedTransition.afterDecode, { inUse: 0, transitionFlag: false });
  assert.equal(result.delayedTransition.reason, 'HDR video cannot be drawn through a canvas');
  assert.deepEqual(result.canvasStateReuse, { sameCanvas: true, comparedChannels: SIZE * SIZE * 4,
    mismatchedChannels: 0, freshOpaquePixels: SIZE * SIZE }, 'refused context reuse must match a fresh pool');
  console.log(JSON.stringify({ check: 'HDR participant ownership and canvas state', delayedTransition: 'joined',
    reusedRasterChannels: result.canvasStateReuse.comparedChannels }));

  assert.deepEqual(result.mixedFailures, ['right', 'left'].map((hdrSide) => ({ hdrSide,
    name: 'HdrRenderUnavailableError', reason: 'Item could not be rendered on the linear HDR route' })),
    'historical mixed-failure transition graph is typed-refused before any signal');

  let compared = 0;
  for (const transfer of ['pq', 'hlg']) {
    const { uploads, hdr, sdr, sdrWhite } = result[transfer];
    uploads.forEach(({ transfer: tagged, format, got, want }, segment) => {
      assert.equal(tagged, transfer, 'the decoder reports the intermediate\'s transfer');
      assert.equal(format, 'I420P10');
      want.forEach((value, channel) => {
        compared++;
        assert.ok(Math.abs(got[channel] - value) <= 2e-3 * Math.max(1, Math.abs(value)),
          `${transfer} upload segment ${segment} channel ${channel}: ${got[channel]} vs ${value}`);
      });
    });
    hdr.forEach((signal, segment) => {
      SEGMENTS[transfer][segment].forEach((value, channel) => {
        compared++;
        assert.ok(Math.abs(signal[channel] - value) <= 0.012,
          `${transfer} delivery segment ${segment} channel ${channel}: ${signal[channel]} vs ${value}`);
      });
    });
    // The highlight segment is brighter than SDR white only on the HDR route.
    assert.ok(hdr[1][1] > sdrWhite[1] + 0.1, `${transfer} highlight kept: ${hdr[1][1]}`);
    assert.ok(sdr[1][1] <= sdrWhite[1] + 1e-3, `${transfer} SDR route cannot exceed SDR white: ${sdr[1][1]}`);
  }
  assert.equal(result.mixed.length, 6, 'all mixed-source segments and output policies ran');
  for (const { segment, target, width, height, got, want } of result.mixed) {
    assert.equal(width, SIZE * 3);
    assert.equal(height, SIZE);
    got.forEach((pixel, region) => {
      want[region].forEach((value, channel) => {
        compared++;
        assert.ok(Number.isFinite(pixel[channel]) && Math.abs(pixel[channel] - value) <= 0.004,
          `mixed ${target} segment ${segment} region ${region} channel ${channel}: ${pixel[channel]} vs ${value}`);
      });
      assert.ok(Math.abs(pixel[3] - 1) < 1e-6, `mixed ${target}: opaque background alpha ${pixel[3]}`);
    });
  }
  assert.ok(['pq', 'hlg'].some((transfer) => result[transfer].uploads.some(({ want }) => want.some((v) => v < -0.01))),
    'decoded coloured source must exercise signed working RGB');
  assert.ok(result.mixed.some(({ working }) => working.some((rgb) => rgb.some((v) => v > 1))),
    'mixed composite must exercise above-white working RGB');
  assert.ok(result.mixed.some(({ want, clipped }) => clipped.some((rgb, region) =>
    rgb.some((v, channel) => Math.abs(v - want[region][channel]) > 0.01))),
    'mixed golden must distinguish premature source clipping');
  assert.ok(result.mixed.some(({ want, nonnegative }) => nonnegative.some((rgb, region) =>
    rgb.some((v, channel) => Math.abs(v - want[region][channel]) > 0.001))),
    'mixed golden must independently distinguish clipping negative working RGB');
  assert.equal(result.nestedAlpha.length, 60, 'both decoded sources, three segments, five edge positions and both outputs ran');
  for (const { transfer, segment, shift, target, width, height, points } of result.nestedAlpha) {
    assert.equal(width, SIZE);
    assert.equal(height, SIZE);
    assert.equal(points.length, 6);
    for (const { name, got, want } of points) {
      want.forEach((value, channel) => {
        compared++;
        assert.ok(Number.isFinite(got[channel]) && Math.abs(got[channel] - value) <= 0.004,
          `nested ${transfer}->${target} segment ${segment} shift ${shift} ${name} channel ${channel}: ${got[channel]} vs ${value}`);
      });
      assert.ok(Math.abs(got[3] - 1) < 1e-6, `nested ${name}: opaque output alpha ${got[3]}`);
    }
  }
  const nestedPoint = (entry, name) => entry.points.find((point) => point.name === name);
  assert.ok(result.nestedAlpha.some((entry) => nestedPoint(entry, 'hdr-plateau').working.some((v) => v > 1)),
    'nested mask/transform/blend seam must retain above-white working values');
  assert.ok(result.nestedAlpha.some((entry) => nestedPoint(entry, 'hdr-plateau').working.some((v) => v < -0.01)),
    'nested mask/transform/blend seam must retain signed working values');
  assert.ok(result.nestedAlpha.some((entry) => entry.shift === 0.5 &&
    nestedPoint(entry, 'hdr-fractional-edge').want.some((v, channel) => Math.abs(v - entry.unweightedEdge[channel]) > 0.01)),
    'fractional golden must distinguish interpolation without premultiplied-alpha weighting');
  assert.ok(result.nestedAlpha.some((entry) => nestedPoint(entry, 'hdr-plateau').want.some((v, channel) =>
    Math.abs(v - entry.nonnegativePlateau[channel]) > 0.001)),
    'nested golden must independently distinguish negative-RGB clipping');
  const variantNames = ['inverted', 'combined', 'combined-inverted', 'feather', 'feather-inverted'];
  const expectedVariants = variantNames.flatMap((variant) => ['pq', 'hlg'].flatMap((transfer) =>
    [0, 1, 2].flatMap((segment) => ['pq', 'hlg'].map((target) => `${variant}/${transfer}/${segment}/${target}`))));
  assert.equal(result.maskVariants.length, 60, 'all supported mask variant/source/segment/output cases ran');
  assert.deepEqual(result.maskVariants.map(({ variant, transfer, segment, target }) =>
    `${variant}/${transfer}/${segment}/${target}`).sort(), expectedVariants.sort());
  for (const { variant, transfer, segment, target, width, height, points } of result.maskVariants) {
    assert.equal(width, SIZE);
    assert.equal(height, SIZE);
    assert.equal(points.length, variant.startsWith('feather') ? 7 : variant === 'inverted' ? 2 : 4);
    for (const { name, got, want } of points) {
      want.forEach((value, channel) => {
        compared++;
        assert.ok(Number.isFinite(got[channel]) && Math.abs(got[channel] - value) <= 0.004,
          `mask ${variant} ${transfer}->${target} segment ${segment} ${name} channel ${channel}: ${got[channel]} vs ${value}`);
      });
      assert.ok(Math.abs(got[3] - 1) < 1e-6, `mask ${variant}: opaque output alpha ${got[3]}`);
    }
  }
  for (const variant of variantNames) {
    const entries = result.maskVariants.filter((entry) => entry.variant === variant);
    assert.ok(entries.some(({ points }) => points.some(({ want, counterfactual }) =>
      want.some((value, channel) => Math.abs(value - counterfactual[channel]) > 0.01))),
    `${variant}: golden must distinguish missing inversion, combination or feathering`);
    assert.ok(entries.some(({ points }) => points.some(({ working }) => working.some((value) => value > 1))),
      `${variant}: masked composite must exercise above-white values`);
    assert.ok(entries.some(({ source }) => source.some((value) => value < -0.01)),
      `${variant}: decoded source must exercise negative working RGB`);
    assert.ok(entries.some(({ points }) => points.some(({ want, nonnegative }) =>
      want.some((value, channel) => Math.abs(value - nonnegative[channel]) > 0.001))),
    `${variant}: golden must independently distinguish negative-RGB clipping`);
  }
  // Independent D65 matrix composition, from CSS Color 4's rational matrices.
  const multiply = (m, rgb) => m.map(row => row.reduce((sum, coefficient, i) => sum + coefficient * rgb[i], 0));
  const xyzTo709 = [[12831 / 3959, -329 / 214, -1974 / 3959],
    [-851781 / 878810, 1648619 / 878810, 36519 / 878810], [705 / 12673, -2585 / 12673, 705 / 667]];
  const p3ToXyz = [[608311 / 1250200, 189793 / 714400, 198249 / 1000160],
    [35783 / 156275, 247089 / 357200, 198249 / 2500400], [0, 32229 / 714400, 5220557 / 5000800]];
  const to2020 = [[0.627404, 0.329282, 0.043314], [0.069097, 0.91954, 0.011361], [0.016392, 0.088013, 0.895595]];
  const pq = nits => {
    const y = (nits / 10000) ** (2610 / 16384);
    return ((3424 / 4096 + 2413 / 128 * y) / (1 + 2392 / 128 * y)) ** (2523 / 32);
  };
  assert.equal(result.linearRasters.length, 6);
  for (const sample of result.linearRasters) {
    const rgb = [0.8, 4, 1];
    const wide = sample.gamut === 2 ? rgb : multiply(to2020,
      sample.gamut === 1 ? multiply(xyzTo709, multiply(p3ToXyz, rgb)) : rgb);
    wide.forEach((value, channel) => assert.ok(Math.abs(sample.rgba[channel] - pq(value * sample.referenceWhite * 0.25)) < 0.002,
      `linear raster gamut ${sample.gamut}, white ${sample.referenceWhite}, channel ${channel}: ${sample.rgba[channel]}`));
    assert.equal(sample.rgba[3], 1, 'composite over opaque black retains coverage in radiance');
  }
  assert.equal(result.maskedRasterCuts.status, 'preserved', 'admitted masked HDR raster cuts must stay in float');
  assert.equal(result.maskedRasterCuts.operation, 'hard-cuts');
  assert.equal(result.historicalHdrRefusals.length, 14);
  assert(result.historicalHdrRefusals.every(entry => entry.errorType === 'HdrRenderUnavailableError' && entry.emitted === 0));
  assert.equal(result.maskUploadFailure.name, 'HdrRenderUnavailableError');
  assert.equal(result.maskedRasterCuts.gpuTextureTransitions, 0, 'admitted HDR cuts must not invoke an unmigrated transition');
  assert.equal(result.rasterForcedRefusal?.emitted, 0);
  assert.deepEqual(result.rasterForcedRefusal.after, result.rasterForcedRefusal.before);
  assert.equal(result.rasterCutCases.length, 12);
  for (const { variant, frameNumber, target, points, before, after } of result.rasterCutCases) {
    assert.deepEqual(after, before, `${variant}: successful output retained pooled resources`);
    for (const { got, want } of points) {
      want.forEach((value, channel) => {
        compared++;
        assert.ok(Math.abs(got[channel] - value) <= 0.004,
          `masked cut ${variant} frame ${frameNumber} ${target} channel ${channel}: ${got[channel]} vs ${value}`);
      });
      assert.equal(got[3], 1);
    }
  }
  for (const variant of ['opaque', 'inverted-partial']) {
    const entries = result.rasterCutCases.filter((entry) => entry.variant === variant);
    for (const counterfactual of ['clipped', 'nonnegative']) {
      assert.ok(entries.some(({ points }) => points.some((point) =>
        point.want.some((value, channel) => Math.abs(value - point[counterfactual][channel]) > 0.001))),
      `${variant}: golden must distinguish ${counterfactual} working RGB`);
    }
  }
  assert.equal(result.maskContextFailure?.emitted, 0);
  assert.deepEqual(result.maskContextFailure.after, result.maskContextFailure.before);
  assert.equal(result.maskUploadFailure?.emitted, 0);
  for (const phase of ['first', 'seek']) {
    assert.deepEqual(result.maskUploadPreview[phase], { playerVisibility: 'hidden', unavailable: true, displayedFrame: null });
  }
  assert.deepEqual(result.maskUploadPreview.afterRefusals, result.maskUploadPreview.before);
  assert.deepEqual(result.maskUploadPreview.recovery, { playerVisibility: 'visible', unavailable: false, displayedFrame: 32 });
  assert.ok(result.maskUploadPreview.failures.length >= 2);
  assert.ok(result.maskUploadPreview.failures.every((error) => error.name === 'HdrRenderUnavailableError'));
  assert.ok(result.maskUploadPreview.failures.some((error) => error.frame === 31));
  console.log(JSON.stringify({ check: 'Masked HDR upload refusal through production pump, stage and Player',
    refusedFrames: [30, 31], player: 'hidden through seek', managedRecoveryFrame: 32, retainedAllocations: 0 }));
  assert.deepEqual(result.maskUploadFailure.after, result.maskUploadFailure.before, 'failed mask upload must release its texture and every rendered layer');
  compared += validateMaskedRasterDiagnostic(result.maskedRasterCuts, SIZE).compared;
  console.log(`HDR source, mixed composition, nested alpha and supported mask variant goldens match (${compared} values, PQ and HLG)`);
  assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
  Object.assign(result, { source, result: 'passed' });
  if (process.env.HDR_SOURCE_REPORT) await writeFile(process.env.HDR_SOURCE_REPORT, JSON.stringify(result));
  console.log(JSON.stringify({ check: 'admitted masked HDR raster cut diagnostic',
    coverage: result.maskedRasterCuts.coverage, status: result.maskedRasterCuts.status,
    emittedSignalCount: result.maskedRasterCuts.outputs.length,
    reason: result.maskedRasterCuts.reason,
    unavailableCoverage: result.maskedRasterCuts.unavailableCoverage }));
} finally {
  await browser.close();
}
