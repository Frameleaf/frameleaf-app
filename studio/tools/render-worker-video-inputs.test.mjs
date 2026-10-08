import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaimImageInputs } from "./render-worker-image-inputs.mjs";

const folder = await mkdtemp(path.join(tmpdir(), "frameleaf-video-specimen-"));
const file = path.join(folder, "specimen.mp4");
execFileSync(
  "ffmpeg",
  [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x48:rate=24:duration=1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
    "-x264-params",
    "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
    "-video_track_timescale",
    "12288",
    file,
  ],
  { timeout: 10000 },
);
const bytes = await readFile(file);
await rm(folder, { recursive: true, force: true });
const id = "11111111-1111-4111-8111-111111111111";
const key = `library-asset:${id}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  return {
    operationId: randomUUID(),
    claimToken: randomUUID(),
    revisionId: "bound-video",
    snapshot: {
      studio: {
        graph: {
          id: "p",
          duration: 1,
          metadata: { width: 64, height: 48, fps: 24 },
          timeline: {
            tracks: [{ id: "v1", kind: "video" }],
            items: [
              {
                id: "v",
                type: "video",
                mediaId: id,
                trackId: "v1",
                from: 0,
                durationInFrames: 24,
                sourceFps: 24,
                sourceStart: 0,
                sourceEnd: 24,
                sourceDuration: 24,
              },
            ],
            transitions: [],
            keyframes: [],
          },
        },
        resources: [
          {
            key,
            kind: "library-asset",
            id,
            graphPath: "/timeline/items/0",
            grant: "render",
            checksum: sha(bytes),
          },
        ],
      },
      timing: {
        cadence: "24/1",
        sources: [
          {
            key,
            assetId: id,
            timeBase: "1/12288",
            originTicks: 0,
            cadence: "24/1",
            variableFrameRate: false,
            trackTimescale: 12288,
            audio: null,
          },
        ],
      },
    },
    inputs: new Map([
      [
        key,
        {
          kind: "library-asset",
          resourceId: id,
          declaredChecksum: sha(bytes),
          sha256: sha(bytes),
          bytes: Buffer.from(bytes),
        },
      ],
    ]),
  };
}

test("native packet scan and actual MediaBunny bytes admit video metadata without changing graph", async () => {
  const prepared = fixture();
  const graph = structuredClone(prepared.snapshot.studio.graph);
  const adapter = await createClaimImageInputs(prepared, () => true);
  try {
    assert.deepEqual(adapter.input.project, graph);
    const metadata = adapter.input.media[0].metadata;
    assert.deepEqual(
      [
        metadata.width,
        metadata.height,
        metadata.fps,
        metadata.duration,
        metadata.codec,
      ],
      [64, 48, 24, 1, "h264"],
    );
    assert.equal(metadata.fileSize, bytes.length);
    assert.equal(metadata.mimeType, "video/mp4");
    assert.equal(metadata.embeddedAudioTrackAbsent, true);
    assert.deepEqual(
      adapter.videoTiming.sources,
      prepared.snapshot.timing.sources,
    );
    assert.equal(adapter.videoInputs[0].sha256, sha(bytes));
    const response = await fetch(adapter.input.media[0].url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    await adapter.dispose();
  }
});
for (const [name, modify, expected] of [
  [
    "forged time base",
    (f) => {
      f.snapshot.timing.sources[0].timeBase = "1/24";
    },
    /SOURCE_TIMING_CHANGED/,
  ],
  [
    "missing source",
    (f) => {
      f.snapshot.timing.sources = [];
    },
    /SOURCE_TIMING_CHANGED/,
  ],
  [
    "forged source fps",
    (f) => {
      f.snapshot.studio.graph.timeline.items[0].sourceFps = 30;
    },
    /SOURCE_CADENCE_CHANGED/,
  ],
  [
    "forged source duration",
    (f) => {
      f.snapshot.studio.graph.timeline.items[0].sourceDuration = 30;
    },
    /SOURCE_DURATION_CHANGED/,
  ],
  [
    "out of source range",
    (f) => {
      f.snapshot.studio.graph.timeline.items[0].sourceEnd = 25;
    },
    /SOURCE_RANGE_EXCEEDED/,
  ],
  [
    "changed bytes",
    (f) => {
      f.inputs.get(key).bytes[10] ^= 1;
    },
    /VERIFIED_INPUT_CHANGED/,
  ],
  [
    "forged digest",
    (f) => {
      f.inputs.get(key).declaredChecksum = "00".repeat(32);
      f.snapshot.studio.resources[0].checksum = "00".repeat(32);
    },
    /INPUT_CHECKSUM_MISMATCH/,
  ],
  [
    "revoked grant",
    (f) => {
      f.snapshot.studio.resources[0].grant = "none";
    },
    /UNEXPECTED_RESOURCE_BYTES/,
  ],
])
  test(`video admission refuses ${name} before exposing media`, async () => {
    const prepared = fixture();
    modify(prepared);
    await assert.rejects(
      createClaimImageInputs(prepared, () => true),
      expected,
    );
  });
test("lease cancellation during genuine native inspection refuses and cleans owned bytes", async () => {
  const prepared = fixture();
  let live = true;
  const pending = createClaimImageInputs(prepared, () => live);
  setTimeout(() => {
    live = false;
  }, 1);
  await assert.rejects(pending, /LEASE_LOST/);
  assert.deepEqual(prepared.inputs.get(key).bytes, bytes); // caller still owns the signed snapshot
});

test("the shared native packet probe cancels a live process through operation authority, without a queue claim", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const {
    MediaRepository,
  } = require("../../server/dist/repositories/media.repository.js");
  const {
    LoggingRepository,
  } = require("../../server/dist/repositories/logging.repository.js");
  const {
    operationExecution,
  } = require("../../server/dist/utils/execution-signal.js");
  const folder = await mkdtemp(path.join(tmpdir(), "frameleaf-probe-cancel-"));
  const fifo = path.join(folder, "blocked-native-input");
  execFileSync("mkfifo", [fifo]);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("CONTROLLED_OPERATION_CANCELLED")),
    100,
  );
  const started = performance.now();
  try {
    await assert.rejects(
      operationExecution.run(
        {
          signal: controller.signal,
          settled: false,
          completed: new Map(),
          progress: () => {},
          settle: async () => {},
        },
        () =>
          new MediaRepository(LoggingRepository.create()).probePackets(fifo, 0),
      ),
      /CONTROLLED_OPERATION_CANCELLED/,
    );
    assert.ok(
      performance.now() - started < 5000,
      "NATIVE_PROCESS_DID_NOT_CLOSE",
    );
  } finally {
    clearTimeout(timer);
    await rm(folder, { recursive: true, force: true });
  }
});
test("the actual Library SHA-1 checksum spelling remains byte-bound for video", async () => {
  const prepared = fixture();
  const checksum = createHash("sha1").update(bytes).digest("base64");
  prepared.inputs.get(key).declaredChecksum = checksum;
  prepared.snapshot.studio.resources[0].checksum = checksum;
  const adapter = await createClaimImageInputs(prepared, () => true);
  await adapter.dispose();
});

test("a bounded genuine packet scan refuses oversized presentation inventory before retaining it", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const {
    MediaRepository,
  } = require("../../server/dist/repositories/media.repository.js");
  const {
    LoggingRepository,
  } = require("../../server/dist/repositories/logging.repository.js");
  const folder = await mkdtemp(path.join(tmpdir(), "frameleaf-packet-limit-"));
  const file = path.join(folder, "bounded.mp4");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, bytes, { mode: 0o600 });
  try {
    await assert.rejects(
      new MediaRepository(LoggingRepository.create()).probePackets(file, 0, {
        maxPackets: 4,
      }),
      /resource limit/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test("genuinely variable packet durations are refused rather than assigned a guessed source fps", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "frameleaf-vfr-"));
  const file = path.join(folder, "variable.mp4");
  try {
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x48:rate=24:duration=1",
        "-vf",
        "setpts=if(lt(N\\,12)\\,N/(24*TB)\\,(0.5+(N-12)/12)/TB)",
        "-fps_mode",
        "vfr",
        "-an",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-video_track_timescale",
        "12288",
        file,
      ],
      { timeout: 10000 },
    );
    const scan = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-show_packets",
        "-of",
        "json",
        file,
      ]),
    );
    assert.ok(
      new Set(scan.packets.map((packet) => packet.duration)).size > 1,
      "SPECIMEN_NOT_VARIABLE",
    );
    const variable = await readFile(file);
    const prepared = fixture();
    prepared.inputs.get(key).bytes = variable;
    prepared.inputs.get(key).sha256 = sha(variable);
    prepared.inputs.get(key).declaredChecksum = sha(variable);
    prepared.snapshot.studio.resources[0].checksum = sha(variable);
    await assert.rejects(
      createClaimImageInputs(prepared, () => true),
      /VFR_OR_IRREGULAR_SOURCE_ADAPTER_UNAVAILABLE/,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
