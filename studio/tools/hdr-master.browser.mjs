// Admitted linear HDR raster cuts, SDR graphics and opacity keyframes -> Main10
// diagnostic masters. The historical exposure/linear-dodge graph is typed-refused.
// Production helper expectations check parity; linear-hdr-subtree is the physical oracle.
import assert from 'node:assert/strict';
import { testedSource } from './lib/working-domain-report.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';
import { decodeMaster, encodeHdrMaster, validateHdrPlaneSamples } from './hdr-master.mjs';

const source = await testedSource(new URL(import.meta.url));
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
    const historicalRenderer = await createCompositionRenderer(composition, canvas, canvas.getContext('2d'), { mode: 'export' });
    let historicalHdrRefusal;
    try { await historicalRenderer.renderFrameSignal(0, 'pq'); throw new Error('Historical HDR operators unexpectedly rendered'); }
    catch (error) {
      if (!(error instanceof color.HdrRenderUnavailableError)) throw error;
      historicalHdrRefusal = { errorType: error.name, reason: error.message, emitted: 0 };
    } finally { historicalRenderer.dispose(); }
    const codes = { pq: [0.75, 0.75, 0.75].map(value => Math.round(value * 65535)),
      hlg: [0.7, 0.65, 0.6].map(value => Math.round(value * 65535)) };
    const raster = (transfer) => ({ width: W, height: H, transfer,
      rgb: new Uint16Array(Array.from({ length: W * H }, () => codes[transfer]).flat()) });
    const hdrRasters = { 'master-pq': raster('pq'), 'master-hlg': raster('hlg') };
    const temperatureEffects = [{ id: 'temperature', enabled: true,
      effect: { type: 'gpu-effect', gpuEffectType: 'gpu-temperature', params: { temperature: 1, tint: -1 } } }, ...['grayscale','sepia','invert'].map(id=>({id,enabled:true,effect:{type:'gpu-effect',gpuEffectType:`gpu-${id}`,params:id==='invert'?{}:{amount:.375}}})), {id:'lift',enabled:true,effect:{type:'gpu-effect',gpuEffectType:'gpu-brightness',params:{amount:.5}}}];
    const clip = (id, transfer, from) => ({ ...rect(id, 'track-2', -8, 16, '#fff', { effects: temperatureEffects }), type: 'image',
      mediaId: `master-${transfer}`, src: '', from, durationInFrames: 2, sourceWidth: W, sourceHeight: H });
    const grey = rect('opacity-grey', 'track-1', 8, 16, 'rgb(50%, 50%, 50%)', { effects: temperatureEffects });
    const normal = rect('normal-strip', 'track-0', 12, 8, 'rgb(40%, 40%, 40%)');
    normal.transform.opacity = 0.5;
    const admitted = { ...composition, tracks: [track(0, [normal]), track(1, [grey]),
      track(2, [clip('pq-cut', 'pq', 0), clip('hlg-cut', 'hlg', 2)])],
      keyframes: [{ itemId: grey.id, properties: [{ property: 'opacity', keyframes: [
        { id: 'k0', frame: 0, value: 0, easing: 'linear' }, { id: 'k3', frame: 3, value: 1, easing: 'linear' },
      ] }] }] };
    const renderer = await createCompositionRenderer(admitted, canvas, canvas.getContext('2d'), { mode: 'export', hdrRasters });
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
    // CPU/GPU helper parity for the admitted linear graph, not an independent physical oracle.
    // Independent existing temperature/tint equation for T=1,Q=-1, before output mapping.
    const shifted = rgb => {
      const t=rgb.map((v,c)=>v+[.05,.1,-.15][c]);
      const gray=t.reduce((sum,v,c)=>sum+v*[.299,.587,.114][c],0);
      const g=t.map(v=>v*.625+gray*.375);
      return [[.393,.769,.189],[.349,.686,.168],[.272,.534,.131]].map((row,c)=>1.5-(g[c]*.625+row.reduce((sum,w,k)=>sum+w*g[k],0)*.375));
    };
    const reference = (frame) => ({
      clip: shifted(color.signalToWorking(codes[frame < 2 ? 'pq' : 'hlg'].map(value => value / 65535), frame < 2 ? 'pq' : 'hlg')),
      opacity: [0.5, 0.5, 0.5].map((value,c) => shifted([value,value,value].map(color.srgbDecodeExtended))[c] * frame / 3),
      normal: [0.5, 0.5, 0.5].map((value,c) => shifted([value,value,value].map(color.srgbDecodeExtended))[c] * frame / 3 * 0.5 + color.srgbDecodeExtended(0.4) * 0.5),
    });
    const want = {};
    for (const target of ['pq', 'hlg']) {
      want[target] = Array.from({ length: FRAMES }, (_, frame) => Object.fromEntries(
        Object.entries(reference(frame)).map(([key, working]) => [key, color.workingToSignal(working, target)])));
    }
    return { workingDomain: color.HDR_WORKING_DOMAIN, alpha: 'straight', referenceWhiteNits: 203, expectation: 'production helper parity only; independent physical oracle is linear-hdr-subtree', historicalHdrRefusal, inputProfiles: ['16-bit PQ BT.2020 raster', '16-bit HLG BT.2020 raster', 'SDR authored BT.709 graphics'], out, want };
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
assert.equal(rendered.historicalHdrRefusal.errorType, 'HdrRenderUnavailableError');
assert.equal(rendered.historicalHdrRefusal.emitted, 0);

const points = { clip: [8, 8], opacity: [20, 8], normal: [28, 8] };
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
      mastering: { maxNits: 4000, minNits: 0.005 }, validate: ({ light, probe, decoded, output: candidate }) => {
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
        const planes = decodeMaster('ffmpeg', candidate, W, H, 'yuv420p10le');
        assert.equal(planes.length, FRAMES);
        const planeSamples = validateHdrPlaneSamples(planes, W, H, frames.flatMap(({ rgba }, frame) =>
          Object.values(points).map(([x, y]) => ({ frame, x, y, rgb: rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 3) }))));
        summary[transfer] = { light, planeSamples, probe: { profile: probe.profile, transfer: probe.transfer, frames: probe.frames } };
    } });
    summary[transfer].inputSha256 = createHash('sha256').update(JSON.stringify(rendered.out[transfer])).digest('hex');
    summary[transfer].outputSha256 = createHash('sha256').update(readFileSync(output)).digest('hex');
    summary[transfer].outputPath = process.env.HDR_MASTER_REPORT
      ? path.relative(path.dirname(path.resolve(process.env.HDR_MASTER_REPORT)), output) : null;
    summary[transfer].encoderArgs = encoded.args.map((arg) => arg.endsWith('.partial.mp4') ? '<unpublished-output>' : arg);
    summary[transfer].planeDecodeArgs = ['-v', 'error', '-xerror', '-i', summary[transfer].outputPath ?? output,
      '-pix_fmt', 'yuv420p10le', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'];
  }
  assert.deepEqual(await testedSource(new URL(import.meta.url)), source, 'tested inputs changed during measurement');
  Object.assign(summary, { source, result: 'passed' });
  await writeReport(summary);
  console.log(JSON.stringify({ check: 'admitted linear HDR cuts/graphics/opacity through explicit output and HEVC Main10 diagnostic master', ...summary }));
} finally {
  if (!process.env.HDR_MASTER_REPORT) rmSync(dir, { recursive: true, force: true });
}
