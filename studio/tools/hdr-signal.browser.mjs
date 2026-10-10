// Current admitted HDR/SDR graphics and explicit output parity. Production
// helpers build expectations here; linear-hdr-subtree supplies the separate
// physical oracle. The historical effect/blend HDR graph is a typed refusal.
import assert from 'node:assert/strict';
import { testedSource } from './lib/working-domain-report.mjs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const source = await testedSource(new URL(import.meta.url));
const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.route(origin + '/hdr-signal', (route) =>
    // The renderer imports React modules, which need the dev server's refresh preamble.
    route.fulfill({ contentType: 'text/html', body: `<title>HDR signal</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  await page.goto(origin + '/hdr-signal');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  const result = await page.evaluate(async () => {
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const color = await import('/src/shared/graphics/color/managed-color.ts');
    const W = 16;
    const H = 8;
    const shape = (id, x, fillColor, extra = {}) => ({
      id, type: 'shape', trackId: `t-${id}`, from: 0, durationInFrames: 30, label: id,
      shapeType: 'rectangle', fillColor, strokeEnabled: false, strokeWidth: 0,
      transform: { x, y: 0, width: 4, height: 8, rotation: 0, opacity: 1 }, ...extra,
    });
    const track = (order, items) => ({ id: `track-${order}`, name: `T${order}`, height: 60, locked: false,
      visible: true, muted: false, solo: false, order, items });
    const composition = (colorManagement) => ({
      fps: 30, width: W, height: H, durationInFrames: 30, backgroundColor: '#666666', colorManagement,
      tracks: [
        track(0, [shape('highlight', -6, 'rgb(300%, 150%, 50%)')]),
        track(1, [shape('exposed', -2, 'rgb(50%, 50%, 50%)', { effects: [{ id: 'fx', enabled: true,
          effect: { type: 'gpu-effect', gpuEffectType: 'gpu-exposure', params: { exposure: 2, offset: 0, gamma: 1 } } }] })]),
        track(2, [shape('dodge', 2, 'rgb(70%, 70%, 70%)', { blendMode: 'linear-dodge' })]),
        track(3, [{ ...shape('grey', 0, 'rgb(40%, 40%, 40%)'), transform: { x: 0, y: 0, width: 16, height: 8, rotation: 0, opacity: 1 } }]),
      ],
    });
    const admittedComposition = (colorManagement) => ({ ...composition(colorManagement), tracks: [
      track(0, [shape('highlight', -6, 'rgb(200%, 125%, 50%)')]),
      track(1, [shape('grey-half', -2, 'rgb(50%, 50%, 50%)')]),
      track(2, [shape('near-white', 2, 'rgb(110%, 110%, 110%)')]),
      track(3, [{ ...shape('grey', 0, 'rgb(40%, 40%, 40%)'), transform: { x: 0, y: 0, width: 16, height: 8, rotation: 0, opacity: 1 } }]),
    ] });
    const renderAll = async (colorManagement, admitted = false) => {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d');
      const renderer = await createCompositionRenderer((admitted ? admittedComposition : composition)(colorManagement), canvas, ctx, { mode: 'export' });
      try {
        await renderer.preload?.();
        const out = {};
        for (const target of ['pq', 'hlg']) {
          const { width, height, rgba } = await renderer.renderFrameSignal(0, target);
          out[target] = { width, height, samples: [2, 6, 10, 14].map((x) => Array.from(rgba.slice((4 * W + x) * 4, (4 * W + x) * 4 + 4))) };
        }
        return out;
      } finally {
        renderer.dispose?.();
      }
    };
    let historicalHdrRefusal;
    try { await renderAll({ workingRange: 'hdr' }); throw new Error('Historical HDR operator graph unexpectedly rendered'); }
    catch (error) {
      if (!(error instanceof color.HdrRenderUnavailableError)) throw error;
      historicalHdrRefusal = { errorType: error.name, reason: error.message, emitted: 0 };
    }
    const hdr = await renderAll({ workingRange: 'hdr' }, true);
    const sdr = await renderAll(undefined);

    // Owner decision (FL-97): placing HDR media makes the project HDR, with no
    // project setting, and the SDR preview is BT.2390 tone mapped, never clipped.
    const { useMediaLibraryStore } = await import('/src/features/media-library/stores/media-library-store.ts');
    const hdrMedia = { id: 'hdr-media', colorTransfer: 'pq', mimeType: 'audio/wav', fileName: 'hdr', tags: [] };
    const previous = useMediaLibraryStore.getState();
    useMediaLibraryStore.setState({ mediaById: { ...previous.mediaById, [hdrMedia.id]: hdrMedia } });
    const marker = { id: 'marker', type: 'audio', trackId: 'track-9', from: 0, durationInFrames: 30,
      label: 'marker', mediaId: hdrMedia.id, src: '' };
    const derived = admittedComposition(undefined);
    derived.tracks.push({ ...track(9, [marker]), visible: false });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const renderer = await createCompositionRenderer(derived, canvas, ctx, { mode: 'export' });
    let fromSources;
    let preview;
    try {
      const { rgba } = await renderer.renderFrameSignal(0, 'pq');
      fromSources = [2, 6, 10, 14].map((x) => Array.from(rgba.slice((4 * W + x) * 4, (4 * W + x) * 4 + 4)));
      await renderer.renderFrame(0);
      preview = [2, 6, 10, 14].map((x) => Array.from(ctx.getImageData(x, 4, 1, 1).data));
    } finally {
      renderer.dispose?.();
      useMediaLibraryStore.setState({ mediaById: previous.mediaById });
    }

    const toSignal = (working, target) => color.workingToSignal(working, target);
    // Working values each region should hold before output conversion.
    const expected = {
      hdr: [[2, 1.25, 0.5], [0.5, 0.5, 0.5], [1.1, 1.1, 1.1], [0.4, 0.4, 0.4]],
      sdr: [[1, 1, 0.5], [1, 1, 1], [1, 1, 1], [0.4, 0.4, 0.4]],
    };
    for (const project of ['hdr', 'sdr']) expected[project] = expected[project].map(rgb => rgb.map(color.srgbDecodeExtended));
    const want = Object.fromEntries(Object.entries(expected).map(([project, regions]) => [project,
      Object.fromEntries(['pq', 'hlg'].map((target) => [target, regions.map((w) => toSignal(w, target))]))]));
    const toneMapped = expected.hdr.map((w) =>
      color.workingToSdrDisplay(w, color.resolveColorManagement(undefined, 'hdr')).map((v) => v * 255));
    return { workingDomain: color.HDR_WORKING_DOMAIN, alpha: 'straight', referenceWhiteNits: 203, expectation: 'production helper parity only; independent physical oracle is linear-hdr-subtree', historicalHdrRefusal, hdr, sdr, want, fromSources, preview, toneMapped };
  });
  // Raw measurements for conformance evidence, written before any assertion.
  if (process.env.HDR_SIGNAL_REPORT) await writeFile(process.env.HDR_SIGNAL_REPORT, JSON.stringify(result));
  assert.equal(result.historicalHdrRefusal.errorType, 'HdrRenderUnavailableError');
  assert.equal(result.historicalHdrRefusal.emitted, 0);
  for (const project of ['hdr', 'sdr']) {
    for (const target of ['pq', 'hlg']) {
      const got = result[project][target];
      assert.equal(got.width, 16);
      assert.equal(got.height, 8);
      got.samples.forEach((texel, region) => {
        result.want[project][target][region].forEach((value, channel) => assert.ok(
          Number.isFinite(texel[channel]) && Math.abs(texel[channel] - value) <= 4e-3,
          `${project} ${target} region ${region} channel ${channel}: ${texel[channel]} != ${value}`));
        assert.ok(Math.abs(texel[3] - 1) < 1e-6, `${project} ${target} region ${region}: alpha ${texel[3]}`);
      });
    }
  }
  result.fromSources.forEach((texel, region) => result.want.hdr.pq[region].forEach((value, channel) =>
    assert.ok(Math.abs(texel[channel] - value) <= 4e-3,
      `HDR media project region ${region} channel ${channel}: ${texel[channel]} != ${value}`)));
  result.preview.forEach((pixel, region) => result.toneMapped[region].forEach((value, channel) =>
    assert.ok(Math.abs(pixel[channel] - value) <= 3,
      `tone-mapped preview region ${region} channel ${channel}: ${pixel[channel]} != ${value}`)));
  // The highlight keeps its channel order instead of clipping to yellow, and the
  // bright grey stays below white.
  const [r, g, b] = result.preview[0];
  assert.ok(r > g && g > b && g < 200, `highlight clipped in preview: ${result.preview[0]}`);
  // Light just above reference white (linear decode of authored 1.1 sRGB) keeps headroom below display white.
  assert.ok(result.preview[2][0] > 150 && result.preview[2][0] < 230,
    `just above reference white in preview: ${result.preview[2]}`);
  assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
  Object.assign(result, { source, result: 'passed' });
  if (process.env.HDR_SIGNAL_REPORT) await writeFile(process.env.HDR_SIGNAL_REPORT, JSON.stringify(result));
  console.log(JSON.stringify({ check: 'admitted graphics through linear HDR and SDR output; historical HDR operator refusal', ...result.hdr.pq }));
} finally {
  await browser.close();
}
