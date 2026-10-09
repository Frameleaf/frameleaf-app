// FL-98: the scopes of a paused HDR project measure what the preview shows, as BT.2100 PQ.
//
// Real Chrome and WebGPU, a real PQ clip (the Studio HDR intermediate, 10-bit AV1) under a title,
// a real preview-mode renderer and the real scope view. The frame is displayed and cached first,
// the way the preview pump leaves a paused frame; the scope's float capture then has to read the
// float composite anyway, draw the title, and leave the preview's canvas and frame cache as they
// were. Run against the prepared engine's Vite dev server (default http://127.0.0.1:5186):
//   node studio/tools/scope-hdr-capture.browser.mjs
// SCOPE_HDR_REPORT=<path> writes the raw measurements as JSON, whether the checks pass or not.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const SIZE = 64;
const FPS = 30;
// 100 cd/m² grey as PQ R'G'B' signal (pqEncode(100) = 0.508078).
const CLIP_PQ = 0.508078;

const dir = mkdtempSync(join(tmpdir(), 'scope-hdr-'));
let fixture;
try {
  const frame = Buffer.alloc(SIZE * SIZE * 6);
  for (let i = 0; i < SIZE * SIZE * 3; i++) frame.writeUInt16LE(Math.round(CLIP_PQ * 65535), i * 2);
  const out = join(dir, 'pq.mp4');
  // The server's Studio HDR intermediate settings (server/src/utils/studio-hdr-proxy.ts).
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${SIZE}x${SIZE}`, '-r', String(FPS),
    '-i', '-', '-vf',
    'scale=out_range=tv:out_color_matrix=bt2020,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
    '-c:v', 'libsvtav1', '-preset', '10', '-crf', '23',
    '-svtav1-params', 'color-primaries=9:transfer-characteristics=16:matrix-coefficients=9:color-range=0',
    '-g', String(FPS), '-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084',
    '-colorspace', 'bt2020nc', '-color_range', 'tv', '-movflags', '+faststart', '-f', 'mp4', '-y', out,
  ], { input: Buffer.concat(Array.from({ length: 30 }, () => frame)), env: { ...process.env, SVT_LOG: '1' } });
  fixture = readFileSync(out);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let report = null;
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.route(`${origin}/scope-fixture/pq.mp4`, (route) => route.fulfill({ contentType: 'video/mp4', body: fixture }));
  await page.route(origin + '/scope-hdr', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<title>Scope HDR capture</title>
<div id="root" style="width:640px;height:420px"></div>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  const measure = async ({ SIZE, FPS }) => {
    const { registerHdrSourceUrl } = await import('/src/features/export/utils/hdr-video-sources.ts');
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const { useMediaLibraryStore } = await import('/src/features/media-library/stores/media-library-store.ts');
    const { usePlaybackStore } = await import('/src/shared/state/playback/index.ts');
    const { usePreviewBridgeStore } = await import('/src/shared/state/preview-bridge/index.ts');
    const { captureScopeSignal, resolveScopeColor } = await import('/src/features/preview/utils/scope-signal.ts');
    const { ColorScopesView } = await import('/src/features/preview/components/color-scopes-view.tsx');
    // React at the URLs Vite rewrites the app entry's imports to. Each optimised dependency has its
    // own ?v= hash, so read them rather than build them; the view then shares this React instance.
    const entry = await (await fetch('/src/main.tsx')).text();
    const optimised = entry.match(/\/node_modules\/\.vite\/deps\/[\w.-]+\.js\?v=[0-9a-f]+/g) ?? [];
    const dep = (file) => {
      const url = optimised.find((candidate) => candidate.includes(`/deps/${file}.js?`));
      if (!url) throw new Error(`main.tsx does not import ${file} through the optimised dependencies`);
      return url;
    };
    // Pre-bundled CommonJS: the module's default export is the package.
    const interop = (module) => (module.default && !module.createElement && !module.createRoot ? module.default : module);
    const React = interop(await import(dep('react')));
    const { createRoot } = interop(await import(dep('react-dom_client')));

    const url = '/scope-fixture/pq.mp4';
    registerHdrSourceUrl('media-pq', url);
    useMediaLibraryStore.setState({ mediaById: { 'media-pq': { id: 'media-pq', mimeType: 'video/mp4', colorTransfer: 'pq', width: SIZE, height: SIZE, fps: FPS } } });
    const clip = { id: 'clip', type: 'video', trackId: 'v1', mediaId: 'media-pq', src: url, label: 'clip',
      from: 0, durationInFrames: 30, sourceStart: 0, sourceEnd: 30, sourceFps: FPS, sourceDuration: 30, speed: 1,
      sourceWidth: SIZE, sourceHeight: SIZE,
      transform: { x: 0, y: 0, width: SIZE, height: SIZE, rotation: 0, opacity: 1 } };
    // A white title box over the top half.
    const title = { id: 'title', type: 'text', trackId: 't1', label: 'title', text: '.', color: '#ffffff',
      backgroundColor: '#ffffff', fontSize: 8, from: 0, durationInFrames: 30,
      transform: { x: 0, y: -SIZE / 4, width: SIZE, height: SIZE / 2, rotation: 0, opacity: 1 } };
    const track = (id, order, items) => ({ id, name: id, height: 60, locked: false, visible: true, muted: false, solo: false, order, items });
    const tracks = [track('t1', 0, [title]), track('v1', 1, [clip])];
    const composition = { fps: FPS, width: SIZE, height: SIZE, durationInFrames: 30, backgroundColor: '#000000', tracks };

    // The preview renderer: the frame is displayed (and cached) as the pump leaves a paused frame.
    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');
    const renderer = await createCompositionRenderer(composition, canvas, ctx, { mode: 'preview' });
    await renderer.preload?.();
    const FRAME = 12;
    await renderer.renderFrame(FRAME);
    await renderer.renderFrame(FRAME); // a second render of a paused frame is a cache hit
    const displayed = Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data);

    // The scope capture path the preview registers: colour from the same inputs as the renderer,
    // the signal from a renderer that draws everything the preview shows.
    const scopeColor = () => resolveScopeColor({ colorManagement: undefined, tracks });
    const signal = await captureScopeSignal(renderer, FRAME, 'pq');
    const afterCapture = Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data);
    await renderer.renderFrame(FRAME);
    const reRendered = Array.from(ctx.getImageData(0, 0, SIZE, SIZE).data);
    const at = (x, y) => Array.from(signal.rgba.slice((y * signal.width + x) * 4, (y * signal.width + x) * 4 + 3));

    // The real scope view, fed by that path, paused on the frame.
    usePlaybackStore.setState({ isPlaying: false, currentFrame: FRAME, previewFrame: null });
    usePreviewBridgeStore.setState({
      displayedFrame: FRAME,
      scopeColor,
      captureFrameSignal: async (target) => captureScopeSignal(renderer, FRAME, target),
      captureCanvasSource: async () => canvas,
      captureFrameImageData: null,
      captureFrame: null,
    });
    createRoot(document.getElementById('root')).render(React.createElement(ColorScopesView, { open: true, embedded: true }));
    const label = await new Promise((resolve) => {
      const deadline = performance.now() + 15000;
      const poll = () => {
        const text = document.querySelector('[data-testid="scope-color-space"]')?.textContent ?? '';
        if (text.includes('frame') || performance.now() > deadline) resolve(text);
        else setTimeout(poll, 100);
      };
      poll();
    });
    renderer.dispose();
    registerHdrSourceUrl('media-pq', null);
    return {
      color: scopeColor(),
      signal: { width: signal.width, height: signal.height, clip: at(SIZE / 2, SIZE - 8), title: at(SIZE / 2, 8) },
      displayUntouched: afterCapture.every((value, i) => value === displayed[i]),
      cacheIntact: reRendered.every((value, i) => value === displayed[i]),
      displayTitle: displayed.slice(((8 * SIZE) + SIZE / 2) * 4, ((8 * SIZE) + SIZE / 2) * 4 + 3),
      label,
    };
  };
  // A cold dev server re-optimises its dependencies when this page first imports the view, which
  // gives them a new ?v= hash and fails the imports already in flight. Reload once it has settled.
  for (let attempt = 1; ; attempt++) {
    await page.goto(origin + '/scope-hdr');
    await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
    try {
      report = await page.evaluate(measure, { SIZE, FPS });
      break;
    } catch (error) {
      if (attempt >= 3 || !/Failed to fetch dynamically imported module|Outdated Optimize Dep/.test(error.message)) throw error;
      console.warn(`dev server re-optimised its dependencies; reloading (${error.message.split('\n')[0]})`);
      await page.waitForTimeout(2000);
    }
  }
  if (process.env.SCOPE_HDR_REPORT) await writeFile(process.env.SCOPE_HDR_REPORT, JSON.stringify(report, null, 2));

  assert.deepEqual(report.color, { workingRange: 'hdr', sdrMonitoring: 'bt2390' });
  // The clip reads as its PQ signal, not as tone-mapped display pixels.
  for (const value of report.signal.clip) assert.ok(Math.abs(value - CLIP_PQ) <= 0.015, `clip PQ ${report.signal.clip}`);
  // The title the preview shows is in the measured frame: white, at reference white (203 cd/m²).
  for (const value of report.signal.title) assert.ok(Math.abs(value - 0.5807) <= 0.015, `title PQ ${report.signal.title}`);
  assert.equal(report.displayUntouched, true, 'the capture left the preview canvas as it was');
  assert.equal(report.cacheIntact, true, 'the capture did not replace the cached frame');
  assert.equal(report.label, 'Scopes · BT.2100 PQ · BT.2020 · 1.0 = 10,000 cd/m² · frame 12 · revision unknown');
  console.log(`Scope HDR capture: PQ clip ${report.signal.clip[0].toFixed(3)}, title ${report.signal.title[0].toFixed(3)}; preview canvas and cache untouched; "${report.label}"`);
} finally {
  await browser.close();
}
