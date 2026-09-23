import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetRestorationModeSchema, AssetRestorationUpscaleSchema } from 'src/dtos/asset-restoration.dto.js';
import { MlWorkload, MlWorkloadSchema } from 'src/enum.js';

/**
 * Restoration worker contract (FL-114).
 *
 * One restoration inference is one request and one result between the server and a
 * restoration worker (`machine-learning/immich_ml/video_restoration`). The request travels as
 * the `request` form field of `POST /restoration/restore` beside the `media` file; the result
 * comes back base64url-encoded in the `x-restoration-result` header while the body streams the
 * restored file (MP4 for a video, PNG for a still). A failure answers with a
 * {@link RestorationWorkerErrorSchema} body.
 *
 * This is a worker wire contract, not a public API body: only the capability report is exposed,
 * read-only, to administrators. FL-115's lifecycle reaches it through
 * `MachineLearningRepository.restore`, which implements `RestorationInference` from
 * `src/utils/restoration.ts`. The mode is FL-115's `AssetRestorationMode`.
 *
 * Public contract — KEEP IN SYNC WITH `machine-learning/immich_ml/video_restoration/schemas.py`.
 */

export const RESTORATION_PROTOCOL = 'restoration-v1';
export const RESTORATION_RESULT_HEADER = 'x-restoration-result';
/** No output edge exceeds this; the caller passes the exact 4K box for the orientation. */
export const RESTORATION_MAX_OUTPUT_EDGE = 3840;

const SHA256 = /^[0-9a-f]{64}$/;
const RATIONAL = /^[1-9]\d{0,8}\/[1-9]\d{0,8}$/;

export enum RestorationDynamicRange {
  Sdr = 'sdr',
  Hdr = 'hdr',
}

export const RestorationDynamicRangeSchema = z
  .enum(RestorationDynamicRange)
  .describe('Dynamic range a restoration model accepts')
  .meta({ id: 'RestorationDynamicRange' });

/** Why a restoration inference was refused or failed on the worker. */
export enum RestorationWorkerErrorCode {
  InvalidRequest = 'invalid-request',
  ModelUnavailable = 'model-unavailable',
  /** A full render pinned its preview's model fingerprint and the model has changed since. */
  ModelChanged = 'model-changed',
  UnsupportedInput = 'unsupported-input',
  /** The uploaded bytes disagree with what the server described. */
  SourceMismatch = 'source-mismatch',
  Busy = 'busy',
  OutOfMemory = 'out-of-memory',
  /** Wrong frame count or size, or blank frames where the source had content (NaN output). */
  InvalidOutput = 'invalid-output',
  RuntimeFailed = 'runtime-failed',
  Timeout = 'timeout',
}

/** Why a model can or cannot run. Only `available` admits a request. */
export enum RestorationModelState {
  Available = 'available',
  Verifying = 'verifying',
  NotPinned = 'not-pinned',
  RuntimeMissing = 'runtime-missing',
  RuntimeDirty = 'runtime-dirty',
  WeightsMissing = 'weights-missing',
  WeightsMismatch = 'weights-mismatch',
  Unqualified = 'unqualified',
  LicenseUnreviewed = 'license-unreviewed',
  NoGpu = 'no-gpu',
  GpuUnqualified = 'gpu-unqualified',
  InsufficientVram = 'insufficient-vram',
}

export const RestorationModelStateSchema = z
  .enum(RestorationModelState)
  .describe('Why a restoration model can or cannot run; only available admits a request')
  .meta({ id: 'RestorationModelState' });

// ---------------------------------------------------------------------------------------
// Request and result.
// ---------------------------------------------------------------------------------------

const RestorationWorkerSourceSchema = z.object({
  width: z.int().positive().max(16_384),
  height: z.int().positive().max(16_384),
  /** Required for a video, absent for a still. */
  durationMs: z.int().positive().nullable().optional(),
  frameRate: z.string().regex(RATIONAL).nullable().optional(),
  dynamicRange: RestorationDynamicRangeSchema.nullable().optional(),
  bitDepth: z.int().min(8).max(16).nullable().optional(),
});

export const RestorationWorkerRequestSchema = z
  .object({
    protocol: z.literal(RESTORATION_PROTOCOL),
    /** Echoed in the result; an answer for another request is discarded. */
    requestId: z.string().min(1).max(200),
    mode: AssetRestorationModeSchema,
    kind: z.enum(['image', 'video']),
    /** Null: the worker's available model for the mode. A value names one model exactly. */
    modelId: z.string().min(1).max(64).nullable().optional(),
    /** A full render may pass its preview's fingerprint; a changed model is then refused. */
    modelFingerprint: z.string().regex(SHA256).nullable().optional(),
    scale: AssetRestorationUpscaleSchema,
    maxWidth: z.int().min(16).max(RESTORATION_MAX_OUTPUT_EDGE),
    maxHeight: z.int().min(16).max(RESTORATION_MAX_OUTPUT_EDGE),
    keepGrain: z.boolean(),
    seed: z.int().min(0).max(2_147_483_647),
    /** What the server measured about the upload; the worker re-probes and refuses a mismatch. */
    source: RestorationWorkerSourceSchema,
  })
  .refine((request) => request.kind === 'image' || (request.source.durationMs ?? null) !== null, {
    message: 'A video request needs source.durationMs',
  });

export type RestorationWorkerRequest = z.infer<typeof RestorationWorkerRequestSchema>;

const RestorationWeightIdentitySchema = z.object({
  role: z.string(),
  sha256: z.string().regex(SHA256),
});

export const RestorationWorkerResultSchema = z.object({
  protocol: z.literal(RESTORATION_PROTOCOL),
  requestId: z.string(),
  mode: AssetRestorationModeSchema,
  model: z.object({
    id: z.string(),
    family: z.string(),
    mode: AssetRestorationModeSchema,
    revision: z.string(),
    /** Identity of exactly this model and its weights. */
    fingerprint: z.string().regex(SHA256),
    weights: z.array(RestorationWeightIdentitySchema),
    qualificationId: z.string(),
  }),
  output: z.object({
    width: z.int().positive(),
    height: z.int().positive(),
    frameRate: z.string().nullable(),
    frameCount: z.int().positive(),
    durationMs: z.int().nonnegative().nullable(),
    container: z.enum(['mp4', 'png']),
    codec: z.string(),
    dynamicRange: RestorationDynamicRangeSchema,
    bitDepth: z.int(),
    /** `transcoded` when a source codec cannot live in MP4 (PCM, for example) and became AAC. */
    audio: z.enum(['copied', 'transcoded', 'none']),
    bytes: z.int().nonnegative(),
    sha256: z.string().regex(SHA256),
  }),
  timing: z.object({
    decodeMs: z.int().nonnegative(),
    runtimeMs: z.int().nonnegative(),
    encodeMs: z.int().nonnegative(),
    totalMs: z.int().nonnegative(),
    /** Measured frames restored per second of runtime. */
    framesPerSecond: z.number().meta({ format: 'double' }).nonnegative(),
  }),
  /** Device-wide peak GPU memory while the runtime ran, or null when it was not sampled. */
  peakVramBytes: z.int().nonnegative().nullable(),
  seed: z.int(),
  warnings: z.array(z.string()),
});

export type RestorationWorkerResult = z.infer<typeof RestorationWorkerResultSchema>;

export const RestorationWorkerErrorSchema = z.object({
  code: z.enum(RestorationWorkerErrorCode),
  message: z.string(),
  modelId: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------------------
// Capability report.
// ---------------------------------------------------------------------------------------

const RestorationMeasuredThroughputSchema = z
  .object({
    gpu: z.string().describe('GPU the measurement was made on, as nvidia-smi names it'),
    inputWidth: z.int(),
    inputHeight: z.int(),
    frames: z.int(),
    framesPerSecond: z.number().meta({ format: 'double' }).describe('Measured frames restored per second'),
    peakVramBytes: z.number().meta({ format: 'double' }).describe('Measured peak GPU memory'),
  })
  .meta({ id: 'RestorationMeasuredThroughputDto' });

export type RestorationMeasuredThroughput = z.infer<typeof RestorationMeasuredThroughputSchema>;

const RestorationModelCapabilitySchema = z
  .object({
    id: z.string(),
    family: z.string().describe('Model family, for example realbasicvsr or seedvr2'),
    mode: AssetRestorationModeSchema,
    displayName: z.string(),
    revision: z.string().describe('Pinned upstream commit'),
    fingerprint: z
      .string()
      .nullable()
      .describe('Identity of the model and its verified weights, or null until the weights are verified'),
    state: RestorationModelStateSchema,
    reasons: z.array(z.string()).describe('Every reason the model is not available; empty when it is'),
    nativeScale: z.int().nullable().describe('Fixed enlargement the model restores at, or null'),
    maxInputLongEdge: z.int().describe('Largest source long edge the model is qualified for'),
    maxFrames: z.int().describe('Largest number of frames one inference may restore'),
    dynamicRanges: z.array(RestorationDynamicRangeSchema).describe('Source dynamic ranges the model accepts'),
    measured: z
      .array(RestorationMeasuredThroughputSchema)
      .describe('Throughput measured during qualification; estimates come from these'),
    qualificationId: z.string().nullable().describe('Qualification record covering this model, or null'),
  })
  .meta({ id: 'RestorationModelCapabilityDto' });

export type RestorationModelCapability = z.infer<typeof RestorationModelCapabilitySchema>;

const RestorationGpuSchema = z
  .object({
    name: z.string(),
    memoryTotalBytes: z.number().meta({ format: 'double' }),
    driverVersion: z.string(),
  })
  .meta({ id: 'RestorationGpuDto' });

/** The worker's own report (`GET /restoration/models`). Unknown workload names are dropped. */
export const RestorationCapabilityReportSchema = z.object({
  protocol: z.literal(RESTORATION_PROTOCOL),
  workloads: z.array(z.string()),
  models: z.array(RestorationModelCapabilitySchema),
  gpus: z.array(RestorationGpuSchema),
  configurationProblems: z.array(z.string()),
  checkedAt: z.string(),
});

export type RestorationCapabilityReport = Omit<z.infer<typeof RestorationCapabilityReportSchema>, 'workloads'> & {
  workloads: MlWorkload[];
};

const MlRestorationModelsResponseSchema = z
  .object({
    destinationId: z.uuidv4(),
    reachable: z.boolean().describe('Whether the destination answered with a restoration report'),
    error: z.string().nullable().describe('Why no report could be read, or null'),
    workloads: z
      .array(MlWorkloadSchema)
      .describe('Restoration workloads the destination serves now; empty unless a model is available'),
    models: z.array(RestorationModelCapabilitySchema),
    gpus: z.array(RestorationGpuSchema),
    configurationProblems: z
      .array(z.string())
      .describe('Problems reading the model manifest or qualification evidence on the destination'),
    checkedAt: z.string().nullable().describe('When the destination last verified its models, or null'),
  })
  .meta({ id: 'MlRestorationModelsResponseDto' });

export class MlRestorationModelsResponseDto extends createZodDto(MlRestorationModelsResponseSchema) {}
export class RestorationModelCapabilityDto extends createZodDto(RestorationModelCapabilitySchema) {}
