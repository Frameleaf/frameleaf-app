import z from 'zod';
import { MediaOperationKind, MediaOperationStatus, MlWorkload } from 'src/enum.js';
import {
  CLOUD_JOB_STATUSES,
  CloudEstimate,
  CloudJobView,
  CloudOutputDownload,
  isFinalCloudJobStatus,
} from 'src/utils/frameleaf-cloud.js';

/**
 * Frameleaf Cloud restoration, upscaling and Smooth motion jobs (FL-162, `CLD-202`).
 *
 * A job is a `media_operation` of kind `cloud_ml_job`. Its snapshot freezes what the owner confirmed:
 * the prepared, metadata-free inputs and their digests, the model and its revision, the request, the
 * estimate shown and the consent given. Its result records where the cloud job is, so a restart, a
 * lost claim or the automatic retry carries on from the cloud job it already started (never a second
 * one). The constants are documented for administrators in docs/administration/frameleaf-cloud.md
 * ("Restoration and Smooth motion on Frameleaf Cloud"); change both together.
 */

/** How often the worker looks for cloud jobs with a step due. */
export const CLOUD_ML_JOB_TICK_MS = 5000;
/** A step's claim lease; a long upload or download renews it while it runs. */
export const CLOUD_ML_JOB_LEASE_MS = 5 * 60_000;
/** Steps one tick takes at most, so a burst of polls never holds the worker for long. */
export const CLOUD_ML_JOB_STEPS_PER_TICK = 10;
/** How long to wait before reading a job again when the cloud named no `Retry-After`. */
export const CLOUD_ML_JOB_POLL_MS = 5000;
/** The longest wait between two reads of a running job, whatever `Retry-After` said. */
export const CLOUD_ML_JOB_MAX_POLL_MS = 60_000;
/** A job that has settled but whose cost is not reported yet is read this often, at most this many times. */
export const CLOUD_ML_JOB_COST_POLL_MS = 15_000;
export const CLOUD_ML_JOB_COST_READS = 8;
/**
 * A sealed estimate expires after 15 minutes (the cloud's rule). When the queue held a job past it,
 * the worker estimates again and sends the job only while the new high end stays within 10 % of the
 * one the owner confirmed; anything above that stops the job and nothing is sent.
 */
export const CLOUD_ML_JOB_PRICE_TOLERANCE = 1.1;
/** Sealed estimates one job may ask for before it gives up (a model or price that keeps moving). */
export const CLOUD_ML_JOB_MAX_ESTIMATES = 3;
/** Frameleaf Cloud fans a long video out to at most this many serverless workers (FC-39). */
export const CLOUD_ML_JOB_MAX_WORKERS = 5;
/** Unconfirmed estimates kept at once per person; an older one is estimated again. */
export const CLOUD_ML_JOB_ESTIMATES_KEPT = 10;
/**
 * Transient failures in a row a job with a cloud job may meet while it uploads or collects its result
 * before it fails: each one waits (doubling, up to `CLOUD_ML_JOB_MAX_POLL_MS`) and tries again without
 * spending the job's automatic retry. A running job's reads are never counted: it is read until it ends.
 */
export const CLOUD_ML_JOB_MAX_TRANSIENT_FAILURES = 8;
/** Reads of a running job refused as unauthorized in a row (at least a minute apart: a day) before it fails. */
export const CLOUD_ML_JOB_MAX_UNAUTHORIZED_READS = 24 * 60;
/** How long a person waits before asking for another full-video estimate while one is being prepared. */
export const CLOUD_ML_JOB_PREPARING_RETRY_SECONDS = 5;
/**
 * FC-47 (owner decision 2026-09-27): a video restoration or Smooth motion job stopped at its model's
 * 6-hour runtime cap (`runtime-cap`). It is charged for the GPU time it used up to the cap, delivers
 * nothing, and is never retried automatically: the clip has to be split.
 */
export const CLOUD_ML_JOB_RUNTIME_CAP_MESSAGE =
  'This video reached Frameleaf Cloud’s 6-hour processing limit and was stopped. You are charged for the processing it used up to the limit. Split the clip into shorter parts and run each one.';

/** A Smooth motion or restoration preview is a clip of this many seconds. */
export const CLOUD_ML_JOB_PREVIEW_SECONDS = 5;

/** What the job makes: a restoration (upscaling for photos) or Smooth motion frame interpolation. */
export const CLOUD_ML_JOB_PURPOSES = ['restoration', 'smooth-motion'] as const;
export type CloudMlJobPurpose = (typeof CLOUD_ML_JOB_PURPOSES)[number];

/** Preview-first: a short clip or a crop first, then the full render the owner accepts. */
export const CLOUD_ML_JOB_STAGES = ['preview', 'full'] as const;
export type CloudMlJobStage = (typeof CLOUD_ML_JOB_STAGES)[number];

/** The Smooth motion frame-rate factors Frameleaf Cloud's interpolation request allows. */
export const SMOOTH_MOTION_FACTORS = [2, 4, 8] as const;
export type SmoothMotionFactor = (typeof SMOOTH_MOTION_FACTORS)[number];

/** The cloud workloads a job of this kind is sent as. */
export type CloudMlJobWorkload = 'restoration' | 'upscale' | 'interpolation';

/**
 * The stages Activity shows (prototype `activity-feed.mjs`): Queued → Starting (cold start) → Running
 * → Done, Failed or Cancelled, or Paused while held before it reached the cloud's workers.
 */
export const CLOUD_ML_JOB_ACTIVITY_STAGES = [
  'queued',
  'starting',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
] as const;
export type CloudMlJobActivityStage = (typeof CLOUD_ML_JOB_ACTIVITY_STAGES)[number];

/** Where the worker is with a job; each phase resumes from what the result recorded. */
export enum CloudMlJobPhase {
  /** Confirmed; nothing sent yet. The next step estimates again when needed and submits. */
  Queued = 'queued',
  /** `POST /v2/jobs` admitted it; inputs are being uploaded. */
  Uploading = 'uploading',
  /** Every input is uploaded and the job was started; it is polled until it ends. */
  Started = 'started',
  /** The job ended; its outputs are downloaded, checked and published, then acknowledged and settled. */
  Ending = 'ending',
  /** Nothing is left to do with the cloud job. */
  Finished = 'finished',
}

const usd = z.number().min(0);
const sha256Hex = z.string().regex(/^[\da-f]{64}$/);

export const CloudMlJobInputSchema = z.object({
  inputId: z.string().regex(/^[\w-]{1,64}$/),
  contentType: z.string().regex(/^[a-z]+\/[\d+.a-z-]{1,100}$/),
  bytes: z.number().int().min(1),
  sha256: sha256Hex,
  /** The prepared, metadata-free copy that is uploaded; never the original. */
  path: z.string().min(1),
});
export type CloudMlJobInput = z.infer<typeof CloudMlJobInputSchema>;

/** The estimate the owner confirmed, as shown: GPU time × rate + start fee, p50–p90. */
export const CloudMlJobApprovalSchema = z.object({
  estimateId: z.string().min(1),
  p50Usd: usd,
  p90Usd: usd,
  holdUsd: usd,
  startupUsd: usd,
  minimumUsd: usd,
  startFeeUsd: usd,
  perSecondUsd: usd,
  plannedWorkers: z.int().min(1).max(CLOUD_ML_JOB_MAX_WORKERS),
  coldStartSeconds: z.number().min(0),
  runSeconds: z.number().min(0),
  basis: z.enum(['measured', 'modelled']),
});
export type CloudMlJobApproval = z.infer<typeof CloudMlJobApprovalSchema>;

/**
 * FC-46 (owner decision 2026-09-27): what a photo upscale was quoted at. The 64 MP output cap stays, so
 * a photo the requested factor would take over it gets a smaller one (a 12 MP photo asked for 4× gets
 * 2×); `input` is the declared pixel size the sealed estimate binds.
 */
export const CloudMlJobUpscaleSchema = z.object({
  requestedScale: z.union([z.literal(2), z.literal(4)]),
  appliedScale: z.union([z.literal(2), z.literal(4)]),
  lowered: z.boolean(),
  input: z.object({ width: z.int().min(1), height: z.int().min(1) }),
});
export type CloudMlJobUpscale = z.infer<typeof CloudMlJobUpscaleSchema>;

/** The immutable binding of a `cloud_ml_job` operation. Written once at confirmation. */
export const CloudMlJobSnapshotSchema = z.object({
  version: z.literal(1),
  purpose: z.enum(CLOUD_ML_JOB_PURPOSES),
  stage: z.enum(CLOUD_ML_JOB_STAGES),
  restorationId: z.string().min(1),
  assetId: z.string().min(1),
  ownerId: z.string().min(1),
  sourceChecksumHex: z.string().min(1),
  sourceType: z.enum(['image', 'video']),
  destinationId: z.string().min(1),
  workload: z.enum(['restoration', 'upscale', 'interpolation']),
  appWorkload: z.enum(MlWorkload),
  model: z.object({ sku: z.string().min(1), rev: z.string().min(1), label: z.string().min(1) }),
  request: z.record(z.string(), z.unknown()),
  inputs: z.array(CloudMlJobInputSchema).min(1).max(1000),
  /** Where this job's work files live; removed once the job is finished. */
  workDir: z.string().min(1),
  /** The preview's before clip or crop, kept on this server for the comparison; never uploaded. */
  beforePath: z.string().nullable(),
  /** The size the result may have, after the 4K cap. */
  output: z.object({ width: z.int().min(1), height: z.int().min(1) }),
  durationSeconds: z.number().nullable(),
  approved: CloudMlJobApprovalSchema,
  /** The estimate this job was confirmed from, so a repeated confirmation finds the job it created. */
  estimateId: z.string().min(1).optional(),
  /** FC-46: a photo upscale's quoted factor (absent on older jobs and on video work). */
  upscale: CloudMlJobUpscaleSchema.optional(),
  consent: z.object({
    version: z.string().min(1),
    textSha256: z.string().nullable(),
    acknowledgeDataLeaves: z.literal(true),
    acceptedBy: z.string().min(1),
    acceptedAt: z.string().min(1),
  }),
});
export type CloudMlJobSnapshot = z.infer<typeof CloudMlJobSnapshotSchema>;

export const parseCloudMlJobSnapshot = (value: unknown): CloudMlJobSnapshot => CloudMlJobSnapshotSchema.parse(value);

const CloudMlJobCostSchema = z.object({
  outcome: z.enum(['charged', 'not_charged', 'refunded']),
  totalUsd: usd,
  heldUsd: usd,
  releasedUsd: usd,
  note: z.string(),
  settledAt: z.string(),
  lines: z.array(
    z.object({
      kind: z.string(),
      label: z.string(),
      sign: z.enum(['charge', 'credit']),
      quantity: z.number().nullable(),
      unit: z.string().nullable(),
      amountUsd: usd,
    }),
  ),
});
export type CloudMlJobCost = z.infer<typeof CloudMlJobCostSchema>;

const CloudMlJobRecordSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(CLOUD_JOB_STATUSES),
  holdUsd: usd,
  ceilingUsd: usd,
  meteredUsd: usd,
  meteredSeconds: z.number().min(0),
  workers: z.int().min(0),
  startFees: z.int().min(0),
  progress: z.object({ done: z.int(), total: z.int(), unit: z.string(), etaSeconds: z.int().nullable() }).nullable(),
  etag: z.string().nullable(),
  admittedAt: z.string(),
  startedAt: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
});
export type CloudMlJobRecord = z.infer<typeof CloudMlJobRecordSchema>;

const CloudMlJobSubmissionSchema = z.object({
  /** Null until the first attempt: the key is the operation id, which exists only once the job does. */
  idempotencyKey: z.string().min(8).nullable(),
  estimate: z.string().min(1),
  expiresAt: z.string(),
  modelRev: z.string(),
  computeSku: z.string(),
  p50Usd: usd,
  p90Usd: usd,
  holdUsd: usd,
  startupUsd: usd,
  /** Written before `POST /v2/jobs`, so a replay after a crash sends the same key and body. */
  attemptedAt: z.string().nullable(),
});
export type CloudMlJobSubmission = z.infer<typeof CloudMlJobSubmissionSchema>;

/**
 * An estimate an owner was shown (FL-162), kept on this server under `estimateId` so confirming the
 * job names only that id: the model, inputs, prices and consent version are read back from here,
 * never from the browser. `operationId` is set once confirmed, so a repeated confirmation answers with
 * the same job. Its prepared inputs live in `workDir` until the job ends or the estimate is dropped.
 */
export type CloudMlJobEstimateRecord = {
  id: string;
  ownerId: string;
  createdBy: string;
  createdAt: string;
  /** The sealed estimate's own expiry: after it, the job is estimated again, never sent with this one. */
  expiresAt: string;
  purpose: CloudMlJobPurpose;
  stage: CloudMlJobStage;
  assetId: string;
  restorationId: string | null;
  sourceChecksumHex: string;
  sourceType: 'image' | 'video';
  destinationId: string;
  workload: CloudMlJobWorkload;
  appWorkload: MlWorkload;
  settings: { mode: string; upscale: number; keepGrain: boolean; factor: number | null; region: unknown };
  model: { sku: string; rev: string; label: string };
  computeSku: string;
  request: Record<string, unknown>;
  inputs: CloudMlJobInput[];
  workDir: string;
  beforePath: string | null;
  output: { width: number; height: number };
  durationSeconds: number | null;
  /** The sealed estimate, sent once with the job and never shown. */
  sealed: string;
  approved: CloudMlJobApproval;
  consent: { version: string; textSha256: string | null };
  operationId: string | null;
  /** FC-46: a photo upscale's quoted factor; absent on video work. */
  upscale?: CloudMlJobUpscale;
};

/** What happened so far; the one mutable part of the job. */
export const CloudMlJobResultSchema = z.object({
  phase: z.enum(CloudMlJobPhase),
  estimates: z.int().min(0),
  submission: CloudMlJobSubmissionSchema.nullable(),
  job: CloudMlJobRecordSchema.nullable(),
  /** Per input: whether it is uploaded, and the multipart parts already sent. */
  uploads: z.record(
    z.string(),
    z.object({ done: z.boolean(), parts: z.array(z.object({ partNumber: z.int(), etag: z.string() })) }),
  ),
  /** The cloud was asked to cancel this job. */
  cancelSent: z.boolean(),
  /** The job's outputs were downloaded and their SHA-256 checked, by output id. */
  downloaded: z.array(z.string()),
  /** `DELETE /v2/jobs/{id}` was answered: the cloud purges what it holds for the job. */
  acknowledged: z.boolean(),
  /** What the job cost once settled (FC-43), recorded once; null until then. */
  cost: CloudMlJobCostSchema.nullable(),
  /** Reads of a settled job waiting for its cost. */
  costReads: z.int().min(0),
  /** Why the job waits or stopped, in the words it was given. */
  waiting: z.object({ code: z.string(), detail: z.string(), at: z.string() }).nullable(),
  /** Transient failures in a row since the cloud job exists; reset by every step that goes through. */
  transientFailures: z.int().min(0).default(0),
  /** Acknowledgements of a finished job that failed, so the cleanup pass tries the least-tried first. */
  ackAttempts: z.int().min(0).default(0),
  /** A job cancelled before anything was sent had its version and files put right by the cleanup pass. */
  reconciled: z.boolean().default(false),
  /**
   * FC-46: the factor the cloud's upscale result document says this photo was really upscaled by
   * (`UpscaleItem.scale`), recorded once read; the version is written and checked at it.
   */
  upscaleScale: z
    .union([z.literal(2), z.literal(4)])
    .nullable()
    .default(null),
});
export type CloudMlJobResult = z.infer<typeof CloudMlJobResultSchema>;

export const emptyCloudMlJobResult = (): CloudMlJobResult => ({
  phase: CloudMlJobPhase.Queued,
  estimates: 1,
  submission: null,
  job: null,
  uploads: {},
  cancelSent: false,
  downloaded: [],
  acknowledged: false,
  cost: null,
  costReads: 0,
  waiting: null,
  transientFailures: 0,
  ackAttempts: 0,
  reconciled: false,
  upscaleScale: null,
});

/** The result as stored, or a fresh one when there is none or it cannot be read. */
export const parseCloudMlJobResult = (value: unknown): CloudMlJobResult => {
  const parsed = CloudMlJobResultSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyCloudMlJobResult();
};

/**
 * The idempotency key of a job's submission (FL-162: the operation id). A job the queue held past its
 * sealed estimate is estimated again and sent under a new key, `<operation id>-<n>`, so a replay of
 * the first key can never be answered with a different body.
 */
export const cloudMlJobIdempotencyKey = (operationId: string, estimates: number): string =>
  estimates <= 1 ? operationId : `${operationId}-${estimates}`;

/** The client reference a job carries in the usage report: `ml-<operation id>`. */
export const cloudMlJobClientRef = (operationId: string): string => `ml-${operationId}`;

/**
 * The workers a job was planned on, from the estimate: one start fee per worker (FC-39), so the
 * start-up cost divided by one start fee, never more than Frameleaf Cloud's five.
 */
export const plannedWorkers = (estimate: Pick<CloudEstimate, 'cost'>, startFeeUsd: number): number => {
  if (startFeeUsd <= 0) {
    return 1;
  }
  const workers = Math.round(estimate.cost.startup / startFeeUsd);
  return Math.min(CLOUD_ML_JOB_MAX_WORKERS, Math.max(1, workers));
};

/**
 * What one photo or one minute of video costs, as an estimate (never a fixed price): the p50 and p90
 * totals, start fees included, divided over the quantity.
 */
export const perUnitEstimate = (
  estimate: Pick<CloudEstimate, 'cost'>,
  quantity: { unit: 'photo' | 'minute'; value: number },
): { unit: 'photo' | 'minute'; p50Usd: number; p90Usd: number } => {
  const value = Math.max(quantity.unit === 'minute' ? 1 / 60 : 1, quantity.value);
  const round = (amount: number) => Math.round((amount / value) * 1_000_000) / 1_000_000;
  return { unit: quantity.unit, p50Usd: round(estimate.cost.p50), p90Usd: round(estimate.cost.p90) };
};

/** The stage Activity shows for a cloud job, from the operation's status and the cloud job's own. */
export const cloudMlJobActivityStage = (
  status: MediaOperationStatus,
  result: Pick<CloudMlJobResult, 'job'>,
): CloudMlJobActivityStage => {
  switch (status) {
    case MediaOperationStatus.Completed: {
      return 'done';
    }
    case MediaOperationStatus.Failed: {
      return 'failed';
    }
    case MediaOperationStatus.Cancelled: {
      return 'cancelled';
    }
    case MediaOperationStatus.Paused: {
      return 'paused';
    }
    default: {
      break;
    }
  }
  switch (result.job?.status) {
    case 'starting': {
      return 'starting';
    }
    case 'running':
    case 'completed':
    case 'cancelled_budget':
    case 'cancelled':
    case 'failed':
    case 'expired': {
      // an ended job is still being collected (downloaded, checked, acknowledged) here
      return 'running';
    }
    default: {
      return 'queued';
    }
  }
};

/**
 * What the job has cost so far: its settled total once known, else what the cloud metered (never
 * above the hold), else nothing yet (billing starts when a worker starts).
 */
export const cloudMlJobSoFarUsd = (result: Pick<CloudMlJobResult, 'job' | 'cost'>): number | null => {
  if (result.cost) {
    return result.cost.totalUsd;
  }
  if (!result.job || result.job.meteredUsd <= 0) {
    return null;
  }
  return Math.min(result.job.meteredUsd, result.job.holdUsd);
};

/**
 * Whether a job can pause (FL-162): any other kind as its kind allows, and a cloud job only before it
 * was started on Frameleaf Cloud. A started cloud job runs, and meters, there whether this server
 * watches it or not; it is cancelled to stop it.
 */
export const cloudMlJobCanPause = (operation: { kind: string; result: unknown }): boolean => {
  if (operation.kind !== MediaOperationKind.CloudMlJob) {
    return true;
  }
  // an upload in flight has an admitted cloud job holding the AI Wallet: it runs to its start
  return parseCloudMlJobResult(operation.result).phase === CloudMlJobPhase.Queued;
};

/** The first moment of `now`'s month, in UTC: a person's monthly limit counts from here. */
export const cloudMlJobMonthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * What one person's confirmed jobs count against their monthly limit (FL-162 owner decision): a
 * settled job its settled charge; a job still running (or ended but not settled) the amount the AI
 * Wallet holds for it, or, before it was sent, the most a reseal could hold (its confirmed hold plus
 * `CLOUD_ML_JOB_PRICE_TOLERANCE`); and a job that ended before anything was sent nothing.
 */
export const cloudMlJobSpentUsd = (
  rows: ReadonlyArray<{
    status: string;
    remoteJobId: string | null;
    result: unknown;
    holdUsd: number | null;
    settledUsd: number | null;
  }>,
): number => {
  const ended = new Set<string>([
    MediaOperationStatus.Completed,
    MediaOperationStatus.Failed,
    MediaOperationStatus.Cancelled,
  ]);
  let total = 0;
  for (const row of rows) {
    if (row.settledUsd !== null) {
      total += row.settledUsd;
      continue;
    }
    if (ended.has(row.status) && !row.remoteJobId) {
      continue;
    }
    const result = parseCloudMlJobResult(row.result);
    if (result.cost) {
      total += result.cost.totalUsd;
      continue;
    }
    const submitted = result.submission?.attemptedAt ? result.submission.holdUsd : null;
    const held = result.job ? Math.max(result.job.holdUsd, submitted ?? 0) : submitted;
    total += held ?? (row.holdUsd ?? 0) * CLOUD_ML_JOB_PRICE_TOLERANCE;
  }
  return Math.round(total * 10_000) / 10_000;
};

/**
 * How long a job waits after its `failures`-th transient failure in a row: doubling from
 * `CLOUD_ML_JOB_POLL_MS` up to `CLOUD_ML_JOB_MAX_POLL_MS`, and never sooner than the cloud's
 * `Retry-After`.
 */
export const cloudMlJobBackoffMs = (failures: number, retryAfterSeconds: number | null = null): number => {
  const doubled = Math.min(CLOUD_ML_JOB_MAX_POLL_MS, CLOUD_ML_JOB_POLL_MS * 2 ** Math.max(0, failures - 1));
  // a Retry-After is honoured as asked, up to a quarter of an hour
  const asked = retryAfterSeconds === null ? 0 : Math.min(15 * 60, retryAfterSeconds) * 1000;
  return Math.max(doubled, asked);
};

/** A cloud job as Activity and `GET /cloud/ml/jobs/{id}` show it (FL-162); the DTO is `CloudMlJobActivityDto`. */
export type CloudMlJobActivity = {
  purpose: CloudMlJobPurpose;
  stage: CloudMlJobStage;
  activityStage: CloudMlJobActivityStage;
  model: string;
  modelSku: string;
  plannedWorkers: number;
  workers: number;
  cloudStatus: string | null;
  progressUnit: string | null;
  cost: {
    estimatedP50Usd: number;
    estimatedP90Usd: number;
    holdUsd: number;
    soFarUsd: number | null;
    settledUsd: number | null;
    outcome: CloudMlJobCost['outcome'] | null;
    note: string | null;
  };
};

/**
 * The Activity view of a `cloud_ml_job` operation, or null for any other kind (or a snapshot that
 * cannot be read). Only the stage, model name and money are shown: never a file name, path or digest.
 */
export const cloudMlJobActivity = (operation: {
  kind: string;
  status: string;
  snapshot: unknown;
  result: unknown;
}): CloudMlJobActivity | null => {
  if (operation.kind !== MediaOperationKind.CloudMlJob) {
    return null;
  }
  const snapshot = CloudMlJobSnapshotSchema.safeParse(operation.snapshot);
  if (!snapshot.success) {
    return null;
  }
  const { purpose, stage, model, approved } = snapshot.data;
  const result = parseCloudMlJobResult(operation.result);
  return {
    purpose,
    stage,
    activityStage: cloudMlJobActivityStage(operation.status as MediaOperationStatus, result),
    model: model.label,
    modelSku: model.sku,
    plannedWorkers: approved.plannedWorkers,
    workers: result.job?.workers ?? 0,
    cloudStatus: result.job?.status ?? null,
    progressUnit: result.job?.progress?.unit ?? null,
    cost: {
      estimatedP50Usd: approved.p50Usd,
      estimatedP90Usd: approved.p90Usd,
      holdUsd: result.job?.holdUsd ?? approved.holdUsd,
      soFarUsd: cloudMlJobSoFarUsd(result),
      settledUsd: result.cost?.totalUsd ?? null,
      outcome: result.cost?.outcome ?? null,
      note: result.cost?.note ?? null,
    },
  };
};

/** A job view's cost as the result records it. */
export const cloudMlJobCostOf = (view: Pick<CloudJobView, 'cost'>): CloudMlJobCost | null =>
  view.cost
    ? {
        outcome: view.cost.outcome,
        totalUsd: view.cost.totalUsd,
        heldUsd: view.cost.heldUsd,
        releasedUsd: view.cost.releasedUsd,
        note: view.cost.note,
        settledAt: view.cost.settledAt,
        lines: view.cost.lines.map((line) => ({
          kind: line.kind,
          label: line.label,
          sign: line.sign,
          quantity: line.quantity,
          unit: line.unit,
          amountUsd: line.amountUsd,
        })),
      }
    : null;

/** A job view as the result records it; the ETag is the one the read answered with. */
export const cloudMlJobRecordOf = (
  view: CloudJobView,
  previous: CloudMlJobRecord | null,
  etag: string | null,
): CloudMlJobRecord => ({
  jobId: view.jobId,
  status: view.status,
  holdUsd: view.charges.holdUsd,
  ceilingUsd: view.charges.ceilingUsd,
  meteredUsd: view.charges.meteredUsd,
  meteredSeconds: view.run.meteredSeconds,
  workers: view.run.workers,
  startFees: view.run.startFees,
  progress: view.progress,
  etag,
  admittedAt: previous?.admittedAt ?? view.createdAt,
  startedAt: view.run.startedAt,
  error: view.error ? { code: view.error.code, message: view.error.message, retryable: view.error.retryable } : null,
});

/** Whether a cloud job status is one the worker only waits on. */
export const isWaitingCloudJob = (status: CloudJobView['status']): boolean => !isFinalCloudJobStatus(status);

/**
 * The outputs of a job in the order they are joined: a chunked video has one output per input and
 * shard (`<inputId>-s<shard>`, FC-42), joined by shard; anything else keeps the order it was given.
 */
export const orderedOutputs = (outputs: readonly CloudOutputDownload[]): CloudOutputDownload[] => {
  const shard = (output: CloudOutputDownload) => {
    const match = /-s(\d+)$/.exec(output.outputId);
    return match ? Number(match[1]) : -1;
  };
  return outputs.toSorted((a, b) => shard(a) - shard(b));
};

/**
 * Whether a job's outputs make one whole result: a single output, or shards numbered 0 to n − 1 with
 * none missing. A job stopped at its hold part-way through a video delivers only the shards it
 * finished, so one that stopped must also have counted all its work done (and, for segments, as many
 * shards as it counted); a completed job's last progress report may lag, so it is not asked for.
 */
export const outputsComplete = (
  outputs: readonly CloudOutputDownload[],
  progress: { done: number; total: number; unit: string } | null,
  budgetStopped = false,
): boolean => {
  const shards = outputs.map((output) => /-s(\d+)$/.exec(output.outputId));
  if (shards.every((match) => match === null)) {
    return outputs.length === 1;
  }
  if (shards.includes(null)) {
    return false;
  }
  const numbers = shards.map((match) => Number(match![1])).toSorted((a, b) => a - b);
  if (numbers.some((value, index) => value !== index)) {
    return false;
  }
  if (!budgetStopped) {
    return true;
  }
  if (!progress || progress.total <= 0) {
    return false;
  }
  return progress.done >= progress.total && (progress.unit !== 'segments' || numbers.length === progress.total);
};

/**
 * The cloud workload a job is sent as: video restoration as `restoration`, a photo's restoration as
 * `upscale` (Frameleaf Cloud restores photos by upscaling them), Smooth motion as `interpolation`.
 */
export const cloudMlJobWorkload = (purpose: CloudMlJobPurpose, sourceType: 'image' | 'video'): CloudMlJobWorkload => {
  if (purpose === 'smooth-motion') {
    return 'interpolation';
  }
  return sourceType === 'video' ? 'restoration' : 'upscale';
};

/** The input types each workload takes (FC-42 `WORKLOAD_INPUT_TYPES`): previews, never originals or RAW. */
export const CLOUD_ML_JOB_INPUT_TYPES: Readonly<Record<CloudMlJobWorkload, readonly string[]>> = {
  restoration: ['video/mp4', 'video/webm', 'video/quicktime'],
  interpolation: ['video/mp4', 'video/webm', 'video/quicktime'],
  upscale: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif'],
};
