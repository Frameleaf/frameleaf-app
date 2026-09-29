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
if (failures.length) {
  console.error(failures.slice(0, 40).join('\n'));
  assert.fail(`${failures.length} transition-matrix failures`);
}
console.log(JSON.stringify({ check: 'every transition and direction: boundaries, SDR route parity, HDR range, mirror symmetry, determinism',
  transitions: report.transitions.length, frames: frameCount }));
