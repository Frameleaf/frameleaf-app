// Byte-bound video admission reuses the Library packet probe and the renderer's MediaBunny parser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function inspectVerifiedVideo(source, file, signal) {
  signal.throwIfAborted();
  assert.equal(sha(source.bytes), source.sha256, "VERIFIED_INPUT_CHANGED");
  const hex = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(source.declaredChecksum);
  const checksum = Buffer.from(source.declaredChecksum, hex ? "hex" : "base64");
  assert.ok(
    [20, 32].includes(checksum.length) &&
      (hex || checksum.toString("base64") === source.declaredChecksum),
    "INVALID_INPUT_CHECKSUM",
  );
  assert.ok(
    createHash(checksum.length === 20 ? "sha1" : "sha256")
      .update(source.bytes)
      .digest()
      .equals(checksum),
    "INPUT_CHECKSUM_MISMATCH",
  );
  await writeFile(file, source.bytes, { mode: 0o600, flag: "wx" });
  const {
    MediaRepository,
  } = require("../../server/dist/repositories/media.repository.js");
  const {
    LoggingRepository,
  } = require("../../server/dist/repositories/logging.repository.js");
  const {
    operationExecution,
  } = require("../../server/dist/utils/execution-signal.js");
  const media = new MediaRepository(LoggingRepository.create());
  const { Input, BufferSource, ALL_FORMATS } = require("mediabunny");
  const input = new Input({
    source: new BufferSource(source.bytes),
    formats: ALL_FORMATS,
  });
  try {
    const result = await operationExecution.run(
      {
        signal,
        settled: false,
        progress: () => {},
        completed: new Map(),
        settle: async () => {},
      },
      async () => {
        const probe = await media.probe(file, { countFrames: true });
        signal.throwIfAborted();
        assert.equal(
          probe.videoStreams.length,
          1,
          "VIDEO_STREAM_SELECTION_UNAVAILABLE",
        );
        assert.equal(
          probe.audioStreams.length,
          0,
          "VIDEO_AUDIO_ADAPTER_UNAVAILABLE",
        );
        assert.ok(
          probe.format.formatName?.split(",").includes("mp4"),
          "VIDEO_CONTAINER_ADAPTER_UNAVAILABLE",
        );
        const video = probe.videoStreams[0];
        const packets = await media.probePackets(file, video.index, {
          maxPackets: 100_000,
        });
        signal.throwIfAborted();
        assert.ok(
          packets?.presentation && packets.presentationCadenceTicks > 0,
          "VFR_OR_IRREGULAR_SOURCE_ADAPTER_UNAVAILABLE",
        );
        assert.equal(
          packets.variableFrameRate,
          false,
          "VFR_SOURCE_ADAPTER_UNAVAILABLE",
        );
        assert.equal(
          packets.startPts,
          0,
          "NONZERO_SOURCE_ORIGIN_ADAPTER_UNAVAILABLE",
        );
        assert.ok(
          video.timeBaseRational?.num === 1 &&
            video.timeBaseRational.den === video.timeBase,
          "SOURCE_TIMEBASE_UNAVAILABLE",
        );
        const fps = video.timeBase / packets.presentationCadenceTicks;
        assert.ok(
          Number.isFinite(fps) && fps > 0,
          "SOURCE_CADENCE_UNAVAILABLE",
        );
        assert.equal(
          video.frameRateRational?.num / video.frameRateRational?.den,
          fps,
          "SOURCE_CADENCE_CHANGED",
        );
        assert.ok(
          packets.packetCount > 0 && packets.packetCount <= 100_000,
          "SOURCE_PACKET_LIMIT",
        );
        assert.equal(
          packets.presentation.endPts,
          packets.packetCount * packets.presentationCadenceTicks,
          "SOURCE_PRESENTATION_CHANGED",
        );
        // Independent parsers must agree on absence for these exact checksum-bound bytes.
        assert.equal(
          await input.getPrimaryAudioTrack(),
          null,
          "SOURCE_AUDIO_CHANGED",
        );
        const track = await input.getPrimaryVideoTrack();
        assert.ok(track, "VIDEO_TRACK_UNAVAILABLE");
        assert.equal(
          await track.getRotation(),
          0,
          "VIDEO_ROTATION_ADAPTER_UNAVAILABLE",
        );
        assert.deepEqual(
          await track.getPixelAspectRatio(),
          { num: 1, den: 1 },
          "VIDEO_ASPECT_ADAPTER_UNAVAILABLE",
        );
        const width = await track.getDisplayWidth();
        const height = await track.getDisplayHeight();
        assert.deepEqual(
          [await track.getCodedWidth(), await track.getCodedHeight()],
          [width, height],
          "VIDEO_DIMENSIONS_CHANGED",
        );
        assert.deepEqual(
          [video.width, video.height],
          [width, height],
          "VIDEO_DIMENSIONS_CHANGED",
        );
        assert.ok(
          width > 0 && height > 0 && width * height <= 48_000_000,
          "VIDEO_PIXEL_LIMIT",
        );
        const codec = await track.getCodec();
        assert.equal(codec, "avc", "VIDEO_CODEC_ADAPTER_UNAVAILABLE");
        assert.equal(video.codecName, "h264", "VIDEO_CODEC_CHANGED");
        const duration = packets.presentation.endPts / video.timeBase;
        assert.ok(
          Math.abs((await track.computeDuration()) - duration) <=
            1 / video.timeBase,
          "SOURCE_DURATION_CHANGED",
        );
        assert.equal(
          (await track.computePacketStats()).packetCount,
          packets.packetCount,
          "SOURCE_PACKET_COUNT_CHANGED",
        );
        // Current MP4/H264 executor is qualified for explicitly tagged ordinary BT.709 SDR only.
        const {
          ColorTransfer,
          ColorPrimaries,
          ColorMatrix,
        } = require("../../server/dist/enum.js");
        assert.ok(
          video.pixelFormat === "yuv420p" &&
            video.colorTransfer === ColorTransfer.Bt709 &&
            video.colorPrimaries === ColorPrimaries.Bt709 &&
            video.colorMatrix === ColorMatrix.Bt709 &&
            video.colorRange === "tv",
          "UNQUALIFIED_VIDEO_COLOR",
        );
        return {
          metadata: {
            id: source.id,
            storageType: "workspace",
            fileName: `${source.key}.mp4`,
            fileSize: source.bytes.length,
            mimeType: "video/mp4",
            duration,
            width,
            height,
            fps,
            codec: video.codecName,
            bitrate: video.bitrate,
            videoCodecSupported: true,
            embeddedAudioTrackAbsent: true,
          },
          facts: {
            assetId: source.id,
            video: {
              timeBase: video.timeBase,
              pixelFormat: video.pixelFormat,
              colorTransfer: video.colorTransfer,
            },
            packets,
            audio: null,
          },
          packetCount: packets.packetCount,
          sha256: source.sha256,
          key: `library-asset:${source.id}`,
        };
      },
    );
    signal.throwIfAborted();
    const disk = await readFile(file);
    try {
      assert.equal(sha(disk), source.sha256, "VERIFIED_INPUT_CHANGED");
    } finally {
      disk.fill(0);
    }
    return result;
  } catch (error) {
    signal.throwIfAborted();
    if (error?.code === "ERR_ASSERTION") throw error;
    throw new Error("VIDEO_PROBE_REFUSED"); // Never expose native probe paths/diagnostics.
  } finally {
    input.dispose();
  }
}

/** Canonical main timeline and all definitions, including unused ones; no graph reconstruction. */
export function timelineViews(project) {
  assert.ok(Array.isArray(project.timeline.items), "PROJECT_REQUIRED");
  const compositions = project.timeline.compositions ?? [];
  assert.ok(Array.isArray(compositions), "INVALID_GRAPH_RESOURCE");
  for (const composition of compositions)
    assert.ok(
      composition && Array.isArray(composition.items),
      "INVALID_GRAPH_RESOURCE",
    );
  return [
    { items: project.timeline.items, metadata: project.metadata },
    ...compositions.map((composition) => ({
      items: composition.items,
      metadata: composition,
    })),
  ];
}

export function reconcileVideoTiming(project, declared, observations) {
  const {
    resolveStudioExportTiming,
  } = require("../../server/dist/utils/studio-export-contract.js");
  const timing = resolveStudioExportTiming(
    project,
    observations.map(({ key, facts }) => ({ key, facts })),
  );
  assert.deepEqual(
    declared?.sources ?? [],
    timing.sources,
    "SOURCE_TIMING_CHANGED",
  );
  for (const field of ["cadence", "timeBase", "decision"])
    if (declared?.[field] !== undefined)
      assert.deepEqual(declared[field], timing[field], "SOURCE_TIMING_CHANGED");
  const {
    projectCadenceOf,
    speedOf,
    clipSourceTime,
  } = require("../../server/dist/utils/studio-timing.js");
  const {
    tryParseRational,
    fromInteger,
    multiply,
    compare,
  } = require("../../server/dist/utils/rational-time.js");
  const compositions = new Map(
    (project.timeline.compositions ?? []).map((composition) => [
      composition.id,
      composition,
    ]),
  );
  for (const view of timelineViews(project)) {
    const projectCadence = projectCadenceOf(view.metadata);
    assert.ok(projectCadence, "COMPOSITION_CADENCE_REQUIRED");
    for (const item of view.items) {
      if (item.type !== "composition" && item.type !== "video") continue;
      assert.ok(
        Number.isSafeInteger(item.from) &&
          item.from >= 0 &&
          Number.isSafeInteger(item.durationInFrames) &&
          item.durationInFrames > 0 &&
          Number.isSafeInteger(item.from + item.durationInFrames),
        "INVALID_TIMELINE_FRAME_BOUNDS",
      );
      if (item.type === "composition") {
        const target = compositions.get(item.compositionId);
        const cadence = target && projectCadenceOf(target);
        assert.ok(
          cadence &&
            Number.isSafeInteger(target.durationInFrames) &&
            target.durationInFrames > 0,
          "COMPOSITION_CADENCE_REQUIRED",
        );
        assert.equal(
          item.sourceFps ?? target.fps,
          cadence.num / cadence.den,
          "COMPOSITION_CADENCE_CHANGED",
        );
        const speed = item.speed ?? 1;
        assert.ok(
          Number.isFinite(speed) &&
            speed > 0 &&
            speedOf(speed).num / speedOf(speed).den === speed,
          "INVALID_SOURCE_SPEED",
        );
        const start = item.sourceStart ?? item.trimStart ?? item.offset ?? 0;
        assert.ok(
          Number.isSafeInteger(start) && start >= 0 && !item.isReversed,
          "COMPOSITION_SOURCE_MAPPING_UNAVAILABLE",
        );
        const end = multiply(
          clipSourceTime(
            {
              from: item.from,
              sourceStart: start,
              sourceCadence: cadence,
              speed,
            },
            item.from + item.durationInFrames,
            projectCadence,
          ),
          cadence,
        );
        assert.ok(
          compare(end, fromInteger(target.durationInFrames)) <= 0,
          "COMPOSITION_SOURCE_RANGE_EXCEEDED",
        );
      }
      if (item.type !== "video") continue;
      const observed = observations.find(
        ({ facts }) => facts.assetId === item.mediaId,
      );
      assert.ok(observed, "SOURCE_TIMING_CHANGED");
      const fps = observed.metadata.fps;
      assert.equal(
        item.sourceFps ?? view.metadata.fps,
        fps,
        "SOURCE_CADENCE_CHANGED",
      );
      if (item.sourceDuration !== undefined)
        assert.equal(
          item.sourceDuration,
          observed.packetCount,
          "SOURCE_DURATION_CHANGED",
        );
      const sourceCadence = tryParseRational(
        timing.sources.find((source) => source.key === observed.key).cadence,
      );
      const speed = item.speed ?? 1;
      const exactSpeed = speedOf(speed);
      assert.ok(
        Number.isFinite(speed) &&
          speed > 0 &&
          exactSpeed.num / exactSpeed.den === speed,
        "INVALID_SOURCE_SPEED",
      );
      const start = item.sourceStart ?? item.trimStart ?? item.offset ?? 0;
      assert.ok(
        Number.isSafeInteger(start) && start >= 0,
        "SOURCE_FRAME_GRID_UNAVAILABLE",
      );
      if (item.sourceEnd !== undefined)
        assert.ok(
          Number.isSafeInteger(item.sourceEnd) &&
            item.sourceEnd > start &&
            item.sourceEnd <= observed.packetCount,
          "SOURCE_RANGE_EXCEEDED",
        );
      if (item.isReversed)
        assert.ok(
          item.sourceEnd !== undefined &&
            compare(sourceCadence, projectCadence) === 0,
          "REVERSE_MIXED_CADENCE_ADAPTER_UNAVAILABLE",
        );
      const clip = {
        from: item.from,
        sourceStart: start,
        sourceCadence,
        speed,
      };
      const consumedEnd = multiply(
        clipSourceTime(clip, item.from + item.durationInFrames, projectCadence),
        sourceCadence,
      );
      assert.ok(
        compare(consumedEnd, fromInteger(observed.packetCount)) <= 0 &&
          (item.sourceEnd === undefined ||
            compare(consumedEnd, fromInteger(item.sourceEnd)) <= 0),
        "SOURCE_RANGE_EXCEEDED",
      );
    }
  }
  return timing;
}
