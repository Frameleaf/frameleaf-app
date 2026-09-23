import { createHash } from 'node:crypto';
import path from 'node:path';
import z from 'zod';
import {
  AssetRestorationMode,
  AssetRestorationModeSchema,
  AssetRestorationRegion,
  AssetRestorationRegionSchema,
  AssetRestorationSourceType,
  AssetRestorationSourceTypeSchema,
  AssetRestorationStatus,
  AssetRestorationUpscaleSchema,
} from 'src/dtos/asset-restoration.dto.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MlDestinationKind,
  MlDestinationKindSchema,
  MlWorkload,
  MlWorkloadSchema,
} from 'src/enum.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { MlThroughputSample } from 'src/repositories/ml-destination.repository.js';

/**
 * The rules of preview-first restoration (FL-115), kept free of the database and the network.
 *
 * Four things live here:
 *
 * 1. Sizing. The preview crop in pixels, the 4K cap on the full output, and the byte figures the
 *    measured estimate is derived from.
 * 2. The state machine: which owner actions each status allows, and which statuses a stage of
 *    work may (re)start from — the latter is what makes an automatic retry safe.
 * 3. The immutable snapshot a durable job carries, and its parser, so a worker never trusts a
 *    row it cannot read back exactly.
 * 4. The inference seam: the one method the ML repository is expected to grow (FL-114). Nothing
 *    here calls it; the worker asks `restorationInferenceOf` whether it exists and fails honestly
 *    when it does not.
 */

/** 4K: the longest edge of a full result never exceeds this, whatever the upscale asked for. */
export const RESTORATION_OUTPUT_CAP = { long: 3840, short: 2160 } as const;

/** Longest edge of a still preview's input. Small enough to be quick, large enough to judge. */
export const RESTORATION_PREVIEW_EDGE = 1024;

/** Length of a video preview clip. Fixed so previews stay cheap and comparable. */
export const RESTORATION_PREVIEW_SECONDS = 5;

/** Full video renders are cut into chunks of this length; each chunk is a reusable checkpoint. */
export const RESTORATION_CHUNK_SECONDS = 20;

/** A preview nobody reviews is removed after this many days. */
export const RESTORATION_PREVIEW_UNREVIEWED_DAYS = 14;

/** After a decision the preview files stay this long for comparison, then go. */
export const RESTORATION_PREVIEW_AFTER_DECISION_DAYS = 7;

/** Both restoration kinds the worker claims. */
export const RESTORATION_OPERATION_KINDS: readonly MediaOperationKind[] = [
  MediaOperationKind.RestorationPreview,
  MediaOperationKind.Restoration,
];

/** Stable failure codes Activity turns into a message. */
export const RestorationErrorCode = {
  AdapterMissing: 'restoration_adapter_missing',
  SnapshotInvalid: 'restoration_snapshot_invalid',
  RestorationMissing: 'restoration_missing',
  StageNotRunnable: 'restoration_stage_not_runnable',
  SourceMissing: 'restoration_source_missing',
  SourceChanged: 'restoration_source_changed',
  DestinationRefused: 'restoration_destination_refused',
  OutputInvalid: 'restoration_output_invalid',
  LeaseLost: 'restoration_lease_lost',
  Failed: 'restoration_failed',
} as const;

export type RestorationStage = 'preview' | 'full';

export const workloadForMode = (mode: AssetRestorationMode): MlWorkload =>
  mode === AssetRestorationMode.Creative ? MlWorkload.RestorationCreative : MlWorkload.RestorationFaithful;

export const stageOfKind = (kind: MediaOperationKind): RestorationStage | null => {
  switch (kind) {
    case MediaOperationKind.RestorationPreview: {
      return 'preview';
    }
    case MediaOperationKind.Restoration: {
      return 'full';
    }
    default: {
      return null;
    }
  }
};

/** The destination enums share their values on purpose; this keeps the mapping explicit anyway. */
export const mediaOperationDestinationOf = (kind: MlDestinationKind): MediaOperationDestination => {
  switch (kind) {
    case MlDestinationKind.Local: {
      return MediaOperationDestination.Local;
    }
    case MlDestinationKind.Lan: {
      return MediaOperationDestination.Lan;
    }
    case MlDestinationKind.RunPod: {
      return MediaOperationDestination.RunPod;
    }
  }
};

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Output files sit beside the asset's other derived images, named by restoration id so two
 * restorations never share a path and a re-run of one (an automatic retry included) lands on the
 * same paths instead of producing a second copy.
 */
export const restorationOutputPaths = (base: string, assetId: string, restorationId: string) => {
  const prefix = path.join(base, `${assetId}_restore_${restorationId}`);
  return {
    before: `${prefix}_before`,
    after: `${prefix}_after`,
    result: `${prefix}_result`,
    resultPreview: `${prefix}_result_preview.jpg`,
  };
};

/** Scratch space for chunk outputs and temporary files; removed once the result is published. */
export const restorationWorkDir = (base: string, restorationId: string) => path.join(base, `restore_${restorationId}_work`);

/* ------------------------------------------------------------------ */
/* Sizing                                                              */
/* ------------------------------------------------------------------ */

export type PixelRect = { left: number; top: number; width: number; height: number };

/**
 * The preview area in source pixels. Clamped inside the frame and never smaller than 16 px on a
 * side, so a degenerate region cannot produce an empty extract.
 */
export const previewRegionPixels = (region: AssetRestorationRegion, width: number, height: number): PixelRect => {
  const left = Math.min(Math.max(0, Math.round(region.x * width)), Math.max(0, width - 16));
  const top = Math.min(Math.max(0, Math.round(region.y * height)), Math.max(0, height - 16));
  const w = Math.max(16, Math.min(Math.round(region.w * width), width - left));
  const h = Math.max(16, Math.min(Math.round(region.h * height), height - top));
  return { left, top, width: Math.min(w, width), height: Math.min(h, height) };
};

/** Whether the region covers the whole frame, in which case no crop is applied at all. */
export const isFullRegion = (region: AssetRestorationRegion) =>
  region.x <= 0 && region.y <= 0 && region.w >= 0.999 && region.h >= 0.999;

/**
 * The size the full render produces: the source multiplied by the upscale, then capped at 4K on
 * both edges with the aspect ratio kept. `scale` is the factor actually applied, so the interface
 * can say "2× (capped)" honestly when the cap won.
 */
export const cappedOutputSize = (width: number, height: number, upscale: number) => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const long = Math.max(safeWidth, safeHeight);
  const short = Math.min(safeWidth, safeHeight);
  const capScale = Math.min(RESTORATION_OUTPUT_CAP.long / long, RESTORATION_OUTPUT_CAP.short / short);
  const scale = Math.min(upscale, capScale);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    scale,
    capped: scale < upscale,
  };
};

/**
 * Roughly how many bytes the preview uploads, derived from the original's size: the fraction of
 * the frame the region covers, further reduced when the region is downscaled to the preview edge.
 * Video previews scale by clip length instead. An arithmetic approximation, labelled as such.
 */
export const previewInputBytes = (
  sourceBytes: number,
  region: AssetRestorationRegion,
  width: number,
  height: number,
  sourceType: AssetRestorationSourceType,
  durationSeconds: number | null,
): number => {
  const area = Math.min(1, Math.max(0.01, region.w * region.h));
  if (sourceType === AssetRestorationSourceType.Video) {
    const clip = durationSeconds && durationSeconds > 0 ? Math.min(1, RESTORATION_PREVIEW_SECONDS / durationSeconds) : 1;
    return Math.round(sourceBytes * area * clip);
  }
  const rect = previewRegionPixels(region, width, height);
  const longest = Math.max(rect.width, rect.height);
  const downscale = longest > RESTORATION_PREVIEW_EDGE ? (RESTORATION_PREVIEW_EDGE / longest) ** 2 : 1;
  return Math.round(sourceBytes * area * downscale);
};

/** Seconds for `bytes` at the measured rate, or null when nothing has been measured. */
export const estimateSeconds = (bytes: number, sample: MlThroughputSample): number | null => {
  if (sample.sampleCount <= 0 || sample.durationMs <= 0 || sample.bytesSent <= 0) {
    return null;
  }
  const bytesPerSecond = (sample.bytesSent * 1000) / sample.durationMs;
  return Math.round((bytes / bytesPerSecond) * 10) / 10;
};

export const measuredBytesPerSecond = (sample: MlThroughputSample): number | null =>
  sample.sampleCount > 0 && sample.durationMs > 0 ? (sample.bytesSent * 1000) / sample.durationMs : null;

/** The estimate as the API shows it. Null seconds mean "not measured", never zero. */
export const restorationEstimate = (
  sample: MlThroughputSample,
  bytes: { preview: number; full: number },
  windowDays: number,
) => ({
  sampleCount: sample.sampleCount,
  bytesPerSecond: measuredBytesPerSecond(sample),
  windowDays,
  previewBytes: bytes.preview,
  fullBytes: bytes.full,
  previewSeconds: estimateSeconds(bytes.preview, sample),
  fullSeconds: estimateSeconds(bytes.full, sample),
});

/* ------------------------------------------------------------------ */
/* State machine                                                       */
/* ------------------------------------------------------------------ */

/** Statuses where a job is queued or running for the restoration. */
export const ACTIVE_RESTORATION_STATUSES: readonly AssetRestorationStatus[] = [
  AssetRestorationStatus.PreviewQueued,
  AssetRestorationStatus.PreviewRendering,
  AssetRestorationStatus.Accepted,
  AssetRestorationStatus.Restoring,
];

export const isActiveRestoration = (status: AssetRestorationStatus) => ACTIVE_RESTORATION_STATUSES.includes(status);

/** Only a reviewed-ready preview can be accepted or rejected. */
export const canAcceptRestoration = (status: AssetRestorationStatus) => status === AssetRestorationStatus.PreviewReady;
export const canRejectRestoration = canAcceptRestoration;

/** Only a finished full result may become the playback version. */
export const canSelectRestoration = (status: AssetRestorationStatus) => status === AssetRestorationStatus.Restored;

/** Anything idle may be discarded; a running one is cancelled first by the service. */
export const canDiscardRestoration = (status: AssetRestorationStatus) =>
  status !== AssetRestorationStatus.Discarded && status !== AssetRestorationStatus.Expired;

/**
 * The statuses a stage of work may start from.
 *
 * This is what makes an automatic retry (FL-32's retry-once on the media operation layer, and
 * FL-104's requeue after a lost lease) safe: a stage may resume from its own queued, running,
 * failed or cancelled state, and from nothing else. A retry can therefore never re-run a preview
 * over an accepted restoration or a full render over a rejected one.
 */
export const RUNNABLE_STATUSES: Readonly<Record<RestorationStage, readonly AssetRestorationStatus[]>> = {
  preview: [
    AssetRestorationStatus.PreviewQueued,
    AssetRestorationStatus.PreviewRendering,
    AssetRestorationStatus.PreviewFailed,
    AssetRestorationStatus.PreviewCancelled,
  ],
  full: [
    AssetRestorationStatus.Accepted,
    AssetRestorationStatus.Restoring,
    AssetRestorationStatus.RestoreFailed,
    AssetRestorationStatus.RestoreCancelled,
  ],
};

export const canRunStage = (stage: RestorationStage, status: AssetRestorationStatus) =>
  RUNNABLE_STATUSES[stage].includes(status);

/** The status a stage moves to when it starts, succeeds, fails or is cancelled. */
export const STAGE_STATUSES: Readonly<
  Record<
    RestorationStage,
    { running: AssetRestorationStatus; done: AssetRestorationStatus; failed: AssetRestorationStatus; cancelled: AssetRestorationStatus }
  >
> = {
  preview: {
    running: AssetRestorationStatus.PreviewRendering,
    done: AssetRestorationStatus.PreviewReady,
    failed: AssetRestorationStatus.PreviewFailed,
    cancelled: AssetRestorationStatus.PreviewCancelled,
  },
  full: {
    running: AssetRestorationStatus.Restoring,
    done: AssetRestorationStatus.Restored,
    failed: AssetRestorationStatus.RestoreFailed,
    cancelled: AssetRestorationStatus.RestoreCancelled,
  },
};

const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

/** When an unreviewed preview's files are removed. */
export const previewExpiryAfterReady = (now: Date) => addDays(now, RESTORATION_PREVIEW_UNREVIEWED_DAYS);

/** When the preview files of a decided restoration are removed. */
export const previewExpiryAfterDecision = (now: Date) => addDays(now, RESTORATION_PREVIEW_AFTER_DECISION_DAYS);

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

/**
 * The immutable binding a restoration job carries. Written once at submit, copied verbatim by a
 * retry, and the only thing the worker trusts about what to do. The checksum is hex so the row
 * is readable in the Activity detail view.
 */
export const RestorationSnapshotSchema = z.object({
  version: z.literal(1),
  stage: z.enum(['preview', 'full']),
  restorationId: z.string().min(1),
  assetId: z.string().min(1),
  ownerId: z.string().min(1),
  sourceType: AssetRestorationSourceTypeSchema,
  sourceChecksumHex: z.string().min(1),
  sourceWidth: z.int().min(1),
  sourceHeight: z.int().min(1),
  sourceDurationSeconds: z.number().nullable(),
  mode: AssetRestorationModeSchema,
  upscale: AssetRestorationUpscaleSchema,
  keepGrain: z.boolean(),
  workload: MlWorkloadSchema,
  destinationId: z.string().min(1),
  destinationKind: MlDestinationKindSchema,
  region: AssetRestorationRegionSchema,
  output: z.object({ width: z.int().min(1), height: z.int().min(1) }),
});

export type RestorationSnapshot = z.infer<typeof RestorationSnapshotSchema>;

export const parseRestorationSnapshot = (value: unknown): RestorationSnapshot | null => {
  const result = RestorationSnapshotSchema.safeParse(value);
  return result.success ? result.data : null;
};

/* ------------------------------------------------------------------ */
/* Video chunks                                                        */
/* ------------------------------------------------------------------ */

export type RestorationChunk = { sequence: number; startSeconds: number; endSeconds: number };

/** Cut a video into chunks of at most `chunkSeconds`. The last chunk absorbs the remainder. */
export const planRestorationChunks = (durationSeconds: number, chunkSeconds = RESTORATION_CHUNK_SECONDS): RestorationChunk[] => {
  if (!(durationSeconds > 0)) {
    return [];
  }
  const count = Math.max(1, Math.ceil(durationSeconds / chunkSeconds));
  return Array.from({ length: count }, (_, index) => ({
    sequence: index,
    startSeconds: index * chunkSeconds,
    endSeconds: index === count - 1 ? durationSeconds : (index + 1) * chunkSeconds,
  }));
};

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The checkpoint identity for one chunk (FL-104's reuse key). Every input that changes the output
 * is in the key: the exact source, the model binding and the time range. A chunk from a different
 * source, mode or destination can never be mistaken for this one, whatever its number.
 */
export const restorationChunkIdentity = (snapshot: RestorationSnapshot, chunk: RestorationChunk) => {
  const inputDigest = sha256Hex(`${snapshot.sourceChecksumHex}:${chunk.startSeconds}:${chunk.endSeconds}`);
  const historyDigest = sha256Hex(`restoration/1:${snapshot.stage}`);
  const configDigest = sha256Hex(
    JSON.stringify({
      mode: snapshot.mode,
      upscale: snapshot.upscale,
      keepGrain: snapshot.keepGrain,
      workload: snapshot.workload,
      destinationId: snapshot.destinationId,
      output: snapshot.output,
    }),
  );
  const startTicks = BigInt(Math.round(chunk.startSeconds * 1000));
  const endTicks = BigInt(Math.round(chunk.endSeconds * 1000));
  return {
    sequence: chunk.sequence,
    inputDigest,
    historyDigest,
    configDigest,
    seed: null,
    timebase: '1/1000',
    startTicks,
    endTicks,
    requiresSequentialContext: false,
    chunkKey: sha256Hex(`${inputDigest}:${historyDigest}:${configDigest}:${startTicks}:${endTicks}`),
  };
};

/* ------------------------------------------------------------------ */
/* Inference seam                                                      */
/* ------------------------------------------------------------------ */

export type RestorationInferenceInput =
  | { kind: 'image'; path: string; width: number; height: number }
  | { kind: 'video'; path: string; width: number; height: number; durationSeconds: number };

export type RestorationInferenceOptions = {
  mode: AssetRestorationMode;
  upscale: 1 | 2 | 4;
  keepGrain: boolean;
  /** The adapter must not produce an output larger than this on either edge. */
  maxWidth: number;
  maxHeight: number;
  /** Where the adapter writes the restored file. The worker validates it before publishing. */
  outputPath: string;
  /** The durable job id, for the destination's accounting row. */
  jobId: string;
  signal: AbortSignal;
};

export type RestorationInferenceResult = {
  outputPath: string;
  width: number;
  height: number;
  modelName: string;
  modelVersion: string | null;
};

/**
 * The single method restoration needs from the machine-learning repository. FL-114 provides the
 * model adapters and the request/response contract; this is the signature FL-115 assumes:
 *
 * `restore(selection, input, options)` sends one file to the admitted destination named by
 * `selection` (FL-110's `MlSelection`, whose `record` hook lands the accounting row), writes the
 * restored file to `options.outputPath`, and resolves with what it produced. It rejects on any
 * failure and never retries against another destination.
 */
export interface RestorationInference {
  restore(
    selection: MlSelection,
    input: RestorationInferenceInput,
    options: RestorationInferenceOptions,
  ): Promise<RestorationInferenceResult>;
}

/** The repository as an inference provider, or null while no adapter is installed. */
export const restorationInferenceOf = (repository: unknown): RestorationInference | null =>
  repository && typeof (repository as { restore?: unknown }).restore === 'function'
    ? (repository as RestorationInference)
    : null;
