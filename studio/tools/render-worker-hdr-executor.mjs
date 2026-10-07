#!/usr/bin/env node
// A bounded, silent HDR10 rectangle-cut recipe, never general HDR worker admission.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeHdrMaster, decodeMaster, validateHdrPlaneSamples } from './hdr-master.mjs';
import { prepareOneClaim } from './render-worker-claim.mjs';
import { loadClaimEngine, publishClaimArtifact } from './render-worker-still-executor.mjs';

const only = (object, keys) =>
  assert.ok(object && Object.keys(object).every((key) => keys.includes(key)), 'UNSUPPORTED_RECIPE_FIELD');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function hdrGraphRecipe(claim) {
  const { quality = 'high', mastering, ...settings } = claim.settings ?? {};
  assert.deepEqual(
    settings,
    {
      format: 'mp4-hevc-main10',
      color: 'hdr10',
      resolution: '720p',
      audio: 'preserve',
    },
    'UNSUPPORTED_HDR_SETTINGS',
  );
  assert.equal(quality, 'high', 'UNSUPPORTED_HDR_QUALITY');
  only(mastering, ['primaries', 'maxNits', 'minNits']);
  assert.ok(
    mastering.primaries === 'bt2020' &&
      [mastering.maxNits, mastering.minNits].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && Number(value.toFixed(4)) === value,
      ) &&
      mastering.maxNits <= 10_000 &&
      mastering.minNits >= 0 &&
      mastering.maxNits > mastering.minNits,
    'MASTERING_REQUIRED',
  );
  assert.deepEqual(
    claim.snapshot?.contract,
    {
      video: { minBitDepth: 10, transfer: 'smpte2084', mastering },
      audio: null,
    },
    'HDR_CONTRACT_CHANGED',
  );
  assert.equal(claim.checkpoints?.length ?? 0, 0, 'RECOVERY_RECIPE_UNAVAILABLE');
  const graph = claim.snapshot.studio.graph;
  only(graph, ['id', 'name', 'description', 'createdAt', 'updatedAt', 'duration', 'metadata', 'timeline']);
  assert.deepEqual(
    graph.metadata,
    {
      width: 1280,
      height: 720,
      fps: 24,
      colorManagement: { workingRange: 'hdr', referenceWhiteNits: 203 },
    },
    'UNSUPPORTED_HDR_CANVAS',
  );
  only(graph.timeline, ['tracks', 'items', 'transitions', 'keyframes']);
  assert.equal(graph.timeline.tracks.length, 1, 'SINGLE_TRACK_REQUIRED');
  const [track] = graph.timeline.tracks;
  only(track, ['id', 'name', 'kind', 'height', 'locked', 'visible', 'muted', 'solo', 'order']);
  assert.ok(
    track.kind === 'video' && track.visible !== false && !track.muted && !track.solo,
    'UNSUPPORTED_TRACK',
  );
  assert.equal(graph.timeline.transitions?.length ?? 0, 0, 'TRANSITIONS_UNSUPPORTED');
  assert.equal(graph.timeline.keyframes?.length ?? 0, 0, 'ANIMATION_UNSUPPORTED');
  assert.ok(graph.timeline.items.length > 0 && graph.timeline.items.length <= 8, 'RECTANGLE_CUT_REQUIRED');
  let frames = 0;
  for (const item of [...graph.timeline.items].sort((a, b) => a.from - b.from)) {
    only(item, [
      'id',
      'type',
      'trackId',
      'from',
      'durationInFrames',
      'label',
      'shapeType',
      'fillColor',
      'strokeEnabled',
      'strokeWidth',
      'transform',
    ]);
    assert.ok(
      item.type === 'shape' &&
        item.shapeType === 'rectangle' &&
        item.trackId === track.id &&
        item.from === frames &&
        Number.isSafeInteger(item.durationInFrames) &&
        item.durationInFrames > 0 &&
        typeof item.fillColor === 'string' &&
        (/^#[\da-f]{6}$/i.test(item.fillColor) ||
          /^rgb\(\d+(?:\.\d+)?%, \d+(?:\.\d+)?%, \d+(?:\.\d+)?%\)$/.test(item.fillColor)) &&
        item.strokeEnabled === false &&
        item.strokeWidth === 0,
      'UNSUPPORTED_RECTANGLE_CUT',
    );
    assert.deepEqual(
      item.transform,
      { x: 0, y: 0, width: 1280, height: 720, rotation: 0, opacity: 1 },
      'UNSUPPORTED_RECTANGLE_TRANSFORM',
    );
    frames += item.durationInFrames;
  }
  // ponytail: buffer at most eight 720p frames; longer graphs need a streaming signal encoder.
  assert.ok(frames <= 8 && graph.duration === frames / 24, 'HDR_FRAME_LIMIT');
  assert.equal(claim.snapshot.timing?.cadence, '24/1', 'UNSUPPORTED_CADENCE');
  assert.equal(claim.snapshot.timing.timeBase, '1/24', 'UNSUPPORTED_TIMEBASE');
  assert.ok(
    claim.snapshot.timing.decision?.mode === 'convert' && claim.snapshot.timing.decision.cadence === '24/1',
    'UNSUPPORTED_TIMING_DECISION',
  );
  assert.equal(claim.snapshot.timing.sources?.length ?? 0, 0, 'SOURCE_TIMING_UNSUPPORTED');
  assert.ok(
    !claim.snapshot.smoothMotion || claim.snapshot.smoothMotion === 'none',
    'SMOOTH_MOTION_UNSUPPORTED',
  );
  const limits = {};
  for (const [key, ceiling] of [
    ['maxWallClockMs', 60_000],
    ['maxOutputBytes', 32 * 1024 * 1024],
  ]) {
    const value = claim.limits?.[key];
    assert.ok(
      value == null || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)),
      'INVALID_RESOURCE_CEILING',
    );
    limits[key] =
      value == null ? ceiling : Number(BigInt(value) < BigInt(ceiling) ? BigInt(value) : BigInt(ceiling));
  }
  return {
    frames,
    mastering: structuredClone(mastering),
    settings: structuredClone(claim.settings),
    maxMs: limits.maxWallClockMs,
    maxBytes: limits.maxOutputBytes,
  };
}

export async function renderHdrGraph(context, consume) {
  const { claim, engineInputs, heartbeat, isLeaseActive, elapsedMs, registerRelease } = context;
  const recipe = hdrGraphRecipe(claim);
  const assertLive = () => {
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    assert.ok(elapsedMs() < recipe.maxMs, 'WALL_CLOCK_LIMIT');
  };
  assertLive();
  const { build, report, require } = await loadClaimEngine(engineInputs);
  assertLive();
  assert.deepEqual(engineInputs.input.project, claim.snapshot.studio.graph, 'IMMUTABLE_GRAPH_CHANGED');
  assert.equal(context.prepared?.inputs.size, 0, 'INTRINSIC_GRAPH_REQUIRED');
  assert.deepEqual(engineInputs.input.media, [], 'INTRINSIC_GRAPH_REQUIRED');
  assert.ok(
    /\bzscale\b/.test(
      execFileSync('ffmpeg', ['-hide_banner', '-filters'], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }).toString(),
    ) &&
      /\blibx265\b/.test(
        execFileSync('ffmpeg', ['-hide_banner', '-encoders'], {
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        }).toString(),
      ),
    'NATIVE_HDR_ENCODER_UNAVAILABLE',
  );
  const { chromium } = require('playwright');
  const { chromeLaunchArgs } = await import(new URL('../engine/headless/lib/cli.mjs', import.meta.url));
  const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-hdr-export-'));
  const output = path.join(folder, 'output.mp4');
  const abort = new AbortController();
  const frames = [];
  let browser;
  let timer;
  let wallTimer;
  let monitoring = false;
  let monitoringDone = Promise.resolve();
  let failure;
  const release = async () => {
    abort.abort();
    await browser?.close();
  };
  registerRelease(release);
  try {
    wallTimer = setTimeout(
      () => {
        failure = new Error('WALL_CLOCK_LIMIT');
        void release();
      },
      Math.max(1, recipe.maxMs - elapsedMs()),
    );
    assertLive();
    browser = await chromium.launch({
      headless: true,
      args: chromeLaunchArgs(),
      timeout: Math.max(1, Math.min(10_000, recipe.maxMs - elapsedMs())),
    });
    assertLive();
    const harness = await engineInputs.createHarness();
    const page = await browser.newPage();
    const origin = new URL(harness.harnessUrl).origin;
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    timer = setInterval(async () => {
      if (monitoring || failure) return;
      monitoring = true;
      let finish;
      monitoringDone = new Promise((resolve) => {
        finish = resolve;
      });
      try {
        await heartbeat();
        assertLive();
        let bytes = 0;
        for (const name of await readdir(folder)) {
          const entry = await stat(path.join(folder, name));
          assert.ok(entry.isFile(), 'UNEXPECTED_OUTPUT_ENTRY');
          bytes += entry.size;
        }
        assert.ok(bytes <= recipe.maxBytes, 'OUTPUT_BYTE_LIMIT');
      } catch (error) {
        failure = error;
        await release();
      } finally {
        monitoring = false;
        finish();
      }
    }, 1000);
    await page.goto(harness.harnessUrl);
    await page.waitForFunction(() => Boolean(window.freecut?.ready), {
      timeout: 10_000,
    });
    const gpu = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            isFallbackAdapter: adapter.isFallbackAdapter ?? adapter.info.isFallbackAdapter,
          }
        : null;
    });
    assert.ok(
      gpu && gpu.isFallbackAdapter === false && !/swiftshader|software|llvmpipe/i.test(JSON.stringify(gpu)),
      'HARDWARE_GPU_REQUIRED',
    );
    for (let frame = 0; frame < recipe.frames; frame++) {
      await heartbeat();
      assertLive();
      const rendered = await page.evaluate(
        async ({ project, frame }) => {
          const result = await window.freecut.renderFrameSignal({
            project,
            media: [],
            frame,
            target: 'pq',
            strict: true,
          });
          return {
            width: result.width,
            height: result.height,
            rgba: Array.from(result.rgba),
            warnings: result.warnings,
          };
        },
        { project: engineInputs.input.project, frame },
      );
      assert.deepEqual(rendered.warnings, [], 'RENDER_WARNING_REFUSED');
      assert.deepEqual(
        [rendered.width, rendered.height, rendered.rgba.length],
        [1280, 720, 1280 * 720 * 4],
        'SIGNAL_FRAME_SIZE_CHANGED',
      );
      assert.ok(rendered.rgba.every(Number.isFinite), 'INVALID_SIGNAL_FRAME');
      frames.push({
        width: rendered.width,
        height: rendered.height,
        rgba: Float32Array.from(rendered.rgba),
      });
    }
    await heartbeat();
    assertLive();
    let qc;
    const encoded = await encodeHdrMaster({
      frames,
      fps: 24,
      transfer: 'pq',
      mastering: recipe.mastering,
      output,
      signal: abort.signal,
      validate: ({ output: partial, probe, light }) => {
        const timeline = JSON.parse(
          execFileSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_streams',
              '-show_packets',
              '-show_entries',
              'stream=codec_type,time_base,start_pts,duration_ts:packet=pts,duration',
              '-of',
              'json',
              partial,
            ],
            { timeout: 10_000, maxBuffer: 1024 * 1024 },
          ),
        );
        assert.equal(timeline.streams.length, 1, 'UNEXPECTED_OUTPUT_STREAM');
        const [stream] = timeline.streams;
        assert.equal(stream.codec_type, 'video', 'UNEXPECTED_OUTPUT_STREAM');
        const [num, den] = stream.time_base.split('/').map(BigInt);
        assert.equal(stream.start_pts, 0, 'OUTPUT_START_CHANGED');
        assert.equal(
          BigInt(stream.duration_ts) * num * 24n,
          BigInt(recipe.frames) * den,
          'OUTPUT_DURATION_CHANGED',
        );
        assert.equal(timeline.packets.length, recipe.frames, 'OUTPUT_PACKET_COUNT_CHANGED');
        timeline.packets
          .sort((a, b) => a.pts - b.pts)
          .forEach((packet, frame) => {
            assert.equal(BigInt(packet.pts) * num * 24n, BigInt(frame) * den, 'OUTPUT_PTS_CHANGED');
            assert.equal(BigInt(packet.duration) * num * 24n, den, 'OUTPUT_CADENCE_CHANGED');
          });
        const planes = decodeMaster('ffmpeg', partial, 1280, 720, 'yuv420p10le');
        const planeSamples = validateHdrPlaneSamples(
          planes,
          1280,
          720,
          frames.map(({ rgba }, frame) => ({
            frame,
            x: 640,
            y: 360,
            rgb: rgba.slice((360 * 1280 + 640) * 4, (360 * 1280 + 640) * 4 + 3),
          })),
        );
        qc = { probe, light, timeline, planeSamples };
      },
    });
    await heartbeat();
    assertLive();
    if (failure) throw failure;
    const file = await stat(output);
    assert.ok(file.isFile() && file.size > 0 && file.size <= recipe.maxBytes, 'OUTPUT_BYTE_LIMIT');
    const bytes = await readFile(output);
    const checksum = digest(bytes);
    bytes.fill(0);
    return await consume({
      outputPath: output,
      checksum,
      sizeInBytes: String(file.size),
      signal: abort.signal,
      recipe,
      ...qc,
      encoderArgs: encoded.args,
      gpu,
      browser: browser.version(),
      sourceSha256: build.sourceSha256,
      artifactSha256: report.artifactSha256,
    });
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearInterval(timer);
    clearTimeout(wallTimer);
    await release();
    await monitoringDone;
    for (const frame of frames) frame.rgba.fill(0);
    await rm(folder, { recursive: true, force: true });
  }
}

export async function executeHdrGraphClaim(context) {
  return renderHdrGraph(context, (artifact) =>
    publishClaimArtifact(context, artifact, 'rectangle-cut-pq-v1'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepareOneClaim({
      serverUrl: process.env.FRAMELEAF_URL,
      sessionToken: process.env.FRAMELEAF_WORKER_SESSION,
      execute: executeHdrGraphClaim,
    });
    console.log(JSON.stringify(result));
    if (!['idle', 'completed'].includes(result.status)) process.exitCode = 1;
  } catch {
    console.error('HDR worker attempt refused; no completion accepted.');
    process.exitCode = 1;
  }
}
