// FL-97: an HDR project reads real HDR pixels for library clips. The Studio HDR
// intermediate (10-bit AV1, BT.2020, PQ or HLG, made with the server's encoder
// settings) is decoded with WebCodecs and uploaded straight into working values:
// the GPU upload equals the managed-colour reference on the decoded planes, and a
// clip's PQ/HLG signal survives the whole float route to delivery, highlights
// included. Without the intermediate the SDR route cannot carry them.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

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
    const c = SIZE / 2;
    const out = {};
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
    // Exposure operates on working RGB, then straight-alpha source-over blends
    // with SDR reference-white graphics, before either explicit output policy.
    const width = SIZE * 3;
    const background = [0.2, 0.2, 0.2];
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
    const sdrRgb = [0.25, 0.5, 0.75];
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
      mixedRenderer = await createCompositionRenderer({ fps: FPS, width, height: SIZE,
        durationInFrames: 30, backgroundColor: '#333333', colorManagement: { workingRange: 'hdr' },
        tracks: mixedTracks }, mixedCanvas, mixedCanvas.getContext('2d'), { mode: 'export' });
      await mixedRenderer.preload?.();
      for (const segment of [0, 1, 2]) {
        const working = sources.map(({ transfer, opacity, exposure }) =>
          out[transfer].uploads[segment].want.map((v, channel) =>
            v * 2 ** exposure * opacity + background[channel] * (1 - opacity)));
        working.push(sdrRgb.map((v, channel) => v * sdrOpacity + background[channel] * (1 - sdrOpacity)));
        // Counterfactual: clipping a decoded source before its effect/alpha
        // cannot produce the expected highlight/wide-gamut output.
        const clipped = sources.map(({ transfer, opacity, exposure }) =>
          out[transfer].uploads[segment].want.map((v, channel) =>
            Math.max(0, Math.min(1, v)) * 2 ** exposure * opacity + background[channel] * (1 - opacity)));
        const nonnegative = sources.map(({ transfer, opacity, exposure }) =>
          out[transfer].uploads[segment].want.map((v, channel) =>
            Math.max(0, v) * 2 ** exposure * opacity + background[channel] * (1 - opacity)));
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
    device.destroy();
    return { ...out, mixed };
  }, { SIZE, FPS });
  // Raw measurements for conformance evidence, written before any assertion.
  if (process.env.HDR_SOURCE_REPORT) await writeFile(process.env.HDR_SOURCE_REPORT, JSON.stringify(result));

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
  console.log(`HDR source ingest matches the reference (${compared} values, PQ and HLG)`);
} finally {
  await browser.close();
}
