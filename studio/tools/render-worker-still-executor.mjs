#!/usr/bin/env node
// Immutable still exports use the existing claim, renderer and isolated image worker.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareOneClaim } from './render-worker-claim.mjs';
import { inventory } from './engine.mjs';
import { pqDecode } from './hdr-master.mjs';
const engine = fileURLToPath(new URL('../engine/', import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const only = (object, keys) =>
  assert.ok(object && Object.keys(object).every((key) => keys.includes(key)), 'UNSUPPORTED_RECIPE_FIELD');

/** Immutable visual timeline planning; runtime resource/build/strict-render admission is separate. */
export function stillRecipe(claim) {
  const { quality = 'high', range, subtitleMode, ...settings } = claim.settings ?? {};
  const ceiling = (value, cap) => {
    assert.ok(value === null || value === undefined || /^[1-9][0-9]*$/.test(value), 'INVALID_RESOURCE_CEILING');
    return value == null ? cap : Number(BigInt(value) < BigInt(cap) ? BigInt(value) : BigInt(cap));
  };
  const graph = claim.snapshot?.studio?.graph;
  if (['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'].includes(settings.format)) {
    assert.deepEqual(
      settings,
      { format: settings.format, color: 'preserve', resolution: 'original', audio: 'preserve' },
      'UNSUPPORTED_STILL_EXPORT_SETTINGS',
    );
    assert.ok(quality === 'high' && subtitleMode === undefined, 'UNSUPPORTED_STILL_EXPORT_SETTINGS');
    assert.equal(claim.checkpoints?.length ?? 0, 0, 'RECOVERY_RECIPE_UNAVAILABLE');
    const require = createRequire(import.meta.url);
    const { StudioExportImageContractSchema } = require('../../server/dist/utils/studio-export-contract.js');
    const photo = StudioExportImageContractSchema.parse(claim.snapshot.contract?.image);
    assert.equal(photo.format, settings.format, 'STILL_CONTRACT_CHANGED');
    assert.equal(photo.width, graph?.metadata?.width, 'STILL_CONTRACT_CHANGED');
    assert.equal(photo.height, graph?.metadata?.height, 'STILL_CONTRACT_CHANGED');
    assert.equal(photo.outputIntent, graph?.metadata?.colorManagement?.workingRange ?? 'sdr', 'STILL_CONTRACT_CHANGED');
    assert.equal(photo.frame, range?.inPoint ?? 0, 'STILL_CONTRACT_CHANGED');
    if (photo.dynamicRange === 'hdr')
      assert.equal(process.env.FRAMELEAF_HDR_IMAGES, 'experimental', 'HDR_IMAGE_PROCESSING_DISABLED');
    assert.ok(!claim.snapshot.smoothMotion || claim.snapshot.smoothMotion === 'none', 'SMOOTH_MOTION_UNSUPPORTED');
    assert.equal(claim.snapshot.contract.audio, null, 'AUDIO_UNSUPPORTED');
    const { tryParseRational } = require('../../server/dist/utils/rational-time.js');
    const { timelineFrameTicks, projectCadenceOf } = require('../../server/dist/utils/studio-timing.js');
    const cadence = tryParseRational(claim.snapshot.timing?.cadence);
    const timeBase = tryParseRational(claim.snapshot.timing?.timeBase);
    assert.deepEqual(cadence, projectCadenceOf(graph.metadata), 'STILL_CADENCE_CHANGED');
    assert.ok(cadence && timeBase && timeBase.num > 0, 'INVALID_STILL_TIMING');
    const endTicks = timelineFrameTicks(1, cadence, timeBase);
    assert.ok(Number.isSafeInteger(endTicks) && endTicks > 0, 'INVALID_STILL_TIMING');
    assert.ok(
      Number.isFinite(graph.duration) && (photo.frame * cadence.den) / cadence.num < graph.duration,
      'STILL_FRAME_OUTSIDE_TIMELINE',
    );
    if (range !== undefined) {
      only(range, ['inPoint', 'outPoint']);
      assert.equal(range.outPoint, range.inPoint + 1, 'STILL_FRAME_RANGE_REQUIRED');
    }
    assert.deepEqual(
      claim.snapshot.contract.range ?? null,
      range ? { ...range, cadence: claim.snapshot.timing.cadence } : null,
      'RANGE_CONTRACT_CHANGED',
    );
    return {
      frames: 1,
      photo,
      range: range ?? null,
      timebase: claim.snapshot.timing.timeBase,
      endTicks: String(endTicks),
      maxBytes: ceiling(claim.limits?.maxOutputBytes, 32 * 1024 * 1024),
      maxMs: ceiling(claim.limits?.maxWallClockMs, 180_000),
      settings: { quality, resolution: { width: photo.width, height: photo.height } },
    };
  }
  // Same four bitrate presets as the pinned engine's headless render core.
  const bitrates = { low: 2_500_000, medium: 5_000_000, high: 10_000_000, ultra: 20_000_000 };
  assert.ok(typeof quality === 'string' && Object.hasOwn(bitrates, quality), 'UNSUPPORTED_EXPORT_QUALITY');
  assert.ok(
    subtitleMode === undefined || subtitleMode === 'burn' || subtitleMode === 'off',
    'UNSUPPORTED_SUBTITLE_MODE',
  );
  assert.deepEqual(
    settings,
    { format: 'mp4-h264', color: 'preserve', resolution: '720p', audio: 'preserve' },
    'UNSUPPORTED_EXPORT_SETTINGS',
  );
  assert.equal(claim.checkpoints?.length ?? 0, 0, 'RECOVERY_RECIPE_UNAVAILABLE');
  assert.ok(graph?.metadata && Array.isArray(graph.timeline?.tracks) && Array.isArray(graph.timeline?.items), 'PROJECT_REQUIRED');
  // The immutable graph is passed intact to the real migration/composition/strict renderer below.
  // Bounds and output timing come from the same server contract helpers, never CLI seconds.
  const require = createRequire(import.meta.url);
  const { projectCadenceOf, timelineFrameTicks } = require('../../server/dist/utils/studio-timing.js');
  const { tryParseRational, formatRational } = require('../../server/dist/utils/rational-time.js');
  const { resolveStudioExportRange } = require('../../server/dist/utils/studio-export-contract.js');
  const cadence = tryParseRational(claim.snapshot.timing?.cadence);
  const timeBase = tryParseRational(claim.snapshot.timing?.timeBase);
  assert.ok(cadence && cadence.num > 0 && timeBase && timeBase.num > 0, 'INVALID_TIMELINE_TIMING');
  assert.deepEqual(cadence, projectCadenceOf(graph.metadata), 'PROJECT_CADENCE_CHANGED');
  for (const dimension of ['width', 'height'])
    assert.ok(Number.isSafeInteger(graph.metadata[dimension]) && graph.metadata[dimension] > 0 && graph.metadata[dimension] <= 16384, 'INVALID_CANVAS');
  let end = 0;
  assert.ok(graph.timeline.tracks.every(({ id }) => typeof id === 'string' && id.length > 0), 'INVALID_TRACK');
  const tracks = new Set(graph.timeline.tracks.map(({ id }) => id));
  assert.equal(tracks.size, graph.timeline.tracks.length, 'DUPLICATE_TRACK');
  const items = new Set();
  for (const item of graph.timeline.items) {
    assert.ok(typeof item.id === 'string' && !items.has(item.id) && tracks.has(item.trackId), 'INVALID_TIMELINE_ITEM');
    items.add(item.id);
    assert.ok(Number.isSafeInteger(item.from) && item.from >= 0 && Number.isSafeInteger(item.durationInFrames) && item.durationInFrames > 0 && Number.isSafeInteger(item.from + item.durationInFrames), 'INVALID_FRAME_BOUNDS');
    end = Math.max(end, item.from + item.durationInFrames);
  }
  assert.ok(end > 0, 'EMPTY_TIMELINE');
  assert.equal(graph.duration, end * cadence.den / cadence.num, 'INCONSISTENT_DURATION');
  if (range !== undefined) only(range, ['inPoint', 'outPoint']);
  const declaredRange = range === undefined ? null : resolveStudioExportRange(graph, range);
  const frames = declaredRange ? declaredRange.outPoint - declaredRange.inPoint : end;
  const endTicks = timelineFrameTicks(frames, cadence, timeBase);
  assert.ok(Number.isSafeInteger(endTicks) && endTicks > 0, 'INVALID_TIMELINE_TIMING');
  assert.equal(claim.snapshot.contract?.video?.minBitDepth, 8, 'HDR_UNSUPPORTED');
  assert.equal(claim.snapshot.contract.video.transfer, null, 'HDR_UNSUPPORTED');
  assert.equal(claim.snapshot.contract.audio, null, 'AUDIO_UNSUPPORTED');
  assert.equal(claim.snapshot.timing.sources?.length ?? 0, 0, 'SOURCE_TIMING_ADAPTER_UNAVAILABLE');
  assert.deepEqual(claim.snapshot.contract.range ?? null, declaredRange, 'RANGE_CONTRACT_CHANGED');
  assert.ok(!claim.snapshot.smoothMotion || claim.snapshot.smoothMotion === 'none', 'SMOOTH_MOTION_UNSUPPORTED');
  return {
    frames,
    cadence: formatRational(cadence),
    timebase: formatRational(timeBase),
    endTicks: String(endTicks),
    range: range ?? null,
    frameBounds: declaredRange ? { inPoint: declaredRange.inPoint, outPoint: declaredRange.outPoint } : { inPoint: 0, outPoint: end },
    maxBytes: ceiling(claim.limits?.maxOutputBytes, 32 * 1024 * 1024),
    maxMs: ceiling(claim.limits?.maxWallClockMs, 60_000),
    settings: {
      mode: 'video',
      codec: 'avc',
      container: 'mp4',
      audioCodec: 'aac',
      quality,
      ...(subtitleMode !== undefined && { subtitleMode }),
      resolution: { width: 1280, height: 720 },
      fps: cadence.num / cadence.den,
      videoBitrate: bitrates[quality],
      audioBitrate: 192_000,
    },
  };
}

export function probeStillOutput(file, plan, ffprobe = 'ffprobe') {
  const { frames, cadence = '24/1' } = typeof plan === 'number' ? { frames: plan } : plan;
  const result = JSON.parse(
    execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-show_packets', '-of', 'json', file], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    }).toString(),
  );
  assert.equal(result.streams.length, 1, 'UNEXPECTED_AUDIO_OR_STREAM');
  const video = result.streams[0];
  assert.ok(
    video.codec_type === 'video' &&
      video.codec_name === 'h264' &&
      video.width === 1280 &&
      video.height === 720 &&
      video.pix_fmt === 'yuv420p' &&
      video.avg_frame_rate === cadence &&
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
  const require = createRequire(import.meta.url);
  const { tryParseRational } = require('../../server/dist/utils/rational-time.js');
  const { timelineFrameTicks } = require('../../server/dist/utils/studio-timing.js');
  const timeBase = tryParseRational(video.time_base);
  const rate = tryParseRational(cadence);
  assert.ok(timeBase && rate && video.start_pts === 0 && video.duration_ts === timelineFrameTicks(frames, rate, timeBase), 'OUTPUT_TIMING_MISMATCH');
  const packets = result.packets;
  const frameTicks = timelineFrameTicks(1, rate, timeBase);
  assert.ok(Array.isArray(packets) && packets.length === frames && Number.isSafeInteger(frameTicks) && frameTicks > 0, 'OUTPUT_PACKET_TIMING_MISMATCH');
  const presentation = packets.map((packet) => {
    assert.equal(packet.stream_index, video.index, 'UNEXPECTED_PACKET_STREAM');
    assert.ok(Number.isSafeInteger(packet.pts) && Number.isSafeInteger(packet.duration) && packet.duration === frameTicks, 'OUTPUT_PACKET_TIMING_MISMATCH');
    return packet.pts;
  }).sort((left, right) => left - right);
  assert.ok(presentation.every((pts, index) => pts === timelineFrameTicks(index, rate, timeBase)), 'OUTPUT_PACKET_TIMING_MISMATCH');
  assert.ok(result.format.format_name.split(',').includes('mp4'), 'CONTAINER_MISMATCH');
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
  const build = JSON.parse(await readFile(new URL('../engine-build.json', import.meta.url), 'utf8'));
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
  assert.deepEqual(engineInputs.input.project, claim.snapshot.studio.graph, 'IMMUTABLE_GRAPH_CHANGED');
  assert.deepEqual(engineInputs.binding, {
    operationId: claim.operationId, claimToken: claim.claimToken, revisionId: claim.revisionId,
  }, 'INPUT_CLAIM_BINDING_CHANGED');
  if (!recipe.photo) {
    assert.ok(context.prepared?.inputs instanceof Map, 'VERIFIED_INPUTS_REQUIRED');
    assert.equal(context.prepared.inputs.size, engineInputs.input.media.length, 'VERIFIED_INPUT_CLOSURE_CHANGED');
  }
  const sharp = require('sharp');
  for (const input of recipe.photo ? [] : context.prepared.inputs.values()) {
    assertLive();
    assert.equal(digest(input.bytes), input.sha256, 'VERIFIED_INPUT_CHANGED');
    const metadata = await sharp(input.bytes).metadata();
    assert.ok(
      metadata.format === 'png' &&
        metadata.depth === 'uchar' &&
        metadata.space === 'srgb' &&
        !metadata.icc &&
        !metadata.exif &&
        !metadata.xmp,
      'UNQUALIFIED_IMAGE_COLOR',
    );
    // Only explicit ordinary 8-bit RGB/RGBA PNG. Do not infer SDR from absent HDR metadata.
    for (let offset = 8; offset < input.bytes.length;) {
      const length = input.bytes.readUInt32BE(offset);
      const kind = input.bytes.toString('ascii', offset + 4, offset + 8);
      assert.ok(['IHDR', 'IDAT', 'IEND', 'pHYs', 'sRGB', 'gAMA'].includes(kind), 'UNQUALIFIED_PNG_CHUNK');
      if (kind === 'IHDR')
        assert.ok(input.bytes[offset + 16] === 8 && [2, 6].includes(input.bytes[offset + 17]), 'UNQUALIFIED_PNG_DEPTH');
      if (kind === 'gAMA') assert.equal(input.bytes.readUInt32BE(offset + 8), 45455, 'UNQUALIFIED_PNG_GAMMA');
      offset += length + 12;
    }
  }
  const { chromium } = require('playwright');
  const { chromeLaunchArgs } = await import(pathToFileURL(path.join(engine, 'headless/lib/cli.mjs')).href);
  const { renderJob } = await import(pathToFileURL(path.join(engine, 'headless/lib/render-core.mjs')).href);
  const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-still-export-'));
  const abort = new AbortController();
  let browser;
  let pool;
  let timer;
  let monitoring = false;
  let monitoringDone = Promise.resolve();
  let wallTimer;
  let failure;
  let lastBeat = performance.now();
  const release = async () => {
    abort.abort();
    await Promise.allSettled([browser?.close(), pool?.close()]);
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
          const entry = await stat(path.join(folder, name)).catch((error) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (!entry) continue;
          assert.ok(entry.isFile(), 'UNEXPECTED_DOWNLOAD_ENTRY');
          total += entry.size;
        }
        assert.ok(
          total <= recipe.maxBytes + (recipe.photo ? recipe.photo.width * recipe.photo.height * 16 : 0),
          'OUTPUT_BYTE_LIMIT',
        );
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
      gpu && gpu.isFallbackAdapter === false && !/swiftshader|software|llvmpipe/i.test(JSON.stringify(gpu)),
      'HARDWARE_GPU_REQUIRED',
    );
    let result;
    if (recipe.photo) {
      const { SharpProcessPool } = await import(new URL('../../server/dist/queue/sharp-pool.js', import.meta.url));
      pool = new SharpProcessPool({ workers: 1, pending: 0, maxPixels: 48_000_000, maxBytes: 6 * 1024 ** 3 });
      const download = page.waitForEvent('download', { timeout: recipe.maxMs });
      // Attach a handler while evaluation runs so a failed render cannot leave an unhandled timeout.
      download.catch(() => {});
      await page.evaluate(
        async ({ project, media, resources, photo }) => {
          const hdrRasters = {};
          for (const { id, url, byteLength, sha256, ...metadata } of resources) {
            const response = await fetch(url);
            if (!response.ok) throw new Error('HDR_INPUT_UNAVAILABLE');
            const bytes = await response.arrayBuffer();
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) =>
              value.toString(16).padStart(2, '0'),
            ).join('');
            if (bytes.byteLength !== byteLength || hash !== sha256) throw new Error('VERIFIED_HDR_INPUT_CHANGED');
            const expected = metadata.width * metadata.height * (metadata.transfer === 'linear' ? 16 : 6);
            if (bytes.byteLength !== expected) throw new Error('INVALID_HDR_INPUT_LENGTH');
            hdrRasters[id] = {
              ...metadata,
              ...(metadata.transfer === 'linear' ? { rgba: new Float32Array(bytes) } : { rgb: new Uint16Array(bytes) }),
            };
          }
          const rendered = await window.freecut.renderFrameSignal({
            project,
            media,
            frame: photo.frame,
            strict: true,
            target: photo.outputIntent === 'sdr' ? 'sdr-display' : 'pq',
            hdrRasters,
          });
          if (rendered.warnings?.length) throw new Error('STILL_RENDER_WARNING_REFUSED');
          if (
            rendered.width !== photo.width ||
            rendered.height !== photo.height ||
            !(rendered.rgba instanceof Float32Array) ||
            rendered.rgba.length !== photo.width * photo.height * 4
          )
            throw new Error('STILL_RENDER_DIMENSIONS_CHANGED');
          const url = URL.createObjectURL(new Blob([rendered.rgba], { type: 'application/octet-stream' }));
          const link = document.createElement('a');
          link.href = url;
          link.download = 'signal.bin';
          link.click();
          for (const raster of Object.values(hdrRasters)) {
            raster.rgba?.fill(0);
            raster.rgb?.fill(0);
          }
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
        {
          project: engineInputs.input.project,
          media: harness.media,
          resources: harness.hdrRasterResources ?? [],
          photo: recipe.photo,
        },
      );
      const downloaded = await download;
      const rawPath = path.join(folder, 'signal.bin');
      const downloadedPath = await downloaded.path();
      assert.ok(downloadedPath && path.dirname(downloadedPath) === folder, 'UNEXPECTED_DOWNLOAD_PATH');
      await rename(downloadedPath, rawPath);
      assertLive();
      const pixels = recipe.photo.width * recipe.photo.height;
      const rawStat = await stat(rawPath);
      assert.ok(rawStat.isFile() && rawStat.size === pixels * 16, 'STILL_SIGNAL_LENGTH_CHANGED');
      const raw = await readFile(rawPath);
      let encoded;
      const outputPath = path.join(folder, recipe.photo.format === 'hdr-heic' ? 'output.heic' : 'output.jpg');
      const sdr = recipe.photo.outputIntent === 'sdr' ? Buffer.alloc(pixels * 3) : null;
      try {
        for (let offset = 0; offset < raw.length; offset += 16) {
          const alpha = raw.readFloatLE(offset + 12);
          assert.ok(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1, 'INVALID_STILL_ALPHA');
          for (let channel = 0; channel < 3; channel++) {
            const signal = raw.readFloatLE(offset + channel * 4);
            assert.ok(Number.isFinite(signal) && signal >= 0 && signal <= 1, 'INVALID_STILL_SIGNAL');
            // JPEG/HEIC have no alpha; composite against black in linear light.
            if (sdr) {
              const linear = (signal <= 0.04045 ? signal / 12.92 : ((signal + 0.055) / 1.055) ** 2.4) * alpha;
              sdr[(offset / 16) * 3 + channel] = Math.round(
                (linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055) * 255,
              );
            } else raw.writeFloatLE((pqDecode(signal) / 203) * alpha, offset + channel * 4);
          }
          raw.writeFloatLE(1, offset + 12);
        }
        if (sdr) {
          encoded = await pool.run(
            'encodeDevelopOutput',
            [
              sdr,
              { width: recipe.photo.width, height: recipe.photo.height, channels: 3 },
              { detail: { median: 0 }, colorspace: 'srgb', format: 'jpeg', quality: 95 },
            ],
            abort.signal,
          );
        } else
          encoded = await pool.run(
            'encodeHdrImage',
            [
              { data: raw, width: recipe.photo.width, height: recipe.photo.height, gamut: 2, referenceWhite: 203 },
              recipe.photo.format === 'hdr-heic' ? 'heic' : 'jpeg',
            ],
            abort.signal,
          );
      } finally {
        raw.fill(0);
        sdr?.fill(0);
        await rm(rawPath, { force: true });
      }
      try {
        if (recipe.photo.dynamicRange === 'sdr' && recipe.photo.outputIntent === 'hdr')
          await pool.run(
            'generateHdrRenditions',
            [encoded, [{ path: outputPath, dynamicRange: 'sdr', format: 'jpeg' }]],
            abort.signal,
          );
        else await writeFile(outputPath, encoded, { flag: 'wx', mode: 0o600 });
      } finally {
        encoded.fill(0);
      }
      assertLive();
      const encoding = await pool.run('inspectImageEncoding', [outputPath], abort.signal);
      assert.equal(encoding.dynamicRange, recipe.photo.dynamicRange, 'STILL_OUTPUT_RANGE_CHANGED');
      if (recipe.photo.dynamicRange === 'hdr') {
        assert.equal(encoding.reconstructionAvailable, true, 'HDR_RECONSTRUCTION_UNAVAILABLE');
        assert.equal(encoding.width, recipe.photo.width, 'STILL_OUTPUT_DIMENSIONS_CHANGED');
        assert.equal(encoding.height, recipe.photo.height, 'STILL_OUTPUT_DIMENSIONS_CHANGED');
      }
      if (recipe.photo.format === 'hdr-heic') {
        assert.equal(encoding.container, 'heif', 'STILL_OUTPUT_FORMAT_CHANGED');
        assert.equal(encoding.codec, 'hevc', 'STILL_OUTPUT_FORMAT_CHANGED');
        assert.ok(encoding.bitDepth >= 10 && encoding.transfer === 16, 'STILL_HEIC_SIGNAL_CHANGED');
      } else assert.equal(encoding.container, 'jpeg', 'STILL_OUTPUT_FORMAT_CHANGED');
      result = { outputPath, encoding };
    } else
      result = await renderJob(
        page,
        {
          project: engineInputs.input.project,
          media: harness.media,
          settings: recipe.settings,
          // Explicit integer frame bounds also prevent the engine's one-second empty-tail floor.
          hasRange: true,
          inPoint: recipe.frameBounds.inPoint,
          outPoint: recipe.frameBounds.outPoint,
          missing: [],
          outPath: path.join(folder, 'output.mp4'),
          strict: true,
        },
        { onWarn: () => {}, downloadTimeoutMs: recipe.maxMs },
      );
    clearInterval(timer);
    await monitoringDone;
    if (failure) throw failure;
    assertLive();
    if (!recipe.photo) {
      assert.equal(result.ok, true, 'RENDER_REFUSED');
      assert.equal(result.warnings.length, 0, 'RENDER_WARNING_REFUSED');
      assert.equal(result.effectiveSettings.codec, 'avc', 'CODEC_FALLBACK_REFUSED');
      assert.equal(result.effectiveSettings.quality, recipe.settings.quality, 'QUALITY_CHANGED');
      assert.equal(result.effectiveSettings.subtitleMode, recipe.settings.subtitleMode, 'SUBTITLE_MODE_CHANGED');
      assert.equal(result.effectiveSettings.videoBitrate, recipe.settings.videoBitrate, 'BITRATE_CHANGED');
    }
    const file = await stat(result.outputPath);
    assert.ok(file.isFile() && file.size > 0 && file.size <= recipe.maxBytes, 'OUTPUT_BYTE_LIMIT');
    const probe = recipe.photo ? result.encoding : probeStillOutput(result.outputPath, recipe);
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
  return renderStillImage(context, async ({ outputPath, checksum, sizeInBytes, signal, recipe }) => {
    const { claim, request, heartbeat, upload, isLeaseActive } = context;
    const post = (pathname, body) =>
      request(pathname, body, Math.max(1, Math.min(10_000, recipe.maxMs - context.elapsedMs())), signal);
    const root = `/api/render-workers/operations/${claim.operationId}`;
    const binding = { claimToken: claim.claimToken };
    const configDigest = digest(
      JSON.stringify({
        recipe: recipe.photo?.renderer ?? 'immutable-visual-timeline-v1',
        settings: recipe.settings,
        ...(recipe.photo && { image: recipe.photo }),
        ...(recipe.range && { range: recipe.range }),
      }),
    );
    const historyDigest = digest(JSON.stringify(claim.snapshot.studio.graph));
    assert.ok(typeof claim.artifactInputDigest === 'string' && claim.artifactInputDigest, 'INPUT_DIGEST_REQUIRED');
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
      timebase: recipe.timebase ?? '1/24',
      startTicks: '0',
      endTicks: recipe.endTicks ?? String(recipe.frames),
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
    assert.equal((await post(`${root}/validate`, complete))?.accepted, true, 'VALIDATION_REFUSED');
    await heartbeat();
    assert.ok(isLeaseActive(), 'LEASE_LOST');
    return post(`${root}/complete`, complete);
  });
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
