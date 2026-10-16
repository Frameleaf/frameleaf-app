// FL-105 / FL-408: the bundled worker's container × codec matrix, encoded for real with this
// machine's ffmpeg from a tiny synthetic master and read back with ffprobe.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { createWorkerClient } from './bundled-worker-client.mjs';
import { executeBundledClaim } from './bundled-worker-executor.mjs';
import {
  BUNDLED_FORMATS,
  EMBEDDED_PROFILE,
  SIDECAR_PROFILE,
  audioPlan,
  encodeArgs,
  formatMismatch,
  listedNames,
  probeExportMatrix,
  probeMedia,
  runFfmpeg,
  streamSeconds,
} from './bundled-worker-formats.mjs';
import { BundledRefusal, bundledRecipe, sealedCaptions } from './bundled-worker-recipe.mjs';
import { prepareSidecarPlan } from '../runtime/subtitle-sidecar.mjs';

const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ASSET = '22222222-2222-4222-8222-222222222222';
const SRT = '1\n00:00:00,100 --> 00:00:00,600\nHello\n';
const MEDIA = Buffer.from('the granted source bytes');

const encoders = listedNames((await execFileAsync('ffmpeg', ['-hide_banner', '-encoders'])).stdout);
const muxers = listedNames((await execFileAsync('ffmpeg', ['-hide_banner', '-muxers'])).stdout);
const writable = (format) =>
  muxers.has(format.muxer) && format.encoders.some((name) => name === 'copy' || encoders.has(name));

let folder;
let master;
let srt;
before(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'fl105-matrix-'));
  master = path.join(folder, 'master.mp4');
  srt = path.join(folder, 'captions.srt');
  await writeFile(srt, SRT);
  // The engine's master: 1 s of 320×180 H.264 at 30 fps with stereo 48 kHz AAC.
  await execFileAsync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', master,
  ]);
});
after(async () => {
  await rm(folder, { recursive: true, force: true });
});

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe('bundled worker formats: every combination, encoded and probed', () => {
  for (const [id, format] of Object.entries(BUNDLED_FORMATS)) {
    for (const captions of format.kind === 'video' ? [false, true] : [false]) {
      it(`${id}${captions ? ' with a caption track' : ''}`, { skip: !writable(format) && `this ffmpeg cannot write ${id}` }, async () => {
        const output = path.join(folder, `${id}${captions ? '-captions' : ''}${format.extension}`);
        const encoder = format.encoders.find((name) => name === 'copy' || encoders.has(name));
        const masterAudio = (await probeMedia(master)).streams.find((stream) => stream.codec_type === 'audio');
        const audio = audioPlan(format, masterAudio, encoders);
        await runFfmpeg(encodeArgs({ input: master, output, format, encoder, quality: 'low', audio, ...(captions && { subtitles: srt }) }));
        const probed = await probeMedia(output);
        const width = format.kind === 'video' ? 320 : undefined;
        assert.equal(formatMismatch(format, probed, { width, height: width && 180, audio: true, textTrack: captions }), null);

        const video = probed.streams.find((stream) => stream.codec_type === 'video');
        const sound = probed.streams.find((stream) => stream.codec_type === 'audio');
        const text = probed.streams.find((stream) => stream.codec_type === 'subtitle');
        if (format.kind === 'video') {
          assert.equal(video.codec_name, format.codec);
          near(video.duration, 1, 0.05);
          if (format.codec === 'prores') {
            assert.equal(video.pix_fmt, 'yuv422p10le');
            assert.equal(video.profile, 'Standard');
          } else {
            assert.equal(video.pix_fmt, 'yuv420p');
          }
        } else {
          assert.equal(video, undefined);
        }
        assert.equal(sound.channels, 2);
        assert.equal(Number(sound.sample_rate), 48_000);
        near(sound.duration, 1, 0.1);
        if (captions) {
          assert.equal(text.codec_name, format.textTrack);
          assert.equal(text.tags?.language ?? 'und', 'und'); // Matroska and MOV omit an undetermined language
          assert.equal(text.disposition.default, 1);
          // The track decodes back to the same cue the server sealed.
          const { stdout } = await execFileAsync('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:s:0', '-c:s', 'srt', '-f', 'srt', 'pipe:1']);
          assert.match(stdout, /00:00:00,100 --> 00:00:00,600\r?\nHello/);
        } else {
          assert.equal(text, undefined);
        }
      });
    }
  }

  it('picks Opus for 48 kHz WebM sound and refuses a rate neither Opus nor Vorbis can keep', () => {
    const webm = BUNDLED_FORMATS['webm-vp9'];
    assert.equal(audioPlan(webm, { sample_rate: '48000' }, new Set(['libopus'])).encoder, 'libopus');
    assert.equal(audioPlan(webm, { sample_rate: '44100' }, new Set(['libopus', 'libvorbis'])).encoder, 'libvorbis');
    assert.match(audioPlan(webm, { sample_rate: '44100' }, new Set(['libopus'])).refusal, /44100 Hz.*MKV or MP4/);
    assert.deepEqual(audioPlan(BUNDLED_FORMATS['mkv-vp9'], { sample_rate: '44100' }, new Set()).args, ['-c:a', 'copy']);
    assert.deepEqual(audioPlan(BUNDLED_FORMATS['mov-prores-422'], { sample_rate: '48000' }, new Set()).args, ['-c:a', 'pcm_s16le']);
    assert.deepEqual(audioPlan(webm, null, new Set()).args, []);
    // The engine copies an untouched WAV's PCM into its master: MP4 and M4A get AAC, MOV/MKV keep it.
    const pcm = { codec_name: 'pcm_s16le', sample_rate: '48000' };
    assert.deepEqual(audioPlan(BUNDLED_FORMATS['mp4-hevc'], pcm, new Set()).args, ['-c:a', 'aac', '-b:a', '320k']);
    assert.equal(audioPlan(BUNDLED_FORMATS['audio-aac'], pcm, new Set()).encoder, 'aac');
    assert.deepEqual(audioPlan(BUNDLED_FORMATS['audio-aac'], { ...pcm, codec_name: 'aac' }, new Set()).args, ['-c:a', 'copy']);
    assert.deepEqual(audioPlan(BUNDLED_FORMATS['mkv-vp9'], pcm, new Set()).args, ['-c:a', 'copy']);
  });

  it('reads Matroska durations from their tag', () => {
    assert.equal(streamSeconds({ tags: { DURATION: '00:00:04.021000000' } }), 4.021);
    assert.equal(streamSeconds({ duration: '2.5' }), 2.5);
    assert.equal(streamSeconds({}), null);
  });

  it('names the container a file really is', () => {
    const mp4 = BUNDLED_FORMATS['mp4-h264'];
    const streams = [{ codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }];
    assert.match(formatMismatch(mp4, { streams, format: { format_name: 'matroska,webm' } }), /not mp4/);
    assert.equal(formatMismatch(mp4, { streams, format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }), null);
    assert.match(formatMismatch(BUNDLED_FORMATS['mkv-vp9'], { streams, format: { format_name: 'matroska,webm' } }), /vp9/);
  });
});

describe('bundled worker admission evidence', () => {
  it('advertises exactly the combinations it wrote and read back, with caption profiles', async () => {
    const evidence = await probeExportMatrix({ master });
    for (const [id, format] of Object.entries(BUNDLED_FORMATS)) {
      if (writable(format)) {
        assert.ok(evidence.formats.includes(id), `${id} is advertised (${evidence.refused[id] ?? ''})`);
        assert.ok(evidence.formats.includes(format.container));
      } else {
        assert.ok(!evidence.formats.includes(id), `${id} is not advertised`);
        assert.ok(evidence.refused[id], `${id} says why not`);
      }
    }
    assert.ok(evidence.codecs.includes('webcodecs-avc') && evidence.codecs.includes('aac'));
    if (encoders.has('libx265')) assert.equal(evidence.writers['mp4-hevc'], 'libx265');
    if (encoders.has('prores_ks')) assert.equal(evidence.writers['mov-prores-422'], 'prores_ks');
    assert.equal(evidence.writers['mkv-h264'], 'copy');
    for (const track of ['mov_text', 'subrip', 'webvtt']) assert.ok(evidence.codecs.includes(track), track);
    assert.ok(evidence.formats.includes(SIDECAR_PROFILE) && evidence.formats.includes(EMBEDDED_PROFILE));
    // Never the 10-bit formats: the bundled worker renders an 8-bit picture.
    for (const id of ['mp4-hevc-main10', 'webm-av1', 'prores-422-hq']) assert.ok(!evidence.formats.includes(id));
  });

  it('does not advertise a format whose encoder this ffmpeg lacks, and says why', async () => {
    // An ffmpeg that lists no libx265 and no ProRes encoder.
    const wrapper = path.join(folder, 'ffmpeg-without-x265');
    await writeFile(
      wrapper,
      `#!/bin/sh\nif [ "$2" = "-encoders" ]; then ffmpeg "$@" | grep -v -e libx265 -e prores_ks; exit 0; fi\nexec ffmpeg "$@"\n`,
    );
    await chmod(wrapper, 0o755);
    const evidence = await probeExportMatrix({ master, ffmpeg: wrapper });
    for (const id of ['mp4-hevc', 'mov-hevc', 'mkv-hevc', 'mov-prores-422']) {
      assert.ok(!evidence.formats.includes(id), id);
      assert.match(evidence.refused[id], /no (libx265|prores_ks) encoder/);
    }
    assert.ok(!evidence.codecs.includes('libx265'));
    assert.ok(evidence.formats.includes('mkv-h264'));
  });
});

/* ------------------------------------------------------------------ */
/* Executor, end to end through ffmpeg                                  */
/* ------------------------------------------------------------------ */

const captionGraph = () => ({
  metadata: { width: 320, height: 180, fps: 30, frameRate: { num: 30, den: 1 } },
  duration: 1,
  timeline: {
    tracks: [{ id: 'v1' }, { id: 'a1' }, { id: 's1' }],
    items: [
      { id: 'v', trackId: 'v1', type: 'video', mediaId: ASSET, from: 0, durationInFrames: 30 },
      { id: 'a', trackId: 'a1', type: 'audio', mediaId: ASSET, from: 0, durationInFrames: 30 },
      {
        id: 'c',
        trackId: 's1',
        type: 'subtitle',
        from: 0,
        durationInFrames: 30,
        source: { type: 'subtitle-import' },
        cues: [{ id: 'q', startSeconds: 0.1, endSeconds: 0.6, text: 'Hello' }],
      },
    ],
    transitions: [],
  },
});

const sealOf = (graph) => {
  const plan = prepareSidecarPlan({ tracks: graph.timeline.tracks, items: graph.timeline.items, fps: 30, frameRate: { num: 30, den: 1 } });
  return { plan, seal: { expectedSrtSha256: sha256(plan.content), sizeInBytes: String(Buffer.byteLength(plan.content)), cueCount: plan.cueCount } };
};

const claimFor = (format, extra = {}) => {
  const operationId = randomUUID();
  const graph = captionGraph();
  return {
    operationId,
    kind: 'studio_export',
    claimToken: randomUUID(),
    leaseMs: 90_000,
    attempt: 1,
    artifactInputDigest: 'b'.repeat(64),
    snapshot: {
      timing: { cadence: '30/1', timeBase: '1/30000', sources: [] },
      contract: { video: { minBitDepth: 8, transfer: null }, audio: { policy: 'preserve', channels: 2, channelLayout: 'stereo', sampleRate: 48_000 } },
      studio: { graph },
    },
    settings: { format, color: 'preserve', resolution: '720p', quality: 'low', audio: 'preserve', subtitleMode: 'burn', ...extra },
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
  };
};

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

/** A renderer that "renders" the synthetic master, at whatever size the recipe asked for. */
const masterRenderer = (renders = [], audioCodec = 'copy') => ({
  softwareRenderer: true,
  writers: undefined,
  encoders: [...encoders],
  async render(job) {
    renders.push(job);
    const { width, height } = job.settings.resolution;
    await runFfmpeg(['-v', 'error', '-y', '-i', master, '-vf', `scale=${width}:${height}`, '-c:v', 'libx264', '-c:a', audioCodec, '-f', 'mp4', job.outputPath]);
  },
});

const execute = async (claim, renderer = masterRenderer()) => {
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

const uploadedProbe = async (upload, extension) => {
  const file = path.join(folder, `${randomUUID()}${extension}`);
  await writeFile(file, upload.body);
  return probeMedia(file);
};

describe('bundled worker executor: formats, sound and captions', () => {
  for (const format of ['mkv-vp9', 'mov-prores-422', 'webm-av1-sdr', 'mp4-hevc', 'mov-h264']) {
    it(`renders ${format} through its second pass and uploads what it promised`, { skip: !writable(BUNDLED_FORMATS[format]) }, async () => {
      const claim = claimFor(format);
      const renders = [];
      const { result, server } = await execute(claim, masterRenderer(renders));
      assert.equal(result.status, 'completed', JSON.stringify(server.calls.find((call) => call.route.endsWith('/fail'))?.body));
      assert.equal(server.uploads.length, 1);
      const probed = await uploadedProbe(server.uploads[0], BUNDLED_FORMATS[format].extension);
      assert.equal(probed.streams.find((stream) => stream.codec_type === 'video').codec_name, BUNDLED_FORMATS[format].codec);
      assert.equal(server.uploads[0].query.get('checksum'), sha256(server.uploads[0].body));
      // A re-encoded format starts from a high-bitrate master; a stream copy from the requested quality.
      const expectedBitrate = BUNDLED_FORMATS[format].encoders[0] === 'copy' ? 2_500_000 : 20_000_000;
      assert.equal(renders[0].settings.videoBitrate, expectedBitrate);
    });
  }

  for (const format of ['audio-mp3', 'audio-aac', 'audio-wav']) {
    it(`exports ${format} as one sound stream with no picture`, { skip: !writable(BUNDLED_FORMATS[format]) }, async () => {
      const claim = claimFor(format, { subtitleMode: undefined });
      delete claim.settings.subtitleMode;
      const renders = [];
      const { result, server } = await execute(claim, masterRenderer(renders));
      assert.equal(result.status, 'completed', JSON.stringify(server.calls.find((call) => call.route.endsWith('/fail'))?.body));
      assert.deepEqual(renders[0].settings.resolution, { width: 256, height: 144 });
      const probed = await uploadedProbe(server.uploads[0], BUNDLED_FORMATS[format].extension);
      assert.deepEqual(probed.streams.map((stream) => stream.codec_type), ['audio']);
      assert.equal(probed.streams[0].codec_name, BUNDLED_FORMATS[format].codec);
      assert.equal(probed.streams[0].channels, 2);
      near(probed.streams[0].duration, 1, 0.1);
    });
  }

  it('encodes AAC when the engine copied a source PCM track into its master', async () => {
    for (const format of ['audio-aac', 'mp4-hevc']) {
      if (!writable(BUNDLED_FORMATS[format])) continue;
      const claim = claimFor(format);
      if (format === 'audio-aac') delete claim.settings.subtitleMode;
      const { result, server } = await execute(claim, masterRenderer([], 'pcm_s16le'));
      assert.equal(result.status, 'completed', JSON.stringify(server.calls.find((call) => call.route.endsWith('/fail'))?.body));
      const probed = await uploadedProbe(server.uploads[0], BUNDLED_FORMATS[format].extension);
      assert.equal(probed.streams.find((stream) => stream.codec_type === 'audio').codec_name, 'aac');
    }
  });

  it('refuses a sound-only export of a silent project', async () => {
    const claim = claimFor('audio-wav');
    delete claim.settings.subtitleMode;
    claim.snapshot.contract.audio = null;
    const { result, server } = await execute(claim);
    assert.equal(result.code, 'no_audio');
    assert.match(server.calls.find((call) => call.route.endsWith('/fail')).body.error, /no sound/);
  });

  it('uploads the sealed SRT as the sidecar sibling and keeps captions out of the picture', async () => {
    const claim = claimFor('mkv-h264', { subtitleMode: 'sidecar' });
    const { plan, seal } = sealOf(claim.snapshot.studio.graph);
    claim.settings.subtitleSeal = seal;
    claim.snapshot.contract.subtitles = seal;
    const renders = [];
    const { result, server } = await execute(claim, masterRenderer(renders));
    assert.equal(result.status, 'completed', JSON.stringify(server.calls.find((call) => call.route.endsWith('/fail'))?.body));
    assert.equal(renders[0].settings.subtitleMode, 'off');
    assert.deepEqual(server.uploads.map((upload) => upload.query.get('role')), [null, 'subtitle']);
    const [, sibling] = server.uploads;
    assert.equal(sibling.body.toString('utf8'), plan.content);
    assert.equal(sibling.query.get('checksum'), seal.expectedSrtSha256);
    assert.equal(sibling.query.get('sizeInBytes'), seal.sizeInBytes);
  });

  for (const format of ['mp4-h264', 'mov-h264', 'mkv-vp9', 'webm-vp9']) {
    it(`embeds the sealed captions as ${format}'s own text track`, { skip: !writable(BUNDLED_FORMATS[format]) }, async () => {
      const claim = claimFor(format, { subtitleMode: 'embedded' });
      const target = BUNDLED_FORMATS[format];
      const { seal } = sealOf(claim.snapshot.studio.graph);
      claim.settings.embeddedSubtitleSeal = { container: target.container, codec: target.textTrack, source: seal };
      claim.snapshot.contract.embeddedSubtitles = claim.settings.embeddedSubtitleSeal;
      const renders = [];
      const { result, server } = await execute(claim, masterRenderer(renders));
      assert.equal(result.status, 'completed', JSON.stringify(server.calls.find((call) => call.route.endsWith('/fail'))?.body));
      assert.equal(renders[0].settings.subtitleMode, 'off');
      assert.equal(server.uploads.length, 1);
      const probed = await uploadedProbe(server.uploads[0], target.extension);
      const text = probed.streams.filter((stream) => stream.codec_type === 'subtitle');
      assert.equal(text.length, 1);
      assert.equal(text[0].codec_name, target.textTrack);
    });
  }

  it('refuses captions that no longer match their seal, and a track the container cannot carry', () => {
    const claim = claimFor('mkv-h264', { subtitleMode: 'sidecar' });
    claim.settings.subtitleSeal = { expectedSrtSha256: 'f'.repeat(64), sizeInBytes: '1' };
    assert.throws(() => bundledRecipe(claim, { softwareRenderer: false }), { code: 'captions_changed' });
    const embedded = claimFor('webm-vp9', { subtitleMode: 'embedded' });
    embedded.settings.embeddedSubtitleSeal = { container: 'mp4', codec: 'mov_text', source: sealOf(embedded.snapshot.studio.graph).seal };
    assert.throws(() => bundledRecipe(embedded, { softwareRenderer: false }), (error) => error instanceof BundledRefusal && error.code === 'subtitles_unsupported' && /WEBM/.test(error.message));
    const sound = claimFor('audio-mp3', { subtitleMode: 'burn' });
    assert.throws(() => bundledRecipe(sound, { softwareRenderer: false }), { code: 'subtitles_unsupported' });
  });

  it('refuses a format its admission check did not verify', () => {
    const claim = claimFor('mp4-hevc');
    assert.throws(() => bundledRecipe(claim, { softwareRenderer: false, writers: { 'mp4-h264': 'copy' } }), {
      code: 'unsupported_format',
    });
  });

  it('produces the same captions the server seals', async (t) => {
    let server;
    try {
      server = await import('../../server/dist/utils/studio-subtitle-sidecar.js');
    } catch {
      t.skip('build the server for the cross-check');
      return;
    }
    const graph = captionGraph();
    const seal = server.sealStudioSidecar(graph, { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(40) });
    assert.equal(sealedCaptions(graph, undefined, { num: 30, den: 1 }, seal), server.buildStudioSidecarSemanticPlan(graph).content);
    const range = { inPoint: 6, outPoint: 30 };
    const ranged = server.sealStudioSidecar(graph, { revisionDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), engineDigest: 'c'.repeat(40) }, range);
    assert.equal(sealedCaptions(graph, range, { num: 30, den: 1 }, ranged), server.buildStudioSidecarSemanticPlan(graph, range).content);
  });
});
