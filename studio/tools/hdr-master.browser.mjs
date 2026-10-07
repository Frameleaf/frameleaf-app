// FL-107 (VID-202): edit → float graph → native master, end to end. An edited
// HDR sequence (a cut between two clips, a keyframed exposure, an HDR highlight
// and a linear-dodge blend) renders through the production renderer's float
// route and explicit PQ/HLG output conversion, is encoded as HEVC Main10 with
// measured HDR10 metadata, and is decoded back independently. Requires FFmpeg
// with libx265 (installed in the engine workflow).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';
import { encodeHdrMaster } from './hdr-master.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const W = 32;
const H = 16;
const FRAMES = 4;
const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let rendered;
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.route(origin + '/hdr-master', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<title>HDR master</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  await page.goto(origin + '/hdr-master');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  rendered = await page.evaluate(async ({ W, H, FRAMES }) => {
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const { buildEffectAnimatableProperty } = await import('/src/types/keyframe.ts');
    const color = await import('/src/shared/graphics/color/managed-color.ts');
    const rect = (id, trackId, x, width, fillColor, extra = {}) => ({
      id, type: 'shape', trackId, from: 0, durationInFrames: FRAMES, label: id,
      shapeType: 'rectangle', fillColor, strokeEnabled: false, strokeWidth: 0,
      transform: { x, y: 0, width, height: H, rotation: 0, opacity: 1 }, ...extra,
    });
    const track = (order, items) => ({ id: `track-${order}`, name: `T${order}`, height: 60, locked: false,
      visible: true, muted: false, solo: false, order, items });
    // Left half: clip A (frames 0-1) cuts to clip B (frames 2-3). Right half: a
    // grey clip with keyframed exposure, under a linear-dodge highlight strip.
    const clipA = rect('clipA', 'track-2', -8, 16, 'rgb(250%, 120%, 60%)', { durationInFrames: 2 });
    const clipB = rect('clipB', 'track-2', -8, 16, 'rgb(30%, 60%, 90%)', { from: 2, durationInFrames: 2 });
    const exposed = rect('exposed', 'track-1', 8, 16, 'rgb(50%, 50%, 50%)', { effects: [{ id: 'fx', enabled: true,
      effect: { type: 'gpu-effect', gpuEffectType: 'gpu-exposure', params: { exposure: 0, offset: 0, gamma: 1 } } }] });
    const strip = { ...rect('strip', 'track-0', 12, 8, 'rgb(40%, 40%, 40%)', { blendMode: 'linear-dodge' }),
      transform: { x: 12, y: 0, width: 8, height: H, rotation: 0, opacity: 1 } };
    const composition = {
      fps: 24, width: W, height: H, durationInFrames: FRAMES, backgroundColor: '#000000',
      colorManagement: { workingRange: 'hdr' },
      tracks: [track(0, [strip]), track(1, [exposed]), track(2, [clipA, clipB])],
      keyframes: [{ itemId: 'exposed', properties: [{
        property: buildEffectAnimatableProperty('gpu-exposure', 'fx', 'exposure'),
        keyframes: [{ id: 'k0', frame: 0, value: 0, easing: 'linear' }, { id: 'k3', frame: 3, value: 1.5, easing: 'linear' }],
      }] }],
    };
    const canvas = new OffscreenCanvas(W, H);
    const renderer = await createCompositionRenderer(composition, canvas, canvas.getContext('2d'), { mode: 'export' });
    const out = { pq: [], hlg: [] };
    try {
      for (const target of ['pq', 'hlg']) {
        for (let frame = 0; frame < FRAMES; frame++) {
          const { width, height, rgba } = await renderer.renderFrameSignal(frame, target);
          out[target].push({ width, height, rgba: Array.from(rgba) });
        }
      }
    } finally {
      renderer.dispose?.();
    }
    // Reference working values at the probe points of each frame.
    const exposure = (frame) => 1.5 * (frame / 3);
    const reference = (frame) => ({
      clip: frame < 2 ? [2.5, 1.2, 0.6] : [0.3, 0.6, 0.9],
      exposed: [0.5, 0.5, 0.5].map((v) => v * 2 ** exposure(frame)),
      dodge: [0.5, 0.5, 0.5].map((v) => v * 2 ** exposure(frame) + 0.4),
    });
    const want = {};
    for (const target of ['pq', 'hlg']) {
      want[target] = Array.from({ length: FRAMES }, (_, frame) => Object.fromEntries(
        Object.entries(reference(frame)).map(([key, working]) => [key, color.workingToSignal(working, target)])));
    }
    return { out, want };
  }, { W, H, FRAMES });
} finally {
  await browser.close();
}

// Raw measurements for conformance evidence: the rendered frames before any assertion, then
// the encoded masters' probe and light metadata once they are checked.
const writeReport = (masters) =>
  process.env.HDR_MASTER_REPORT && writeFile(process.env.HDR_MASTER_REPORT, JSON.stringify({
    qualification: 'diagnostic helper only; physical monitor and admitted deployments unqualified',
    tools: Object.fromEntries(['ffmpeg', 'ffprobe'].map((tool) => [tool, execFileSync(tool, ['-version']).toString().split('\n')[0]])),
    rendered, masters,
  }));
await writeReport(null);

const points = { clip: [8, 8], exposed: [20, 8], dodge: [28, 8] };
const dir = mkdtempSync(process.env.HDR_MASTER_REPORT
  ? `${path.resolve(process.env.HDR_MASTER_REPORT)}.artifacts-` : path.join(tmpdir(), 'fl-hdr-master-e2e-'));
try {
  const summary = {};
  for (const transfer of ['pq', 'hlg']) {
    const frames = rendered.out[transfer].map((f) => ({ ...f, rgba: Float32Array.from(f.rgba) }));
    // The renderer's explicit output equals the managed-colour reference.
    frames.forEach((frame, n) => {
      for (const [key, [x, y]] of Object.entries(points)) {
        const i = (y * W + x) * 4;
        rendered.want[transfer][n][key].forEach((value, c) => assert.ok(Math.abs(frame.rgba[i + c] - value) <= 4e-3,
          `${transfer} frame ${n} ${key} channel ${c}: ${frame.rgba[i + c]} != ${value}`));
      }
    });
    const output = path.join(dir, `edited-${transfer}.mp4`);
    const encoded = await encodeHdrMaster({ frames, fps: 24, transfer, output, lossless: true,
      mastering: { maxNits: 4000, minNits: 0.005 }, validate: ({ light, probe, decoded }) => {
        assert.equal(probe.codec, 'hevc');
        assert.equal(probe.profile, 'Main 10');
        assert.equal(probe.pixFmt, 'yuv420p10le');
        assert.equal(probe.primaries, 'bt2020');
        assert.equal(probe.transfer, transfer === 'pq' ? 'smpte2084' : 'arib-std-b67');
        assert.equal(probe.frames, FRAMES);
        assert.equal(probe.rFrameRate, '24/1');
        if (transfer === 'pq') {
          assert.equal(Number(probe.contentLight?.max_content), light.maxCll);
          assert.equal(Number(probe.contentLight?.max_average), light.maxFall);
          assert.ok(light.maxCll > 203, 'the edit carries light above reference white');
        }
        assert.equal(decoded.length, FRAMES);
        decoded.forEach((pixels, n) => {
          for (const [key, [x, y]] of Object.entries(points)) {
            const i = y * W + x;
            for (let c = 0; c < 3; c++) {
              assert.ok(Math.abs(pixels[i * 3 + c] - frames[n].rgba[i * 4 + c]) <= 2 / 1023,
                `${transfer} decoded frame ${n} ${key} channel ${c}: ${pixels[i * 3 + c]} != ${frames[n].rgba[i * 4 + c]}`);
            }
          }
        });
        summary[transfer] = { light, probe: { profile: probe.profile, transfer: probe.transfer, frames: probe.frames } };
    } });
    summary[transfer].inputSha256 = createHash('sha256').update(JSON.stringify(rendered.out[transfer])).digest('hex');
    summary[transfer].outputSha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
    summary[transfer].outputPath = process.env.HDR_MASTER_REPORT
      ? path.relative(path.dirname(path.resolve(process.env.HDR_MASTER_REPORT)), output) : null;
    summary[transfer].encoderArgs = encoded.args.map((arg) => arg.endsWith('.partial.mp4') ? '<unpublished-output>' : arg);
  }
  await writeReport(summary);
  console.log(JSON.stringify({ check: 'edited HDR sequence through float route, explicit output and HEVC Main10 master', ...summary }));
} finally {
  if (!process.env.HDR_MASTER_REPORT) rmSync(dir, { recursive: true, force: true });
}
