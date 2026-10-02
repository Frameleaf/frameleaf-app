// FL-99 / FL-97: every GPU transition, every direction, through the production
// transition pipeline on software WebGPU in CI.
// - Boundaries: progress 0 shows the outgoing clip and 1 the incoming clip,
//   exactly on the float route of an HDR project (signed extended range), and
//   within quantisation on the SDR routes.
// - SDR projects: the float route equals Freecut's rgba8unorm route.
// - HDR projects: extended-range input is never clipped at the midpoint.
// - Direction: 'from-right' is the mirror image of 'from-left' (and bottom of top)
//   for transitions declared mirror-symmetric in transition-semantics.json.
// - Every frame is finite and re-renders bit-identically.
// - Per transition through the production renderer (clips, keyframes, frame scene,
//   compositor): animated progress and a keyframed participant, a composed second
//   blend, and the invalid inputs whose meaning the engine declares.
//   TRANSITION_MATRIX_REPORT carries them as report.cases [{ id, case, ... }].
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { chromeLaunchArgs } from '../engine/headless/lib/cli.mjs';

const require = createRequire(new URL('../engine/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = process.env.STUDIO_TEST_ORIGIN || 'http://127.0.0.1:5186';
const explore = Boolean(process.env.TRANSITION_MATRIX_EXPLORE);
const semantics = explore ? { transitions: {} }
  : JSON.parse(await readFile(new URL('../transition-semantics.json', import.meta.url), 'utf8'));
const W = 16;
const H = 8;
const PROGRESS = [0, 0.25, 0.5, 0.75, 1];
const q = (v) => Math.round(v * 255) / 255;
// Outgoing: horizontal ramp in red, vertical in green. Incoming: diagonal blue/grey.
const sdrLeft = Array.from({ length: W * H }, (_, i) => {
  const x = i % W; const y = Math.floor(i / W);
  return [q(x / (W - 1)), q(y / (H - 1)), q(0.2), 1];
});
const sdrRight = Array.from({ length: W * H }, (_, i) => {
  const x = i % W; const y = Math.floor(i / W);
  return [q(0.1), q(((x + y) % 5) / 4), q(0.9 - 0.6 * (y / (H - 1))), 1];
});
const hdrLeft = sdrLeft.map(([r, g, b, a], i) => (i % 3 === 0 ? [r * 4 + 0.5, -0.25 * g, b + 1, a] : [r, g, b, a]));
const hdrRight = sdrRight.map(([r, g, b, a], i) => (i % 4 === 1 ? [3, g * 2, -0.1, a] : [r, g, b, a]));

const browser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
let report;
try {
  const page = await browser.newPage();
  await page.route(origin + '/transition-matrix', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Transition matrix</title>' }),
  );
  await page.goto(origin + '/transition-matrix');
  report = await page.evaluate(async ({ W, H, PROGRESS, sdrLeft, sdrRight, hdrLeft, hdrRight }) => {
    const { EffectsPipeline } = await import('/src/infrastructure/gpu-effects/effects-pipeline.ts');
    const { TransitionPipeline } = await import('/src/infrastructure/gpu-transitions/transition-pipeline.ts');
    const { GPU_TRANSITION_REGISTRY } = await import('/src/infrastructure/gpu-transitions/registry.ts');
    const device = await EffectsPipeline.requestCachedDevice();
    if (!device) throw new Error('WebGPU unavailable; transition matrix cannot run');
    const pipeline = TransitionPipeline.create(device);
    if (!pipeline) throw new Error('Transition pipeline initialization failed');
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const mirror = (texels, axis) => texels.map((_, i) => {
      const x = i % W; const y = Math.floor(i / W);
      return axis === 'x' ? texels[y * W + (W - 1 - x)] : texels[(H - 1 - y) * W + x];
    });
    const upload = (texels, format) => {
      const texture = device.createTexture({ size: [W, H], format, usage });
      const flat = texels.flat();
      if (format === 'rgba16float') {
        device.queue.writeTexture({ texture }, new Float16Array(flat), { bytesPerRow: W * 8 }, [W, H]);
      } else {
        device.queue.writeTexture({ texture }, new Uint8Array(flat.map((v) => Math.round(v * 255))),
          { bytesPerRow: W * 4 }, [W, H]);
      }
      return texture;
    };
    const cache = new Map();
    const input = (name, texels, format) => {
      const key = `${name}:${format}`;
      if (!cache.has(key)) cache.set(key, upload(texels, format));
      return cache.get(key);
    };
    const sets = {
      sdr: [sdrLeft, sdrRight], hdr: [hdrLeft, hdrRight],
      sdrMirrorX: [mirror(sdrLeft, 'x'), mirror(sdrRight, 'x')],
      sdrMirrorY: [mirror(sdrLeft, 'y'), mirror(sdrRight, 'y')],
    };
    const render = async (id, set, format, range, progress, direction) => {
      pipeline.setWorkingRange(range);
      const [left, right] = sets[set];
      const output = device.createTexture({ size: [W, H], format, usage });
      const buffer = device.createBuffer({ size: 256 * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      try {
        device.pushErrorScope('validation');
        const accepted = pipeline.renderTexturesToTexture(id, input(`${set}L`, left, format),
          input(`${set}R`, right, format), output, progress, W, H, direction, undefined, 'straight', 'straight');
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: output }, { buffer, bytesPerRow: 256 }, [W, H]);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (!accepted) return { error: 'rejected' };
        if (error) return { error: error.message };
        await buffer.mapAsync(GPUMapMode.READ);
        const mapped = buffer.getMappedRange();
        const pixels = [];
        for (let y = 0; y < H; y++) {
          const row = format === 'rgba16float'
            ? new Float16Array(mapped, y * 256, W * 4) : new Uint8Array(mapped, y * 256, W * 4);
          for (const v of row) pixels.push(format === 'rgba16float' ? v : v / 255);
        }
        buffer.unmap();
        return { pixels };
      } finally {
        output.destroy();
        buffer.destroy();
      }
    };
    const transitions = [];
    for (const [id, definition] of GPU_TRANSITION_REGISTRY) {
      const directions = definition.hasDirection ? (definition.directions ?? []) : [undefined];
      const entry = { id, directions: directions.map((d) => d ?? null), frames: [] };
      for (const direction of directions) {
        for (const progress of PROGRESS) {
          entry.frames.push({
            direction: direction ?? null, progress,
            hdr: await render(id, 'hdr', 'rgba16float', 'hdr', progress, direction),
            hdrAgain: progress === 0.5 ? await render(id, 'hdr', 'rgba16float', 'hdr', progress, direction) : null,
            sdrFloat: await render(id, 'sdr', 'rgba16float', 'sdr', progress, direction),
            sdr: await render(id, 'sdr', 'rgba8unorm', 'sdr', progress, direction),
          });
        }
      }
      if (definition.hasDirection) {
        const mirrored = {};
        for (const [direction, set] of [['from-right', 'sdrMirrorX'], ['from-bottom', 'sdrMirrorY']]) {
          if (directions.includes(direction)) {
            mirrored[direction] = await render(id, set, 'rgba16float', 'sdr', 0.5, direction);
          }
        }
        entry.mirrored = mirrored;
      }
      transitions.push(entry);
    }
    const f16 = (texels) => Array.from(new Float16Array(texels.flat()));
    pipeline.destroy();
    for (const texture of cache.values()) texture.destroy();
    return { transitions, hdrLeft16: f16(hdrLeft), hdrRight16: f16(hdrRight),
      sdrLeft16: f16(sdrLeft), sdrRight16: f16(sdrRight) };
  }, { W, H, PROGRESS, sdrLeft, sdrRight, hdrLeft, hdrRight });
} finally {
  await browser.close();
}

// ─── Per-transition cases through the production renderer (FL-99) ───
// Each case is a pair of real image clips that meet at a cut on one track, with the
// transition on that cut: the production renderer resolves the window, the progress,
// the participants' keyframes and the GPU transition, and composites the result.
// A pair is 80 frames and `r` is the frame within it: the cut is at r = 40, and a
// 10-frame centred window is r = 35..44 with progress (r - 35) / 9.
//   animated: progress follows the timeline: a 19-frame window (r = 31..49) draws
//             at r = 31 + 2k exactly what the 10-frame window draws at r = 35 + k;
//             and the outgoing clip's opacity keyframed 1 → 0 over r = 31..39 draws
//             at r = 35 and 37 exactly as a static opacity of 0.5 and 0.25.
//   composed: a screen-blended layer stacked over the transition: where it covers,
//             the frame is screen(transition frame, layer); elsewhere it is the
//             transition frame.
//   invalid:  only the inputs whose meaning the engine declares: an unknown
//             direction draws as from-left, an unknown timing as linear, an alignment
//             below 0 or above 1 as 0 or 1, a fractional duration as its whole
//             frames, an undeclared property is ignored, and an unknown transition id
//             draws a hard cut.
// The invalid case is not complete, so it is not claimed as conformance evidence
// (FAMILY_CASE_COVERAGE in scripts/frameleaf-studio-evidence.mjs): a non-finite
// duration or alignment keeps the outgoing clip on screen for the whole incoming
// clip, and a transition's own parameters are packed unchecked (NaN, out-of-range and
// non-number values reach the shader). Both need an engine change before they can be
// measured against a declared meaning, as opacity and effect parameters were.
const CASE_LAYER = [0.4, 0.8, 0.55];
const RATE = { frames: [35, 38, 41, 44], slowFrames: [31, 37, 43, 49] };
const caseBrowser = await chromium.launch({ headless: true, args: chromeLaunchArgs() });
try {
  const page = await caseBrowser.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  await page.route(origin + '/transition-cases', (route) =>
    // The renderer imports React modules, which need the dev server's refresh preamble.
    route.fulfill({ contentType: 'text/html', body: `<title>Transition cases</title>
<script type="module">
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
</script>` }),
  );
  await page.goto(origin + '/transition-cases');
  await page.waitForFunction(() => window.__vite_plugin_react_preamble_installed__ === true);
  report.cases = await page.evaluate(async ({ W, H, sdrLeft, sdrRight, layer, RATE }) => {
    const { createCompositionRenderer } = await import('/src/features/export/utils/client-render-engine.ts');
    const { GPU_TRANSITION_REGISTRY } = await import('/src/infrastructure/gpu-transitions/registry.ts');
    const { transitionRegistry } = await import('/src/shared/timeline/transitions/registry.ts');
    const PAIR = 80;
    const CUT = 40;
    // Only image, video and compound clips take transitions; these are opaque 16x8 PNGs.
    const image = async (texels) => {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext('2d');
      const data = ctx.createImageData(W, H);
      data.data.set(texels.flat().map((v) => Math.round(v * 255)));
      ctx.putImageData(data, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    };
    const sources = { left: await image(sdrLeft), right: await image(sdrRight) };
    const css = ([r, g, b]) => `rgb(${r * 100}%, ${g * 100}%, ${b * 100}%)`;
    const track = (id, order, items) => ({ id, name: id, height: 60, locked: false, visible: true, muted: false,
      solo: false, order, items });
    // One pair per entry, one after another on the same track; lower track order draws on top.
    const composition = (pairs) => {
      const clips = [];
      const layers = [];
      const transitions = [];
      const keyframes = [];
      pairs.forEach((pair, index) => {
        const start = index * PAIR;
        const clip = (side, opacity = 1) => ({
          id: `${pair.name}-${side}`, type: 'image', trackId: 'clips', from: start + (side === 'left' ? 0 : CUT),
          durationInFrames: CUT, label: side, src: sources[side], sourceWidth: W, sourceHeight: H,
          transform: { x: 0, y: 0, width: W, height: H, rotation: 0, opacity },
        });
        clips.push(clip('left', pair.leftOpacity), clip('right'));
        if (pair.transition) {
          transitions.push({ id: `cut-${pair.name}`, type: 'crossfade', timing: 'linear', trackId: 'clips',
            leftClipId: `${pair.name}-left`, rightClipId: `${pair.name}-right`, durationInFrames: 10, alignment: 0.5,
            ...pair.transition });
        }
        if (pair.keyed) {
          keyframes.push({ itemId: `${pair.name}-left`, properties: [{ property: 'opacity', keyframes: [
            { id: 'start', frame: 31, value: 1, easing: 'linear' }, { id: 'end', frame: 39, value: 0, easing: 'linear' }] }] });
        }
        if (pair.layered) {
          // Covers the right half of the frame for the whole pair. Shape edges are soft, so
          // the other three run past the frame and the one inside it is left out of the check.
          layers.push({ id: `${pair.name}-layer`, type: 'shape', trackId: 'layer', from: start, durationInFrames: PAIR,
            label: 'layer', shapeType: 'rectangle', fillColor: css(layer), strokeEnabled: false, strokeWidth: 0,
            blendMode: 'screen',
            transform: { x: W / 4 + 2, y: 0, width: W / 2 + 4, height: H + 8, rotation: 0, opacity: 1 } });
        }
      });
      return { fps: 30, width: W, height: H, durationInFrames: pairs.length * PAIR, backgroundColor: '#000000',
        keyframes, transitions, tracks: [track('layer', 0, layers), track('clips', 1, clips)] };
    };
    const renderPairs = async (pairs) => {
      const canvas = new OffscreenCanvas(W, H);
      const renderer = await createCompositionRenderer(composition(pairs), canvas, canvas.getContext('2d'), { mode: 'export' });
      try {
        await renderer.preload?.();
        const out = {};
        for (const [index, pair] of pairs.entries()) {
          out[pair.name] = {};
          for (const r of pair.frames) {
            // An SDR project's explicit output is its working values, clamped: the pinned reference.
            const { rgba } = await renderer.renderFrameSignal(index * PAIR + r, 'sdr-display');
            out[pair.name][r] = Array.from(rgba);
          }
        }
        return out;
      } finally {
        renderer.dispose();
      }
    };
    // Every frame of `got` is bit-identical to the same frame of `want`.
    const identical = (got, want) => Object.keys(got).every((r) => got[r].length === want[r].length &&
      got[r].every((v, i) => Object.is(v, want[r][i])));
    const WINDOW = [35, 37, 38, 39, 40, 41, 42, 44];
    // Alignment 0 plays the window in the incoming clip (r = 40..49), 1 in the outgoing (r = 30..39).
    const ALIGNED = [30, 33, 36, 39, 40, 43, 46, 49];
    const cases = [];
    for (const id of GPU_TRANSITION_REGISTRY.keys()) {
      const transition = (extra = {}) => ({ presentation: id, ...extra });
      const frames = await renderPairs([
        { name: 'clips', frames: [20, 60] },
        { name: 'valid', transition: transition(), frames: WINDOW },
        { name: 'slow', transition: transition({ durationInFrames: 19 }), frames: RATE.slowFrames },
        { name: 'keyed', transition: transition(), keyed: true, frames: [35, 37] },
        { name: 'static-0.5', transition: transition(), leftOpacity: 0.5, frames: [35] },
        { name: 'static-0.25', transition: transition(), leftOpacity: 0.25, frames: [37] },
        { name: 'layered', transition: transition(), layered: true, frames: [37, 40] },
        { name: 'direction-unknown', transition: transition({ direction: 'sideways' }), frames: WINDOW },
        { name: 'direction-left', transition: transition({ direction: 'from-left' }), frames: WINDOW },
        { name: 'timing-unknown', transition: transition({ timing: 'wobble' }), frames: WINDOW },
        { name: 'duration-fraction', transition: transition({ durationInFrames: 10.7 }), frames: WINDOW },
        { name: 'property-undeclared', transition: transition({ properties: { notAParameter: 5 } }), frames: WINDOW },
        { name: 'alignment-below', transition: transition({ alignment: -3 }), frames: ALIGNED },
        { name: 'alignment-0', transition: transition({ alignment: 0 }), frames: ALIGNED },
        { name: 'alignment-above', transition: transition({ alignment: 7 }), frames: ALIGNED },
        { name: 'alignment-1', transition: transition({ alignment: 1 }), frames: ALIGNED },
      ]);
      cases.push({ id, case: 'animated', gpuTransitionId: transitionRegistry.getRenderer(id)?.gpuTransitionId ?? null,
        clips: { outgoing: frames.clips[20], incoming: frames.clips[60] },
        progress: RATE.frames.map((r) => frames.valid[r]), slow: RATE.slowFrames.map((r) => frames.slow[r]),
        property: 'opacity', keyframes: [[31, 1], [39, 0]], keyed: frames.keyed,
        statics: { 35: frames['static-0.5'][35], 37: frames['static-0.25'][37] },
        unkeyed: { 35: frames.valid[35], 37: frames.valid[37] } });
      cases.push({ id, case: 'composed', second: 'screen', got: frames.layered,
        under: { 37: frames.valid[37], 40: frames.valid[40] } });
      cases.push({ id, case: 'invalid', complete: false, declared: {
        'unknown direction draws as from-left': identical(frames['direction-unknown'], frames['direction-left']),
        'unknown timing draws as linear': identical(frames['timing-unknown'], frames.valid),
        'fractional duration draws as its whole frames': identical(frames['duration-fraction'], frames.valid),
        'undeclared property is ignored': identical(frames['property-undeclared'], frames.valid),
        'alignment below 0 draws as 0': identical(frames['alignment-below'], frames['alignment-0']),
        'alignment above 1 draws as 1': identical(frames['alignment-above'], frames['alignment-1']),
        'alignment moves the window': !identical(frames['alignment-0'], frames['alignment-1']),
      } });
    }
    // An unknown transition id draws a hard cut: exactly the two clips with no transition.
    const unknown = await renderPairs([
      { name: 'cut', frames: WINDOW },
      { name: 'unknown', transition: { presentation: 'not-a-transition' }, frames: WINDOW },
    ]);
    cases.push({ id: '*', case: 'invalid-id', presentation: 'not-a-transition', got: unknown.unknown, cut: unknown.cut });
    return cases;
  }, { W, H, sdrLeft, sdrRight, layer: CASE_LAYER, RATE });
} finally {
  await caseBrowser.close();
}

// Raw measurements for conformance evidence, written before any assertion.
if (process.env.TRANSITION_MATRIX_REPORT) await writeFile(process.env.TRANSITION_MATRIX_REPORT, JSON.stringify(report));
if (explore) process.exit(0);

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const declared = new Map(Object.entries(semantics.transitions));
assert.deepEqual([...declared.keys()].sort(), report.transitions.map((t) => t.id).sort(),
  'transition-semantics.json must declare every registered GPU transition exactly once');
const mirrorPixels = (pixels, axis) => pixels.map((_, k) => {
  const i = Math.floor(k / 4); const c = k % 4; const x = i % W; const y = Math.floor(i / W);
  const j = axis === 'x' ? y * W + (W - 1 - x) : (H - 1 - y) * W + x;
  return pixels[j * 4 + c];
});
const near = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
let frameCount = 0;
for (const transition of report.transitions) {
  const rule = declared.get(transition.id);
  for (const frame of transition.frames) {
    frameCount++;
    const label = `${transition.id} ${frame.direction ?? '-'} @${frame.progress}`;
    for (const route of ['hdr', 'sdrFloat', 'sdr']) check(!frame[route].error, `${label} ${route}: ${frame[route].error}`);
    if (frame.hdr.error || frame.sdrFloat.error || frame.sdr.error) continue;
    check(frame.hdr.pixels.every(Number.isFinite), `${label}: non-finite HDR output`);
    if (frame.hdrAgain) {
      check(frame.hdr.pixels.every((v, i) => Object.is(v, frame.hdrAgain.pixels[i])), `${label}: re-render differs`);
    }
    // SDR project: the float route is Freecut's rgba8unorm route before quantisation.
    const clipped = frame.sdrFloat.pixels.map((v) => Math.min(1, Math.max(0, v)));
    const differing = clipped.filter((v, i) => Math.abs(v - frame.sdr.pixels[i]) > 1.5 / 255 + 1e-3).length;
    check(differing <= (rule.sdrParityBudget ?? 0), `${label}: ${differing} SDR float channels differ from the rgba8 route`);
    if (frame.progress === 0 || frame.progress === 1) {
      const want = frame.progress === 0 ? report.hdrLeft16 : report.hdrRight16;
      check(near(frame.hdr.pixels, want, 1e-6), `${label}: HDR endpoint is not the ${frame.progress ? 'incoming' : 'outgoing'} clip`);
      if (!rule.sdrEndpointOffset) {
        const sdrWant = frame.progress === 0 ? report.sdrLeft16 : report.sdrRight16;
        check(near(frame.sdrFloat.pixels, sdrWant, 2e-3), `${label}: SDR endpoint is not the ${frame.progress ? 'incoming' : 'outgoing'} clip`);
      }
    }
    if (frame.progress === 0.5 && rule.hdrMidpoint === 'extended') {
      check(Math.max(...frame.hdr.pixels.filter((_, k) => k % 4 !== 3)) > 1.01, `${label}: HDR midpoint clipped highlights`);
    }
  }
  if (rule.mirrorSymmetric) {
    for (const [direction, axis, base] of [['from-right', 'x', 'from-left'], ['from-bottom', 'y', 'from-top']]) {
      const mirrored = transition.mirrored?.[direction];
      const original = transition.frames.find((f) => f.direction === base && f.progress === 0.5)?.sdrFloat;
      if (!mirrored || !original || mirrored.error || original.error) continue;
      check(near(mirrorPixels(mirrored.pixels, axis), original.pixels, 2e-3),
        `${transition.id}: ${direction} is not the mirror image of ${base}`);
    }
  }
}

// Per-transition cases through the production renderer.
const same = (got, want) => got.length === want.length && want.every((v, i) => Object.is(v, got[i]));
for (const entry of report.cases) {
  const { id } = entry;
  if (entry.case === 'invalid-id') {
    // The cut is drawn through the canvas route, so it is the clips to 8-bit precision.
    for (const [r, got] of Object.entries(entry.got)) {
      const differing = got.filter((v, k) => Math.abs(v - entry.cut[r][k]) > 1.5 / 255 + 1e-3).length;
      check(differing === 0, `an unknown transition id did not draw a hard cut at r=${r}: ${differing} channels differ`);
    }
  } else if (entry.case === 'animated') {
    check(entry.gpuTransitionId === id, `${id} animated: the renderer does not draw it with the GPU transition`);
    const { progress, slow, clips, keyed, statics, unkeyed } = entry;
    progress.forEach((frame, k) => check(same(slow[k], frame),
      `${id} animated: the 19-frame window at r=${RATE.slowFrames[k]} != the 10-frame window at r=${RATE.frames[k]}`));
    // Progress moves, and the window is a transition rather than either clip.
    check(!same(progress[1], progress[2]), `${id} animated: progress 1/3 and 2/3 drew the same frame`);
    for (const k of [1, 2]) {
      check(!same(progress[k], clips.outgoing) && !same(progress[k], clips.incoming),
        `${id} animated: r=${RATE.frames[k]} is a clip, not a transition`);
    }
    for (const r of [35, 37]) {
      check(same(keyed[r], statics[r]), `${id} animated: keyframed opacity at r=${r} != the static opacity`);
      check(!same(statics[r], unkeyed[r]), `${id} animated: the outgoing clip's opacity did not change r=${r}`);
    }
  } else if (entry.case === 'composed') {
    for (const [r, got] of Object.entries(entry.got)) {
      const under = entry.under[r];
      // The layer covers x >= W / 2; the two columns either side of its soft edge are left out.
      const want = under.map((v, k) => {
        const x = Math.floor(k / 4) % W;
        return x >= W / 2 && k % 4 !== 3 ? 1 - (1 - v) * (1 - CASE_LAYER[k % 4]) : v;
      });
      const inside = (k) => { const x = Math.floor(k / 4) % W; return x < W / 2 - 2 || x > W / 2 + 1; };
      const differing = want.filter((v, k) => inside(k) && Math.abs(v - got[k]) > 3e-3).length;
      check(differing === 0, `${id} composed r=${r}: ${differing} channels != screen over the transition frame`);
      check(!same(got, under), `${id} composed r=${r}: the stacked layer changed nothing`);
    }
  } else if (entry.case === 'invalid') {
    for (const [rule, holds] of Object.entries(entry.declared)) check(holds, `${id} invalid: ${rule}: it does not`);
  }
}
check(report.cases.some((entry) => entry.case === 'invalid-id'), 'no unknown transition id case measured');
for (const { id } of report.transitions) {
  for (const name of ['animated', 'composed', 'invalid']) {
    check(report.cases.some((entry) => entry.id === id && entry.case === name), `${id}: no ${name} case measured`);
  }
}
if (failures.length) {
  console.error(failures.slice(0, 40).join('\n'));
  assert.fail(`${failures.length} transition-matrix failures`);
}
console.log(JSON.stringify({ check: 'every transition and direction: boundaries, SDR route parity, HDR range, mirror symmetry, determinism; animated, composed and declared invalid cases through the renderer',
  transitions: report.transitions.length, frames: frameCount, cases: report.cases.length }));
