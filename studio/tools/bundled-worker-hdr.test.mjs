// FL-107: HDR10 and HLG masters on the bundled Studio worker: the recipe, the streaming encoder, the
// decode-back check, the admission probe and an edited export end to end through the executor and
// the container's ffmpeg (skipped only when this ffmpeg has no libx265 or no zscale).
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { createWorkerClient } from './bundled-worker-client.mjs';
import { executeBundledClaim } from './bundled-worker-executor.mjs';
import { listedNames, probeMedia } from './bundled-worker-formats.mjs';
import {
  LUMA_MEAN_TOLERANCE,
  createLightMeter,
  hdrEvidenceToken,
  lumaGrid,
  probeHdrMasters,
  sampledFrames,
  verifyHdrMaster,
  writeHdrMaster,
} from './bundled-worker-hdr.mjs';
import { BundledRefusal, bundledRecipe, hdrMasterOf } from './bundled-worker-recipe.mjs';
import { createEngineRenderer } from './bundled-worker-renderer.mjs';
import { decodeMaster, measureContentLight, probeMaster, toRgb48 } from './hdr-master.mjs';

const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ASSET = '33333333-3333-4333-8333-333333333333';
const MEDIA = Buffer.from('the granted source bytes');

const listed = async (kind) => {
  try {
    return listedNames((await execFileAsync('ffmpeg', ['-hide_banner', kind])).stdout);
  } catch {
    return new Set();
  }
};
const encoders = await listed('-encoders');
const filters = await listed('-filters');
const canMaster = encoders.has('libx265') && filters.has('zscale');
const skip = !canMaster && 'FFmpeg with libx265 and zscale unavailable';

const pqEncode = (nits) => {
  const m1 = 2610 / 16_384;
  const m2 = (2523 / 4096) * 128;
  const c1 = 3424 / 4096;
  const c2 = (2413 / 4096) * 32;
  const c3 = (2392 / 4096) * 32;
  const y = Math.min(Math.max(nits / 10_000, 0), 1) ** m1;
  return ((c1 + c2 * y) / (1 + c3 * y)) ** m2;
};

const W = 64;
const H = 36;
const FPS = 30;
const FRAMES = 60;

/**
 * The "edit" the fake engine renders: a cut at frame 30 between two graded clips on the left, a
 * title whose highlight brightens frame by frame on the right, and a dissolve band in the middle.
 * Straight RGBA signal in the target transfer, as `window.freecut.renderFrameSignal` returns it.
 */
const editedFrame = (frame, transfer) => {
  const rgba = new Float32Array(W * H * 4);
  const signal = (nits) => (transfer === 'pq' ? pqEncode(nits) : Math.min(1, 0.5 * Math.sqrt(nits / 203) + 0.25));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let rgb;
      if (x < 24) rgb = frame < 30 ? [signal(400), signal(300), signal(120)] : [signal(80), signal(140), signal(260)];
      else if (x < 40) {
        const t = frame / (FRAMES - 1);
        rgb = [signal(100 * (1 - t) + 600 * t), signal(100), signal(100 * t)];
      } else rgb = y < H / 2 ? [signal(200 + 10 * frame), signal(200 + 10 * frame), signal(203)] : [signal(5), signal(5), signal(5)];
      rgba.set([...rgb, x >= 60 ? 0.5 : 1], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, rgba };
};

const signalRenderer = ({ renders = [], signals = [], deterministic = true } = {}) => ({
  softwareRenderer: false,
  writers: { [hdrEvidenceToken('pq')]: 'libx265', [hdrEvidenceToken('hlg')]: 'libx265' },
  encoders: [...encoders],
  // The engine's ordinary render: only its sound is used for an HDR master.
  async render(job) {
    renders.push(job);
    const { width, height } = job.settings.resolution;
    const seconds = (job.bounds.outPoint - job.bounds.inPoint) / FPS;
    const result = spawnSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${FPS}:d=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-ac', '2', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-f', 'mp4', job.outputPath,
    ]);
    assert.equal(result.status, 0, String(result.stderr));
  },
  async *renderSignalFrames({ bounds, target, files }) {
    signals.push({ bounds, target });
    assert.ok(files.has(ASSET), 'the signal render reads the granted media');
    for (let frame = bounds.inPoint; frame < bounds.outPoint; frame++) {
      const rendered = editedFrame(frame, target);
      if (!deterministic && signals.length > 1 && frame === bounds.inPoint) rendered.rgba[0] = 1;
      yield { width: rendered.width, height: rendered.height, rgb48: toRgb48(rendered) };
    }
  },
});

const hdrClaim = (transfer, overrides = {}) => {
  const operationId = randomUUID();
  const mastering = { maxNits: 1000, minNits: 0.005 };
  return {
    operationId,
    kind: 'studio_export',
    claimToken: randomUUID(),
    leaseMs: 90_000,
    attempt: 1,
    artifactInputDigest: 'c'.repeat(64),
    snapshot: {
      timing: { cadence: `${FPS}/1`, timeBase: '1/30000', sources: [] },
      contract: {
        video: {
          minBitDepth: 10,
          transfer: transfer === 'pq' ? 'smpte2084' : 'arib-std-b67',
          ...(transfer === 'pq' && { mastering }),
        },
        audio: { policy: 'preserve', channels: 2, channelLayout: 'stereo', sampleRate: 48_000 },
      },
      studio: {
        graph: {
          metadata: { width: W, height: H, fps: FPS, frameRate: { num: FPS, den: 1 }, colorManagement: { workingRange: 'hdr' } },
          timeline: {
            tracks: [{ id: 'v1' }, { id: 'a1' }],
            items: [
              { id: 'v', trackId: 'v1', type: 'video', mediaId: ASSET, from: 0, durationInFrames: FRAMES },
              { id: 'a', trackId: 'a1', type: 'audio', mediaId: ASSET, from: 0, durationInFrames: FRAMES },
              { id: 't', trackId: 'v1', type: 'text', text: 'Title', from: 10, durationInFrames: 30 },
            ],
            transitions: [],
          },
        },
        resources: [],
      },
    },
    settings: {
      format: 'mp4-hevc-main10',
      color: transfer === 'pq' ? 'hdr10' : 'preserve',
      resolution: '1080p',
      quality: 'high',
      audio: 'preserve',
      subtitleMode: 'burn',
      ...(transfer === 'pq' && { mastering }),
    },
    checkpoints: [],
    inputs: [
      {
        inputId: `library-asset:${ASSET}`,
        kind: 'library-asset',
        resourceId: ASSET,
        checksum: sha256(MEDIA),
        url: `/api/render-workers/operations/${operationId}/inputs/grant.token`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    ],
    limits: { maxWallClockMs: null, maxOutputBytes: null },
    ...overrides,
  };
};

let folder;
before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'fl107-hdr-worker-'));
});
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('HDR master recipe', () => {
  const writers = signalRenderer().writers;

  it('turns HDR10 and HLG claims into an HDR pass at the project size, with sound from the engine', () => {
    const pq = bundledRecipe(hdrClaim('pq'), { softwareRenderer: false, writers });
    assert.equal(pq.pass, 'hdr');
    assert.deepEqual(pq.hdr, { transfer: 'pq', mastering: { maxNits: 1000, minNits: 0.005 }, cadence: '30/1' });
    assert.deepEqual(pq.dimensions, { width: W, height: H });
    assert.equal(pq.encoder, 'libx265');
    assert.equal(pq.target.codec, 'hevc');
    const hlg = bundledRecipe(hdrClaim('hlg'), { softwareRenderer: false, writers });
    assert.deepEqual(hlg.hdr, { transfer: 'hlg', mastering: null, cadence: '30/1' });
    assert.notEqual(pq.configDigest, hlg.configDigest);
  });

  it('reads the transfer only from the sealed contract', () => {
    assert.equal(hdrMasterOf('mp4-hevc-main10', 'preserve', { video: { transfer: null } }), null);
    assert.equal(hdrMasterOf('mp4-hevc', 'hdr10', { video: { transfer: 'smpte2084' } }), null);
    assert.equal(hdrMasterOf('mp4-hevc-main10', 'hdr10', { video: { transfer: 'arib-std-b67' } }), null);
    assert.equal(hdrMasterOf('mp4-hevc-main10', 'preserve', { video: { transfer: 'smpte2084', mastering: { maxNits: 1, minNits: 0 } } }).transfer, 'pq');
  });

  const refusals = [
    ['a transfer its admission did not prove', 'hlg', (claim) => claim, { [hdrEvidenceToken('pq')]: 'libx265' }, 'unsupported_format', /HLG masters/],
    ['HDR10 without a mastering display', 'pq', (claim) => delete claim.snapshot.contract.video.mastering, writers, 'invalid_mastering', /mastering display/],
    ['a downscaled HDR master', 'pq', (claim) => (claim.snapshot.studio.graph.metadata = { ...claim.snapshot.studio.graph.metadata, width: 3840, height: 2160 }), writers, 'hdr_resolution', /project size/],
    ['HDR10 in an 8-bit format', 'pq', (claim) => (claim.settings.format = 'mp4-hevc'), writers, 'unsupported_color', /MP4 · HEVC Main10/],
    ['HLG sources in an 8-bit format', 'hlg', (claim) => (claim.settings.format = 'mkv-hevc'), writers, 'hdr_unsupported', /MP4 · HEVC Main10/],
    ['Main10 of an SDR project', 'hlg', (claim) => (claim.snapshot.contract.video = { minBitDepth: 10, transfer: null }), writers, 'needs_10bit', /HDR10 or HLG master/],
    ['Dolby Vision', 'pq', (claim) => (claim.settings.color = 'dolby-vision'), writers, 'unsupported_color', /Dolby Vision/],
    [
      'captions turned off on an HDR master',
      'hlg',
      (claim) => {
        claim.settings.subtitleMode = 'off';
        claim.snapshot.studio.graph.timeline.items.push({ id: 's', trackId: 'v1', type: 'subtitle', from: 0, durationInFrames: 10, cues: [] });
      },
      writers,
      'subtitles_unsupported',
      /draws the project captions/,
    ],
  ];
  for (const [name, transfer, change, writerMap, code, message] of refusals) {
    it(`refuses ${name}`, () => {
      const claim = hdrClaim(transfer);
      change(claim);
      assert.throws(
        () => bundledRecipe(claim, { softwareRenderer: false, writers: writerMap }),
        (error) => error instanceof BundledRefusal && error.code === code && message.test(error.message),
      );
    });
  }
});

describe('HDR master measurements', () => {
  it('measures CTA-861.3 light on the encoded 16-bit samples like the float measurement', () => {
    const frames = [0, 29, 59].map((frame) => editedFrame(frame, 'pq'));
    const meter = createLightMeter();
    for (const frame of frames) meter.add(toRgb48(frame), W, H);
    const fromSamples = meter.result();
    const fromFloat = measureContentLight(frames);
    assert.ok(Math.abs(fromSamples.maxCll - fromFloat.maxCll) <= 1, JSON.stringify({ fromSamples, fromFloat }));
    assert.ok(Math.abs(fromSamples.maxFall - fromFloat.maxFall) <= 1);
    assert.ok(fromSamples.maxCll > 203, 'the edit carries light above reference white');
  });

  it('reads luma codes from an aligned or unaligned rgb48 frame', () => {
    const white = toRgb48({ width: 2, height: 2, rgba: new Float32Array(16).fill(1) });
    assert.deepEqual([...lumaGrid(white, 2, 2, 1)], [940, 940, 940, 940]);
    const shifted = Buffer.concat([Buffer.alloc(1), white]).subarray(1);
    assert.deepEqual([...lumaGrid(shifted, 2, 2, 1)], [940, 940, 940, 940]);
    assert.deepEqual(sampledFrames(1), [0]);
    assert.deepEqual(sampledFrames(60), [0, 29, 59]);
  });
});

describe('HDR master encode and decode-back', { skip }, () => {
  const framesOf = (transfer, count = 12) => () =>
    (async function* () {
      for (let frame = 0; frame < count; frame++) yield { width: W, height: H, rgb48: toRgb48(editedFrame(frame, transfer)) };
    })();

  it('writes a verified PQ master whose static metadata is the measured light', async () => {
    const output = path.join(folder, 'pq.mp4');
    const { light, verified } = await writeHdrMaster({
      renderFrames: framesOf('pq'),
      frameCount: 12,
      width: W,
      height: H,
      fps: '30000/1001',
      transfer: 'pq',
      mastering: { maxNits: 1000, minNits: 0.005 },
      output,
    });
    const probe = probeMaster('ffprobe', output);
    assert.equal(Number(probe.contentLight.max_content), light.maxCll);
    assert.equal(probe.rFrameRate, '30000/1001');
    assert.equal(verified.frames, 12);
    for (const error of Object.values(verified.lumaMeanError)) assert.ok(error <= LUMA_MEAN_TOLERANCE);
  });

  it('refuses a master whose signalling or picture is not what was rendered', async () => {
    const output = path.join(folder, 'hlg.mp4');
    const written = await writeHdrMaster({
      renderFrames: framesOf('hlg'),
      frameCount: 12,
      width: W,
      height: H,
      fps: '30/1',
      transfer: 'hlg',
      output,
    });
    const references = new Map([[0, lumaGrid(toRgb48(editedFrame(0, 'hlg')), W, H)]]);
    const base = { file: output, width: W, height: H, frameCount: 12, references };
    // The HLG file is not a PQ master.
    await assert.rejects(
      verifyHdrMaster({ ...base, transfer: 'pq', light: written.light ?? { maxCll: 1, maxFall: 1 }, mastering: { maxNits: 1000, minNits: 0.005 } }),
      /signalling mismatch/,
    );
    // Its picture is not a different render (a transfer applied twice would look like this).
    const wrong = new Map([[0, lumaGrid(toRgb48(editedFrame(0, 'pq')), W, H)]]);
    await assert.rejects(verifyHdrMaster({ ...base, transfer: 'hlg', references: wrong }), /luma codes on average/);
    // Nor a different length.
    await assert.rejects(verifyHdrMaster({ ...base, transfer: 'hlg', frameCount: 13 }), /count\/size mismatch/);
    const ok = await verifyHdrMaster({ ...base, transfer: 'hlg' });
    assert.equal(ok.frames, 12);
  });

  it('refuses a PQ master when the engine renders different light on its encoding pass', async () => {
    let pass = 0;
    await assert.rejects(
      writeHdrMaster({
        renderFrames: () => {
          pass++;
          return (async function* () {
            for (let frame = 0; frame < 4; frame++) {
              const rendered = editedFrame(frame, 'pq');
              if (pass === 2) rendered.rgba.fill(pqEncode(900), 0, 3);
              yield { width: W, height: H, rgb48: toRgb48(rendered) };
            }
          })();
        },
        frameCount: 4,
        width: W,
        height: H,
        fps: '30/1',
        transfer: 'pq',
        mastering: { maxNits: 1000, minNits: 0.005 },
        output: path.join(folder, 'unstable.mp4'),
      }),
      /different light/,
    );
  });

  it('admission proves both transfers on this ffmpeg and reports ten-bit HDR10 precision', async () => {
    const masters = await probeHdrMasters({ encoders, filters });
    assert.deepEqual(masters.transfers, ['pq', 'hlg'], JSON.stringify(masters.refused));
    assert.deepEqual(masters.formats, ['mp4-hevc-main10', 'mp4-hevc-main10+pq', 'mp4-hevc-main10+hlg']);
    assert.deepEqual(masters.colorPrecision, { maxBitDepth: 10, hdr10: true, dolbyVision: false });
    for (const transfer of ['pq', 'hlg']) {
      assert.ok(masters.proven[transfer].worstInverseRgbCodes <= 1.66, `${transfer} precision`);
      assert.ok(masters.proven[transfer].rampLumaCodes >= 512, `${transfer} ten-bit ramp`);
    }
  });

  it('admission refuses a transfer whose decode-back fails, and keeps the other', async () => {
    // An ffprobe that reports every stream as BT.709: no master can pass its signalling check.
    const wrapper = path.join(folder, 'ffprobe-bt709');
    await writeFile(wrapper, '#!/bin/sh\nexec ffprobe "$@" | sed -e s/bt2020/bt709/g\n');
    spawnSync('chmod', ['755', wrapper]);
    const masters = await probeHdrMasters({ ffprobe: wrapper, encoders, filters });
    assert.deepEqual(masters.transfers, []);
    assert.equal(masters.colorPrecision, null);
    assert.match(masters.refused.pq, /signalling mismatch/);
  });
});

/* ------------------------------------------------------------------ */
/* Edited HDR exports end to end through the executor                    */
/* ------------------------------------------------------------------ */

const fakeServer = async (claim) => {
  const calls = [];
  const uploads = [];
  const root = `/api/render-workers/operations/${claim.operationId}`;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const route = request.url.split('?')[0];
    const body = Buffer.concat(chunks);
    calls.push({ route, body: request.method === 'POST' && body.length > 0 ? JSON.parse(body) : null });
    response.setHeader('Content-Type', 'application/json');
    if (route === `${root}/heartbeat`) return response.end(JSON.stringify({ leaseExtended: true, leaseMs: 90_000 }));
    if (route.startsWith(`${root}/inputs/`)) return response.end(MEDIA);
    if (route === `${root}/artifacts/0`) uploads.push({ query: new URL(request.url, 'http://x').searchParams, body });
    response.end(JSON.stringify({ accepted: true, refusal: null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, uploads, close: () => new Promise((resolve) => server.close(resolve)) };
};

const execute = async (claim, renderer) => {
  const server = await fakeServer(claim);
  const workRoot = await mkdtemp(path.join(folder, 'work-'));
  try {
    const client = createWorkerClient({ serverUrl: server.url, sessionToken: 'session-token' });
    const result = await executeBundledClaim(claim, { client, renderer, probe: (file) => probeMedia(file), workRoot, maxInputBytes: 1024 ** 3 });
    return { result, server };
  } finally {
    await server.close();
    await rm(workRoot, { recursive: true, force: true });
  }
};

describe('bundled worker executor: edited HDR10 and HLG exports', { skip }, () => {
  for (const transfer of ['pq', 'hlg']) {
    it(`completes an edited ${transfer === 'pq' ? 'HDR10' : 'HLG'} export and uploads a decodable Main10 master`, async () => {
      const claim = hdrClaim(transfer);
      const renders = [];
      const signals = [];
      const { result, server } = await execute(claim, signalRenderer({ renders, signals }));
      assert.equal(result.status, 'completed', JSON.stringify(server.calls.find((call) => call.route.endsWith('/fail'))?.body));
      // PQ measures its light on a first pass; both transfers render every frame of the range.
      assert.deepEqual(signals.map((pass) => pass.target), transfer === 'pq' ? ['pq', 'pq'] : ['hlg']);
      assert.ok(signals.every((pass) => pass.bounds.inPoint === 0 && pass.bounds.outPoint === FRAMES));
      // The engine's ordinary render only supplied the sound, at the smallest picture (never upscaled).
      assert.equal(renders.length, 1);
      assert.deepEqual(renders[0].settings.resolution, { width: W, height: H });
      assert.equal(server.uploads.length, 1);
      assert.equal(server.uploads[0].query.get('checksum'), sha256(server.uploads[0].body));
      assert.ok(server.calls.some((call) => call.route.endsWith('/complete')));

      // Independent decode-back of the uploaded bytes.
      const file = path.join(folder, `${transfer}-export.mp4`);
      await writeFile(file, server.uploads[0].body);
      const probe = probeMaster('ffprobe', file);
      assert.deepEqual(
        [probe.codec, probe.profile, probe.pixFmt, probe.primaries, probe.transfer, probe.matrix, probe.range, probe.frames],
        ['hevc', 'Main 10', 'yuv420p10le', 'bt2020', transfer === 'pq' ? 'smpte2084' : 'arib-std-b67', 'bt2020nc', 'tv', FRAMES],
      );
      const rendered = Array.from({ length: FRAMES }, (_, frame) => editedFrame(frame, transfer));
      if (transfer === 'pq') {
        const light = measureContentLight(rendered);
        assert.ok(Math.abs(Number(probe.contentLight.max_content) - light.maxCll) <= 1);
        assert.ok(Math.abs(Number(probe.contentLight.max_average) - light.maxFall) <= 1);
        assert.equal(probe.mastering.max_luminance, '10000000/10000');
      } else {
        assert.equal(probe.contentLight, undefined, 'HLG carries no static metadata');
      }
      const media = await probeMedia(file);
      const audio = media.streams.find((stream) => stream.codec_type === 'audio');
      assert.equal(audio.codec_name, 'aac');
      assert.equal(audio.channels, 2);
      // The cut lands where the edit put it: frame 29 and 30 differ on the left, by many codes.
      const planes = decodeMaster('ffmpeg', file, W, H, 'yuv420p10le');
      assert.equal(planes.length, FRAMES);
      const left = (frame) => planes[frame][(H / 2) * W + 8];
      assert.ok(Math.abs(left(29) - left(30)) > 40, `cut at frame 30 (${left(29)} → ${left(30)})`);
      assert.ok(Math.abs(left(0) - left(29)) <= 2, 'the clip before the cut is steady');
    });
  }

  it('refuses content brighter than the declared mastering display, with the reason', async () => {
    const claim = hdrClaim('pq');
    claim.snapshot.contract.video.mastering = { maxNits: 400, minNits: 0.005 };
    claim.settings.mastering = claim.snapshot.contract.video.mastering;
    const { result, server } = await execute(claim, signalRenderer());
    assert.equal(result.code, 'hdr_mastering_exceeded');
    assert.match(server.calls.find((call) => call.route.endsWith('/fail')).body.error, /above the 400 cd\/m² mastering display/);
    assert.equal(server.uploads.length, 0);
  });

  it('passes the engine’s HDR refusal through without uploading anything', async () => {
    const renderer = signalRenderer();
    renderer.renderSignalFrames = async function* () {
      yield* [];
      throw new BundledRefusal('hdr_unsupported', 'The Studio engine cannot render this project as HDR yet (Blend mode is not migrated).');
    };
    const { result, server } = await execute(hdrClaim('hlg'), renderer);
    assert.equal(result.code, 'hdr_unsupported');
    assert.equal(server.uploads.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* The renderer's float-route frames                                    */
/* ------------------------------------------------------------------ */

describe('renderer: float-route signal frames', () => {
  /**
   * A stand-in prepared engine whose page answers `renderFrameSignal` the way the pinned harness
   * route is driven: `{ width, height, base64 (rgb48le), warnings }` per absolute frame.
   */
  const fakeEngine = async (script) => {
    const dir = await mkdtemp(path.join(folder, 'engine-'));
    const write = async (file, text) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    };
    await write('package.json', '{"name":"engine","type":"module"}');
    await write('dist/headless.html', '<html></html>');
    await write(
      'node_modules/playwright/index.js',
      `const script = ${script};
      module.exports.chromium = { launch: async () => ({
        newPage: async () => ({
          route: async () => {}, goto: async () => {}, waitForFunction: async () => {}, exposeBinding: async () => {},
          evaluate: async (_fn, arg) => (arg && 'frame' in arg ? script(arg) : null),
        }),
        close: async () => {},
      }) };`,
    );
    await write(
      'headless/server.mjs',
      "export const createHarnessServer = async () => ({ harnessUrl: 'http://127.0.0.1:1/', mediaUrl: (id) => 'http://127.0.0.1:1/media/' + id, close: async () => {} });",
    );
    await write('headless/lib/cli.mjs', 'export const chromeLaunchArgs = () => [];');
    await write('headless/lib/render-core.mjs', 'export const renderJob = async () => ({});');
    return dir;
  };
  const project = { metadata: { width: 2, height: 2 }, timeline: { tracks: [], items: [] } };
  const drain = async (iterable) => {
    const frames = [];
    for await (const frame of iterable) frames.push(frame);
    return frames;
  };

  it('yields each frame of the range as rgb48 in order, asking the engine for the requested transfer', async () => {
    const engineDir = await fakeEngine(`({ frame, target, media }) => {
      if (target !== 'hlg' || media[0]?.mediaId !== 'm') throw new Error('wrong request');
      const samples = new Uint16Array(12).fill(frame * 1000);
      return { width: 2, height: 2, base64: Buffer.from(samples.buffer).toString('base64'), warnings: [] };
    }`);
    const renderer = await createEngineRenderer({ engineDir });
    const frames = await drain(
      renderer.renderSignalFrames({ project, files: new Map([['m', '/dev/null']]), bounds: { inPoint: 3, outPoint: 6 }, target: 'hlg' }),
    );
    assert.deepEqual(
      frames.map((frame) => frame.rgb48.readUInt16LE(0)),
      [3000, 4000, 5000],
    );
    assert.ok(frames.every((frame) => frame.width === 2 && frame.height === 2 && frame.rgb48.byteLength === 24));
  });

  for (const [name, script, code] of [
    ['an engine HDR refusal', "() => { throw new Error('HdrRenderUnavailableError: Blend mode is not migrated to linear HDR working colour'); }", 'hdr_unsupported'],
    ['a missing GPU float route', "() => { throw new Error('Signal rendering requires WebGPU'); }", 'hdr_needs_gpu'],
    ['an engine warning', "() => ({ width: 2, height: 2, base64: '', warnings: ['FONT_FALLBACK'] })", 'render_warning'],
  ]) {
    it(`turns ${name} into a refusal`, async () => {
      const renderer = await createEngineRenderer({ engineDir: await fakeEngine(script) });
      await assert.rejects(
        drain(renderer.renderSignalFrames({ project, files: new Map(), bounds: { inPoint: 0, outPoint: 2 }, target: 'pq' })),
        (error) => error instanceof BundledRefusal && error.code === code,
      );
    });
  }
});
