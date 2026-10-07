#!/usr/bin/env node
// One immutable, silent SDR still-image export. No enrollment or background daemon.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareOneClaim } from './render-worker-claim.mjs';
import { inventory } from './engine.mjs';
const engine = fileURLToPath(new URL('../engine/', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const only = (object, keys) =>
  assert.ok(
    object && Object.keys(object).every((key) => keys.includes(key)),
    'UNSUPPORTED_RECIPE_FIELD',
  );

/** An explicit first recipe, not general Studio/FL-107 capability admission. */
export function stillRecipe(claim) {
  const { format, quality = 'high', range, subtitleMode, ...settings } = claim.settings ?? {};
  assert.ok(format === 'mp4-h264' || format === 'mov-h264', 'UNSUPPORTED_EXPORT_SETTINGS');
  // Same four bitrate presets as the pinned engine's headless render core.
  const bitrates = { low: 2_500_000, medium: 5_000_000, high: 10_000_000, ultra: 20_000_000 };
  assert.ok(typeof quality === 'string' && Object.hasOwn(bitrates, quality), 'UNSUPPORTED_EXPORT_QUALITY');
  assert.ok(subtitleMode === undefined || subtitleMode === 'burn' || subtitleMode === 'off',
    'UNSUPPORTED_SUBTITLE_MODE');
  assert.deepEqual(
    settings,
    { color: 'preserve', resolution: '720p', audio: 'preserve' },
    'UNSUPPORTED_EXPORT_SETTINGS',
  );
  assert.equal(claim.checkpoints?.length ?? 0, 0, 'RECOVERY_RECIPE_UNAVAILABLE');
  const graph = claim.snapshot?.studio?.graph;
  only(graph, [
    'id',
    'name',
    'description',
    'createdAt',
    'updatedAt',
    'duration',
    'metadata',
    'timeline',
  ]);
  only(graph.metadata, ['width', 'height', 'fps']);
  assert.deepEqual(graph.metadata, { width: 1280, height: 720, fps: 24 }, 'UNSUPPORTED_CANVAS');
  only(graph.timeline, ['tracks', 'items', 'transitions', 'keyframes']);
  assert.equal(graph.timeline.tracks.length, 1, 'SINGLE_TRACK_REQUIRED');
  const track = graph.timeline.tracks[0];
  only(track, ['id', 'name', 'kind', 'height', 'locked', 'visible', 'muted', 'solo', 'order']);
  assert.ok(
    track.kind === 'video' && track.visible !== false && !track.muted && !track.solo,
    'UNSUPPORTED_TRACK',
  );
  assert.equal(graph.timeline.items.length, 1, 'SINGLE_STILL_REQUIRED');
  const item = graph.timeline.items[0];
  only(item, ['id', 'type', 'mediaId', 'trackId', 'from', 'durationInFrames']);
  assert.ok(
    item.type === 'image' &&
      item.trackId === track.id &&
      item.from === 0 &&
      typeof item.mediaId === 'string' &&
      Number.isSafeInteger(item.durationInFrames) &&
      item.durationInFrames >= 1 &&
      item.durationInFrames <= 240,
    'UNSUPPORTED_STILL',
  );
  assert.equal(graph.duration, item.durationInFrames / 24, 'INCONSISTENT_DURATION');
  assert.equal(graph.timeline.transitions?.length ?? 0, 0, 'TRANSITIONS_UNSUPPORTED');
  assert.equal(graph.timeline.keyframes?.length ?? 0, 0, 'ANIMATION_UNSUPPORTED');
  assert.equal(claim.snapshot.contract?.video?.minBitDepth, 8, 'HDR_UNSUPPORTED');
  assert.equal(claim.snapshot.contract.video.transfer, null, 'HDR_UNSUPPORTED');
  assert.equal(claim.snapshot.contract.audio, null, 'AUDIO_UNSUPPORTED');
  assert.equal(claim.snapshot.timing?.cadence, '24/1', 'UNSUPPORTED_CADENCE');
  assert.equal(claim.snapshot.timing.timeBase, '1/24', 'UNSUPPORTED_TIMEBASE');
  assert.equal(claim.snapshot.timing.sources?.length ?? 0, 0, 'SOURCE_TIMING_UNSUPPORTED');
  if (range !== undefined) {
    only(range, ['inPoint', 'outPoint']);
    assert.ok(Number.isSafeInteger(range.inPoint) && Number.isSafeInteger(range.outPoint) &&
      range.inPoint >= 0 && range.outPoint > range.inPoint && range.outPoint <= item.durationInFrames,
      'UNSUPPORTED_EXPORT_RANGE');
  }
  assert.deepEqual(claim.snapshot.contract.range ?? null,
    range ? { ...range, cadence: '24/1' } : null, 'RANGE_CONTRACT_CHANGED');
  assert.ok(
    !claim.snapshot.smoothMotion || claim.snapshot.smoothMotion === 'none',
    'SMOOTH_MOTION_UNSUPPORTED',
  );
  const ceiling = (value, cap) => {
    assert.ok(
      value === null || value === undefined || /^[1-9][0-9]*$/.test(value),
      'INVALID_RESOURCE_CEILING',
    );
    return value == null ? cap : Number(BigInt(value) < BigInt(cap) ? BigInt(value) : BigInt(cap));
  };
  return {
    frames: range ? range.outPoint - range.inPoint : item.durationInFrames,
    range: range ?? null,
    maxBytes: ceiling(claim.limits?.maxOutputBytes, 32 * 1024 * 1024),
    maxMs: ceiling(claim.limits?.maxWallClockMs, 60_000),
    settings: {
      mode: 'video',
      codec: 'avc',
      container: format === 'mov-h264' ? 'mov' : 'mp4',
      audioCodec: 'aac',
      quality,
      ...(subtitleMode !== undefined && { subtitleMode }),
      resolution: { width: 1280, height: 720 },
      fps: 24,
      videoBitrate: bitrates[quality],
      audioBitrate: 192_000,
    },
  };
}

export function probeStillOutput(file, frames, ffprobe = 'ffprobe', container = 'mp4') {
  const result = JSON.parse(
    execFileSync(
      ffprobe,
      ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    ).toString(),
  );
  assert.equal(result.streams.length, 1, 'UNEXPECTED_AUDIO_OR_STREAM');
  const video = result.streams[0];
  assert.ok(
    video.codec_type === 'video' &&
      video.codec_name === 'h264' &&
      video.width === 1280 &&
      video.height === 720 &&
      video.pix_fmt === 'yuv420p' &&
      video.avg_frame_rate === '24/1' &&
      Number(video.nb_read_frames) === frames,
    'ENCODED_RECIPE_MISMATCH',
  );
  assert.ok(
    video.color_transfer === 'bt709' &&
      video.color_primaries === 'bt709' &&
      video.color_space === 'bt709' &&
      video.color_range === 'tv',
    'UNQUALIFIED_OUTPUT_COLOR',
  );
  assert.ok(
    video.time_base === '1/24' && video.start_pts === 0 && video.duration_ts === frames,
    'OUTPUT_TIMING_MISMATCH',
  );
  const brand = result.format.tags?.major_brand;
  assert.ok((container === 'mov' || container === 'mp4') &&
    result.format.format_name.split(',').includes(container) &&
    (container === 'mov' ? brand === 'qt  ' : /^(?:isom|iso[2-9]|mp4[12]|avc1)$/.test(brand)),
    'CONTAINER_MISMATCH');
  return result;
}

/** Leaves the output private and alive only while the caller consumes it under the lease. */
export async function renderStillImage(context, consume) {
  const { claim, engineInputs, isLeaseActive, heartbeat, elapsedMs, registerRelease } = context;
  const recipe = stillRecipe(claim);
  const assertLive = () => {
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    assert.ok(elapsedMs() < recipe.maxMs, 'WALL_CLOCK_LIMIT');
  };
  assertLive();
  const build = JSON.parse(
    await readFile(new URL('../engine-build.json', import.meta.url), 'utf8'),
  );
  assert.equal(process.versions.node, build.node, 'PINNED_NODE_REQUIRED');
  assert.equal(engineInputs.sourceSha256, build.sourceSha256, 'ENGINE_BINDING_MISMATCH');
  // The retained build must carry an independently verified complete artifact inventory.
  const report = JSON.parse(await readFile(path.join(engine, 'frameleaf-build.json'), 'utf8'));
  assert.equal(report.sourceSha256, build.sourceSha256, 'BUILD_SOURCE_MISMATCH');
  assert.equal(report.node, `v${build.node}`, 'BUILD_NODE_MISMATCH');
  assert.equal(report.npm, build.npm, 'BUILD_NPM_MISMATCH');
  assert.equal(report.lockfileSha256, build.lockfileSha256, 'BUILD_LOCK_MISMATCH');
  assert.equal(report.upstreamCommit, build.upstreamCommit, 'BUILD_REVISION_MISMATCH');
  const files = await inventory(await realpath(path.join(engine, 'dist')));
  assert.equal(digest(JSON.stringify(files)), report.artifactSha256, 'BUILT_ARTIFACT_CHANGED');
  const require = createRequire(path.join(engine, 'package.json'));
  assert.deepEqual(
    engineInputs.input.project,
    claim.snapshot.studio.graph,
    'IMMUTABLE_GRAPH_CHANGED',
  );
  assert.equal(context.prepared?.inputs.size, 1, 'SINGLE_VERIFIED_INPUT_REQUIRED');
  const sharp = require('sharp');
  for (const input of context.prepared.inputs.values()) {
    assertLive();
    const metadata = await sharp(input.bytes).metadata();
    assert.ok(
      metadata.format === 'png' &&
        metadata.depth === 'uchar' &&
        metadata.space === 'srgb' &&
        !metadata.hasAlpha &&
        !metadata.icc &&
        !metadata.exif &&
        !metadata.xmp,
      'UNQUALIFIED_IMAGE_COLOR',
    );
    // Only explicit ordinary 8-bit RGB PNG. Do not infer SDR from absent HDR metadata.
    for (let offset = 8; offset < input.bytes.length; ) {
      const length = input.bytes.readUInt32BE(offset);
      const kind = input.bytes.toString('ascii', offset + 4, offset + 8);
      assert.ok(
        ['IHDR', 'IDAT', 'IEND', 'pHYs', 'sRGB', 'gAMA'].includes(kind),
        'UNQUALIFIED_PNG_CHUNK',
      );
      if (kind === 'IHDR')
        assert.ok(
          input.bytes[offset + 16] === 8 && input.bytes[offset + 17] === 2,
          'UNQUALIFIED_PNG_DEPTH',
        );
      if (kind === 'gAMA')
        assert.equal(input.bytes.readUInt32BE(offset + 8), 45455, 'UNQUALIFIED_PNG_GAMMA');
      offset += length + 12;
    }
  }
  const { chromium } = require('playwright');
  const { chromeLaunchArgs } = await import(
    pathToFileURL(path.join(engine, 'headless/lib/cli.mjs')).href
  );
  const { renderJob } = await import(
    pathToFileURL(path.join(engine, 'headless/lib/render-core.mjs')).href
  );
  const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-still-export-'));
  const abort = new AbortController();
  let browser;
  let timer;
  let monitoring = false;
  let monitoringDone = Promise.resolve();
  let wallTimer;
  let failure;
  let lastBeat = performance.now();
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
      downloadsPath: folder,
    });
    const harness = await engineInputs.createHarness();
    const page = await browser.newPage({ acceptDownloads: true });
    const origin = new URL(harness.harnessUrl).origin;
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    assertLive();
    timer = setInterval(async () => {
      if (monitoring || failure) return;
      monitoring = true;
      let finish;
      monitoringDone = new Promise((resolve) => {
        finish = resolve;
      });
      try {
        // Heartbeats serialize; an in-flight heartbeat temporarily removes lease authority.
        if (performance.now() - lastBeat >= 1000) {
          await heartbeat();
          lastBeat = performance.now();
        }
        assertLive();
        let total = 0;
        for (const name of await readdir(folder)) {
          const entry = await stat(path.join(folder, name));
          assert.ok(entry.isFile(), 'UNEXPECTED_DOWNLOAD_ENTRY');
          total += entry.size;
        }
        assert.ok(total <= recipe.maxBytes, 'OUTPUT_BYTE_LIMIT');
      } catch (error) {
        failure = error;
        await release();
      } finally {
        monitoring = false;
        finish();
      }
    }, 100);
    await page.goto(harness.harnessUrl);
    await page.waitForFunction(() => Boolean(window.freecut?.ready), { timeout: 10_000 });
    const gpu = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return adapter
        ? {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            isFallbackAdapter: adapter.info.isFallbackAdapter,
          }
        : null;
    });
    assert.ok(
      gpu &&
        gpu.isFallbackAdapter === false &&
        !/swiftshader|software|llvmpipe/i.test(JSON.stringify(gpu)),
      'HARDWARE_GPU_REQUIRED',
    );
    const result = await renderJob(
      page,
      {
        project: engineInputs.input.project,
        media: harness.media,
        settings: recipe.settings,
        hasRange: recipe.range !== null,
        inPoint: recipe.range?.inPoint ?? null,
        outPoint: recipe.range?.outPoint ?? null,
        missing: [],
        outPath: path.join(folder, `output.${recipe.settings.container}`),
        strict: true,
      },
      { onWarn: () => {}, downloadTimeoutMs: recipe.maxMs },
    );
    clearInterval(timer);
    await monitoringDone;
    if (failure) throw failure;
    assertLive();
    assert.equal(result.ok, true, 'RENDER_REFUSED');
    assert.equal(result.warnings.length, 0, 'RENDER_WARNING_REFUSED');
    assert.equal(result.effectiveSettings.codec, 'avc', 'CODEC_FALLBACK_REFUSED');
    assert.equal(result.effectiveSettings.container, recipe.settings.container, 'CONTAINER_FALLBACK_REFUSED');
    assert.equal(result.effectiveSettings.quality, recipe.settings.quality, 'QUALITY_CHANGED');
    assert.equal(result.effectiveSettings.subtitleMode, recipe.settings.subtitleMode, 'SUBTITLE_MODE_CHANGED');
    assert.equal(result.effectiveSettings.videoBitrate, recipe.settings.videoBitrate, 'BITRATE_CHANGED');
    const file = await stat(result.outputPath);
    assert.ok(file.isFile() && file.size > 0 && file.size <= recipe.maxBytes, 'OUTPUT_BYTE_LIMIT');
    const probe = probeStillOutput(result.outputPath, recipe.frames, 'ffprobe', recipe.settings.container);
    const bytes = await readFile(result.outputPath);
    const checksum = digest(bytes);
    bytes.fill(0);
    await heartbeat();
    assertLive();
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
      } catch (error) {
        failure = error;
        await release();
      } finally {
        monitoring = false;
        finish();
      }
    }, 1000);
    return await consume({
      outputPath: result.outputPath,
      checksum,
      sizeInBytes: String(file.size),
      probe,
      gpu,
      browser: browser.version(),
      sourceSha256: build.sourceSha256,
      artifactSha256: report.artifactSha256,
      signal: abort.signal,
      recipe,
    });
  } catch (error) {
    throw failure ?? error;
  } finally {
    clearInterval(timer);
    clearTimeout(wallTimer);
    await release();
    await monitoringDone;
    await rm(folder, { recursive: true, force: true });
  }
}

export async function executeStillClaim(context) {
  return renderStillImage(
    context,
    async ({ outputPath, checksum, sizeInBytes, signal, recipe }) => {
      const { claim, request, heartbeat, upload, isLeaseActive } = context;
      const post = (pathname, body) =>
        request(
          pathname,
          body,
          Math.max(1, Math.min(10_000, recipe.maxMs - context.elapsedMs())),
          signal,
        );
      const root = `/api/render-workers/operations/${claim.operationId}`;
      const binding = { claimToken: claim.claimToken };
      const configDigest = digest(
        JSON.stringify({ recipe: 'single-still-sdr-v1', settings: recipe.settings,
          ...(recipe.range && { range: recipe.range }) }),
      );
      const historyDigest = digest(JSON.stringify(claim.snapshot.studio.graph));
      assert.ok(
        typeof claim.artifactInputDigest === 'string' && claim.artifactInputDigest,
        'INPUT_DIGEST_REQUIRED',
      );
      const chunkKey = digest(`${claim.artifactInputDigest}:${configDigest}:${historyDigest}`);
      await heartbeat();
      const planned = await post(`${root}/checkpoints`, {
        ...binding,
        sequence: 0,
        chunkKey,
        inputDigest: claim.artifactInputDigest,
        historyDigest,
        configDigest,
        seed: null,
        timebase: '1/24',
        startTicks: '0',
        endTicks: String(recipe.frames),
        requiresSequentialContext: false,
      });
      assert.equal(planned?.accepted, true, 'CHECKPOINT_PLAN_REFUSED');
      await heartbeat();
      assert.equal(
        (await upload(outputPath, { chunkKey, checksum, sizeInBytes }, signal))?.accepted,
        true,
        'ARTIFACT_REFUSED',
      );
      await heartbeat();
      const complete = { ...binding, artifactSequence: 0, resultAssetId: null };
      assert.equal(
        (await post(`${root}/validate`, complete))?.accepted,
        true,
        'VALIDATION_REFUSED',
      );
      await heartbeat();
      assert.ok(isLeaseActive(), 'LEASE_LOST');
      return post(`${root}/complete`, complete);
    },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await prepareOneClaim({
      serverUrl: process.env.FRAMELEAF_URL,
      sessionToken: process.env.FRAMELEAF_WORKER_SESSION,
      execute: executeStillClaim,
    });
    console.log(JSON.stringify(result));
    if (!['idle', 'completed'].includes(result.status)) process.exitCode = 1;
  } catch {
    console.error('Still export refused; no completion accepted.');
    process.exitCode = 1;
  }
}
