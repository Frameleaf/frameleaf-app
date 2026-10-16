// FL-408: the bundled Studio worker's recipe, protocol client and executor, against a fake server.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checksumOf, createWorkerClient, holdLease, serverOrigin } from './bundled-worker-client.mjs';
import { executeBundledClaim } from './bundled-worker-executor.mjs';
import {
  BundledRefusal,
  avDrift,
  bundledRecipe,
  frameTicks,
  outputDimensions,
  outputMismatch,
} from './bundled-worker-recipe.mjs';
import { NO_TRUST_VOLUME, readTrust, trustVolumeMounted, workerConfig, workingMemoryBytes } from './bundled-worker.mjs';
import { isSoftwareAdapter, toneWav } from './bundled-worker-renderer.mjs';

const GIB = 1024 ** 3;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ASSET = '11111111-1111-4111-8111-111111111111';
const MEDIA = Buffer.from('not really a video, but the bytes the grant serves');

const graph = (items) => ({
  metadata: { width: 1920, height: 1080, fps: 30, frameRate: { num: 30, den: 1 } },
  duration: 4,
  timeline: {
    tracks: [{ id: 'v1' }, { id: 'a1' }],
    items: items ?? [
      { id: 'v', trackId: 'v1', type: 'video', mediaId: ASSET, from: 0, durationInFrames: 120 },
      { id: 'a', trackId: 'a1', type: 'audio', mediaId: ASSET, from: 0, durationInFrames: 120 },
      { id: 't', trackId: 'v1', type: 'text', text: 'Title', from: 10, durationInFrames: 60 },
    ],
    transitions: [],
  },
});

const claimOf = (overrides = {}) => {
  const operationId = randomUUID();
  return {
    operationId,
    kind: 'studio_export',
    claimToken: randomUUID(),
    leaseMs: 90_000,
    projectId: 'project',
    revisionId: 'revision',
    attempt: 1,
    artifactInputDigest: 'a'.repeat(64),
    snapshot: {
      engineDigest: 'engine',
      timing: { cadence: '30/1', timeBase: '1/30000', sources: [] },
      contract: { video: { minBitDepth: 8, transfer: null }, audio: { policy: 'preserve', channels: 2, channelLayout: 'stereo', sampleRate: 48_000 } },
      studio: { revision: 1, graph: graph(), resources: [] },
    },
    settings: { format: 'mp4-h264', color: 'preserve', resolution: '720p', quality: 'high', audio: 'preserve', subtitleMode: 'off' },
    checkpoints: [],
    inputs: [
      {
        inputId: `library-asset:${ASSET}`,
        kind: 'library-asset',
        resourceId: ASSET,
        checksum: sha256(MEDIA),
        url: `/api/render-workers/operations/${operationId}/inputs/grant.token-1`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    ],
    limits: { maxWallClockMs: null, maxOutputBytes: null },
    ...overrides,
  };
};

describe('bundled worker recipe', () => {
  it('renders the whole timeline at the requested resolution with exact checkpoint timing', () => {
    const recipe = bundledRecipe(claimOf(), { softwareRenderer: true });
    assert.deepEqual(recipe.settings.resolution, { width: 1280, height: 720 });
    assert.equal(recipe.settings.codec, 'avc');
    assert.equal(recipe.settings.videoBitrate, 10_000_000);
    assert.equal(recipe.settings.subtitleMode, 'off');
    assert.deepEqual(recipe.bounds, { inPoint: 0, outPoint: 120 });
    assert.equal(recipe.frames, 120);
    assert.equal(recipe.endTicks, '120000');
    assert.equal(recipe.timebase, '1/30000');
    assert.deepEqual([...recipe.mediaIds], [ASSET]);
    // the same claim always plans the same checkpoint, so a restarted attempt can reuse it
    assert.equal(bundledRecipe(claimOf(), { softwareRenderer: true }).chunkKey, recipe.chunkKey);
  });

  it('honours a declared range', () => {
    const claim = claimOf();
    claim.settings.range = { inPoint: 30, outPoint: 90 };
    const recipe = bundledRecipe(claim, { softwareRenderer: false });
    assert.deepEqual(recipe.bounds, { inPoint: 30, outPoint: 90 });
    assert.equal(recipe.endTicks, '60000');
  });

  const refusals = [
    ['a format it does not write', (claim) => (claim.settings.format = 'avi-mpeg4'), 'unsupported_format'],
    ['a 10-bit format', (claim) => (claim.settings.format = 'webm-av1'), 'needs_10bit'],
    ['HDR colour', (claim) => (claim.settings.color = 'hdr10'), 'unsupported_color'],
    ['an HDR source picture', (claim) => (claim.snapshot.contract.video = { minBitDepth: 10, transfer: 'arib-std-b67' }), 'hdr_unsupported'],
    ['a still image', (claim) => (claim.snapshot.contract.image = { format: 'sdr-jpeg' }), 'unsupported_format'],
    ['a subtitle file without its seal', (claim) => (claim.settings.subtitleMode = 'sidecar'), 'subtitles_unsupported'],
    ['captions on sound alone', (claim) => Object.assign(claim.settings, { format: 'audio-mp3', subtitleMode: 'burn' }), 'subtitles_unsupported'],
    ['a nested composition', (claim) => claim.snapshot.studio.graph.timeline.items.push({ id: 'c', type: 'composition', from: 0, durationInFrames: 10 }), 'unsupported_item'],
    ['an animation', (claim) => claim.snapshot.studio.graph.timeline.items.push({ id: 'l', type: 'lottie', mediaId: ASSET, from: 0, durationInFrames: 10 }), 'unsupported_item'],
    ['generated media', (claim) => (claim.snapshot.studio.graph.timeline.items[0].generatedId = 'g'), 'unsupported_source'],
    ['a range outside the timeline', (claim) => (claim.settings.range = { inPoint: 100, outPoint: 500 }), 'invalid_range'],
    ['a time base the range does not divide', (claim) => (claim.snapshot.timing.timeBase = '7/1'), 'invalid_timing'],
    ['no exact cadence', (claim) => delete claim.snapshot.timing.cadence, 'invalid_timing'],
    ['an unknown quality', (claim) => (claim.settings.quality = 'lossless'), 'unsupported_quality'],
  ];
  for (const [name, change, code] of refusals) {
    it(`refuses ${name} with a reason`, () => {
      const claim = claimOf();
      change(claim);
      assert.throws(
        () => bundledRecipe(claim, { softwareRenderer: false }),
        (error) => error instanceof BundledRefusal && error.code === code && error.message.length > 10,
      );
    });
  }

  it('refuses effects on a software renderer, and renders them on a GPU', () => {
    const claim = claimOf();
    claim.snapshot.studio.graph.timeline.items[0].effects = [{ type: 'blur', enabled: true }];
    assert.throws(() => bundledRecipe(claim, { softwareRenderer: true }), { code: 'effects_need_gpu' });
    assert.ok(bundledRecipe(claim, { softwareRenderer: false }));
    claim.snapshot.studio.graph.timeline.items[0].effects = [{ type: 'blur', enabled: false }];
    assert.ok(bundledRecipe(claim, { softwareRenderer: true }));
  });

  it('scales from the canvas without upscaling, keeping even dimensions', () => {
    assert.deepEqual(outputDimensions({ width: 1080, height: 1920 }, '720p'), { width: 720, height: 1280 });
    assert.deepEqual(outputDimensions({ width: 1280, height: 720 }, '2160p'), { width: 1280, height: 720 });
    assert.deepEqual(outputDimensions({ width: 1001, height: 701 }, 'original'), { width: 1002, height: 702 });
    assert.throws(() => outputDimensions({ width: 1, height: 1 }, '8k'), { code: 'unsupported_resolution' });
  });

  it('computes ticks only when they are whole', () => {
    assert.equal(frameTicks(120, { num: 30000, den: 1001 }, { num: 1, den: 30000 }), 120_120);
    assert.equal(frameTicks(1, { num: 30, den: 1 }, { num: 1, den: 7 }), null);
  });

  it('checks the encoded streams against what the export promised', () => {
    const recipe = bundledRecipe(claimOf(), { softwareRenderer: true });
    const video = { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '4.000000' };
    const audio = { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '4.021333' };
    const of = (...streams) => ({ streams, format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } });
    assert.equal(outputMismatch(recipe, of(video, audio)), null);
    assert.match(outputMismatch(recipe, of({ ...video, codec_name: 'vp9' }, audio)), /h264/);
    assert.match(outputMismatch(recipe, { ...of(video, audio), format: { format_name: 'matroska,webm' } }), /not mp4/);
    assert.match(outputMismatch(recipe, of({ ...video, width: 640 }, audio)), /640/);
    assert.match(outputMismatch(recipe, of(video)), /no audio/);
    assert.match(outputMismatch(recipe, of(video, { ...audio, channels: 1 })), /2-channel/);
    assert.match(outputMismatch(recipe, of(video, { ...audio, duration: '4.075000' })), /end more than a frame apart/);
    assert.ok(avDrift([video, { ...audio, duration: '4.075000' }], 30).excess > 0);
    assert.equal(avDrift([video], 30), null);
  });
});

describe('bundled worker client', () => {
  it('accepts only a bare server origin', () => {
    assert.equal(serverOrigin('http://frameleaf-server:2283').href, 'http://frameleaf-server:2283/');
    assert.throws(() => serverOrigin('http://user:pass@server:2283'));
    assert.throws(() => serverOrigin('http://server:2283/?x=1'));
    assert.throws(() => serverOrigin('file:///etc/passwd'));
  });

  it('reads declared SHA-1 and SHA-256 checksums in hex or base64', () => {
    const digest = createHash('sha256').update('x').digest();
    assert.equal(checksumOf(digest.toString('hex')).algorithm, 'sha256');
    assert.equal(checksumOf(digest.toString('base64')).algorithm, 'sha256');
    assert.equal(checksumOf(createHash('sha1').update('x').digest('hex')).algorithm, 'sha1');
    assert.equal(checksumOf(null), null);
    assert.throws(() => checksumOf('not a digest'));
  });
});

describe('bundled worker configuration', () => {
  it('is on by default and can be turned off', () => {
    assert.equal(workerConfig({}).enabled, true);
    assert.equal(workerConfig({}).serverUrl, 'http://frameleaf-server:2283');
    assert.equal(workerConfig({}).trustFile, '/run/frameleaf/studio-worker/enrolment.json');
    for (const value of ['false', 'FALSE', '0', 'off', 'no']) assert.equal(workerConfig({ FRAMELEAF_STUDIO_WORKER: value }).enabled, false);
  });

  it('declares half the memory, at most 8 GiB, in whole GiB', () => {
    assert.equal(workingMemoryBytes(null, 32 * GIB), 8n * BigInt(GIB));
    assert.equal(workingMemoryBytes(null, 7.5 * GIB), 3n * BigInt(GIB));
    assert.equal(workingMemoryBytes(null, 3 * GIB), 1n * BigInt(GIB));
    assert.equal(workingMemoryBytes(6n * BigInt(GIB), 64 * GIB), 6n * BigInt(GIB));
  });

  it('reads only a complete enrolment', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'fl408-trust-'));
    try {
      const file = path.join(folder, 'enrolment.json');
      assert.equal(await readTrust(file), null);
      await writeFile(file, '{"version":1,"workerId":"w"');
      assert.equal(await readTrust(file), null);
      await writeFile(file, JSON.stringify({ version: 1, workerId: 'w', enrolmentSecret: 's' }));
      assert.deepEqual(await readTrust(file), { version: 1, workerId: 'w', enrolmentSecret: 's' });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('reports plainly that it cannot enrol without the shared volume (ML on another host)', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'fl408-trust-'));
    try {
      assert.equal(await trustVolumeMounted(path.join(folder, 'enrolment.json')), true);
      assert.equal(await trustVolumeMounted(path.join(folder, 'missing', 'enrolment.json')), false);
      await writeFile(path.join(folder, 'file'), '');
      assert.equal(await trustVolumeMounted(path.join(folder, 'file', 'enrolment.json')), false);
      assert.match(NO_TRUST_VOLUME, /^Cannot enrol: .*another host cannot enrol, so Studio stays unavailable/);
      assert.match(NO_TRUST_VOLUME, /FRAMELEAF_STUDIO_WORKER=false/);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('treats an unknown or fallback adapter as software', () => {
    assert.equal(isSoftwareAdapter(null), true);
    assert.equal(isSoftwareAdapter({ isFallbackAdapter: true, vendor: 'nvidia' }), true);
    assert.equal(isSoftwareAdapter({ isFallbackAdapter: false, vendor: 'mesa', architecture: 'llvmpipe' }), true);
    assert.equal(isSoftwareAdapter({ isFallbackAdapter: null, vendor: 'nvidia' }), true);
    assert.equal(isSoftwareAdapter({ isFallbackAdapter: false, vendor: 'nvidia', architecture: 'ampere' }), false);
    assert.equal(toneWav({ seconds: 0.5 }).length, 44 + 24_000 * 4);
  });
});

/** A fake render-worker API that records every call and answers like the server. */
const fakeServer = async (claim, { media = MEDIA, heartbeat = () => ({}) } = {}) => {
  const calls = [];
  const uploads = [];
  const root = `/api/render-workers/operations/${claim.operationId}`;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const route = request.url.split('?')[0];
    calls.push({ method: request.method, route, session: request.headers['x-frameleaf-worker-session'], body: body.length && request.method === 'POST' ? JSON.parse(body) : null });
    const json = (value) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    };
    if (request.headers['x-frameleaf-worker-session'] !== 'session-token') {
      response.statusCode = 401;
      return response.end();
    }
    if (route === `${root}/heartbeat`) return json({ leaseExtended: true, leaseMs: 90_000, cancelRequested: false, pauseRequested: false, refusal: null, ...heartbeat(calls) });
    if (route.startsWith(`${root}/inputs/`)) return response.end(media);
    if (route === `${root}/artifacts/0` && request.method === 'PUT') {
      uploads.push({ query: new URL(request.url, 'http://x').searchParams, body, claimToken: request.headers['x-render-claim-token'] });
      return json({ accepted: true, refusal: null });
    }
    if (route.startsWith(root)) return json({ accepted: true, refusal: null });
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, uploads, close: () => new Promise((resolve) => server.close(resolve)) };
};

const fakeRenderer = ({ softwareRenderer = true, fail, onRender } = {}) => {
  const renders = [];
  return {
    softwareRenderer,
    renders,
    async render(job) {
      renders.push(job);
      await onRender?.(job);
      if (fail) throw fail;
      const bytes = await readFile(job.files.get(ASSET));
      assert.deepEqual(bytes, MEDIA, 'the renderer reads the verified grant bytes');
      await writeFile(job.outputPath, 'encoded export');
      job.onProgress(0.5);
    },
  };
};

const streams = async () => ({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, duration: '4.000000' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', duration: '4.010000' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
});

describe('bundled worker executor', () => {
  let workRoot;
  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(os.tmpdir(), 'fl408-work-'));
  });
  afterEach(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  const run = async (claim, server, renderer, extra = {}) => {
    const client = createWorkerClient({ serverUrl: server.url, sessionToken: 'session-token' });
    return executeBundledClaim(claim, { client, renderer, probe: streams, workRoot, maxInputBytes: GIB, ...extra });
  };
  const routes = (server, claim) =>
    server.calls.map(({ method, route }) => `${method} ${route.replace(`/api/render-workers/operations/${claim.operationId}`, '')}`);

  it('plans, reads its grants, renders, uploads, validates and completes', async () => {
    const claim = claimOf();
    const server = await fakeServer(claim);
    const renderer = fakeRenderer();
    try {
      const result = await run(claim, server, renderer);
      assert.equal(result.status, 'completed');
      const order = routes(server, claim).filter((route) => !route.endsWith('/heartbeat'));
      assert.deepEqual(order, [
        'POST /checkpoints',
        'GET /inputs/grant.token-1',
        'POST /progress',
        'POST /progress',
        'PUT /artifacts/0',
        'POST /validate',
        'POST /complete',
      ]);
      const plan = server.calls.find((call) => call.route.endsWith('/checkpoints')).body;
      const recipe = bundledRecipe(claim, { softwareRenderer: true });
      assert.deepEqual(
        { sequence: plan.sequence, chunkKey: plan.chunkKey, inputDigest: plan.inputDigest, timebase: plan.timebase, endTicks: plan.endTicks },
        { sequence: 0, chunkKey: recipe.chunkKey, inputDigest: claim.artifactInputDigest, timebase: '1/30000', endTicks: '120000' },
      );
      const [upload] = server.uploads;
      assert.equal(upload.claimToken, claim.claimToken);
      assert.equal(upload.query.get('checksum'), sha256('encoded export'));
      assert.equal(upload.query.get('sizeInBytes'), String('encoded export'.length));
      assert.deepEqual(server.calls.find((call) => call.route.endsWith('/complete')).body, {
        claimToken: claim.claimToken,
        artifactSequence: 0,
        resultAssetId: null,
      });
      assert.ok(server.calls.every((call) => call.session === 'session-token'));
      assert.deepEqual(renderer.renders[0].bounds, { inPoint: 0, outPoint: 120 });
    } finally {
      await server.close();
    }
  });

  it('reports a claim it cannot render with a stable code and reason, without planning it', async () => {
    const claim = claimOf();
    claim.settings.format = 'prores-422-hq';
    const server = await fakeServer(claim);
    try {
      const result = await run(claim, server, fakeRenderer());
      assert.deepEqual(result, { status: 'refused', operationId: claim.operationId, code: 'needs_10bit' });
      const fail = server.calls.find((call) => call.route.endsWith('/fail'));
      assert.equal(fail.body.errorCode, 'bundled_needs_10bit');
      assert.match(fail.body.error, /10-bit picture.*Choose ProRes 422/);
      assert.ok(!server.calls.some((call) => call.route.endsWith('/checkpoints')));
    } finally {
      await server.close();
    }
  });

  it('reuses the artifact a lost attempt finished instead of rendering it again', async () => {
    const claim = claimOf();
    const { chunkKey } = bundledRecipe(claim, { softwareRenderer: true });
    claim.checkpoints = [{ id: 'c', sequence: 0, state: 'complete', chunkKey }];
    claim.attempt = 2;
    const server = await fakeServer(claim);
    const renderer = fakeRenderer();
    try {
      assert.equal((await run(claim, server, renderer)).status, 'completed');
      assert.equal(renderer.renders.length, 0);
      assert.equal(server.uploads.length, 0);
      const order = routes(server, claim).filter((route) => !route.endsWith('/heartbeat'));
      assert.deepEqual(order, ['POST /checkpoints', 'POST /validate', 'POST /complete']);
    } finally {
      await server.close();
    }
  });

  it('refuses media whose bytes do not match the granted checksum', async () => {
    const claim = claimOf();
    const server = await fakeServer(claim, { media: Buffer.from('changed bytes') });
    const renderer = fakeRenderer();
    try {
      const result = await run(claim, server, renderer);
      assert.equal(result.code, 'input_changed');
      assert.equal(server.calls.find((call) => call.route.endsWith('/fail')).body.errorCode, 'bundled_input_changed');
      assert.equal(renderer.renders.length, 0);
    } finally {
      await server.close();
    }
  });

  it('refuses inputs over its byte budget', async () => {
    const claim = claimOf();
    const server = await fakeServer(claim);
    try {
      const result = await run(claim, server, fakeRenderer(), { maxInputBytes: 4 });
      assert.equal(result.code, 'inputs_too_large');
    } finally {
      await server.close();
    }
  });

  it('refuses a resource kind it cannot render', async () => {
    const claim = claimOf();
    claim.inputs.push({ ...claim.inputs[0], inputId: 'lut:x', kind: 'lut', resourceId: 'x' });
    const server = await fakeServer(claim);
    try {
      assert.equal((await run(claim, server, fakeRenderer())).code, 'unsupported_resource');
    } finally {
      await server.close();
    }
  });

  it('reports an engine refusal with its reason', async () => {
    const claim = claimOf();
    const server = await fakeServer(claim);
    try {
      const failure = new BundledRefusal('effects_need_gpu', 'This project uses effects, and the bundled Studio worker has no GPU.');
      const result = await run(claim, server, fakeRenderer({ fail: failure }));
      assert.equal(result.code, 'effects_need_gpu');
      assert.match(server.calls.find((call) => call.route.endsWith('/fail')).body.error, /no GPU/);
    } finally {
      await server.close();
    }
  });

  it('acknowledges a cancel and stops rendering instead of reporting a failure', async () => {
    const claim = claimOf();
    let cancelled = false;
    const server = await fakeServer(claim, { heartbeat: () => (cancelled ? { cancelRequested: true } : {}) });
    const renderer = fakeRenderer({
      onRender: async (job) => {
        cancelled = true;
        await new Promise((resolve) => job.signal.addEventListener('abort', resolve, { once: true }));
        throw job.signal.reason;
      },
    });
    try {
      const result = await run(claim, server, renderer, { heartbeatIntervalMs: 250 });
      assert.equal(result.status, 'cancelled');
      const ack = server.calls.find((call) => call.route.endsWith('/cancel-ack'));
      assert.deepEqual(ack.body, { claimToken: claim.claimToken, released: true });
      assert.ok(!server.calls.some((call) => call.route.endsWith('/fail')));
      assert.equal(server.uploads.length, 0);
    } finally {
      await server.close();
    }
  });

  it('stops quietly when the server takes the claim back (pause or lost lease)', async () => {
    const claim = claimOf();
    let paused = false;
    const server = await fakeServer(claim, { heartbeat: () => (paused ? { pauseRequested: true } : {}) });
    const renderer = fakeRenderer({
      onRender: async (job) => {
        paused = true;
        await new Promise((resolve) => job.signal.addEventListener('abort', resolve, { once: true }));
        throw job.signal.reason;
      },
    });
    try {
      const result = await run(claim, server, renderer, { heartbeatIntervalMs: 250 });
      assert.equal(result.status, 'paused');
      assert.ok(!server.calls.some((call) => call.route.endsWith('/fail') || call.route.endsWith('/complete')));
    } finally {
      await server.close();
    }
  });
});

describe('lease', () => {
  it('reports lease loss when heartbeats stop being acknowledged past the deadline', async () => {
    let now = 0;
    const client = { post: async () => ({ leaseExtended: false, leaseMs: 90_000 }) };
    const lease = holdLease({ client, operationId: 'o', claimToken: 't', leaseMs: 1000, intervalMs: 60_000, now: () => now });
    await assert.rejects(lease.beat(), /LEASE_LOST/);
    assert.equal(lease.state.reason, 'LEASE_LOST');
    lease.release();
    now = 5000;
  });
});
