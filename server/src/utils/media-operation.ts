import { MediaOperationCheckpointState, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';

/**
 * The durable rules for media operations (FL-43, FL-104), kept free of the database so they can
 * be read and tested on their own.
 *
 * Two things live here:
 *
 * 1. The state machine. Every transition a job may make, and nothing else.
 * 2. Chunk reuse. Whether a stored checkpoint really describes the work we are about to do, and
 *    where a resumed render is allowed to start.
 */

/**
 * Statuses where the job is still the server's problem. A paused job is one of them: it has not
 * finished, it can still be cancelled, and it cannot be retried or cleared until it has.
 */
export const ACTIVE_MEDIA_OPERATION_STATUSES: readonly MediaOperationStatus[] = [
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
];

/** Statuses where a worker is expected to be holding a claim. */
export const CLAIMED_MEDIA_OPERATION_STATUSES: readonly MediaOperationStatus[] = [
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
];

/** Statuses that never change again. */
export const TERMINAL_MEDIA_OPERATION_STATUSES: readonly MediaOperationStatus[] = [
  MediaOperationStatus.Completed,
  MediaOperationStatus.Cancelled,
  MediaOperationStatus.Failed,
];

/**
 * The only legal transitions.
 *
 * `cancelling` is reachable from every active state because a person may cancel at any moment,
 * and it leads only to `cancelled` — after the remote acknowledges — or to `failed` when the
 * worker dies before it can answer. A job that was already `completed` is never un-completed:
 * a stale worker reporting a late failure has nowhere to go.
 */
export const MEDIA_OPERATION_TRANSITIONS: Readonly<Record<MediaOperationStatus, readonly MediaOperationStatus[]>> = {
  [MediaOperationStatus.Queued]: [
    MediaOperationStatus.Preparing,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Cancelled,
    MediaOperationStatus.Failed,
    // A queued job has no worker to wait for, so a pause holds it at once.
    MediaOperationStatus.Paused,
  ],
  [MediaOperationStatus.Preparing]: [
    MediaOperationStatus.Rendering,
    // Recovery: a lost claim returns the job to the queue rather than failing it outright.
    MediaOperationStatus.Queued,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Failed,
    // A requested pause lands at the worker's next checkpoint, when it hands the claim back.
    MediaOperationStatus.Paused,
  ],
  [MediaOperationStatus.Rendering]: [
    MediaOperationStatus.Validating,
    MediaOperationStatus.Queued,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Failed,
    MediaOperationStatus.Paused,
  ],
  [MediaOperationStatus.Validating]: [
    MediaOperationStatus.Completed,
    MediaOperationStatus.Queued,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Failed,
    // Only through recovery: a worker that vanished while validating with a pause requested.
    MediaOperationStatus.Paused,
  ],
  [MediaOperationStatus.Cancelling]: [MediaOperationStatus.Cancelled, MediaOperationStatus.Failed],
  // Resume puts it back in the queue; a cancel ends it outright, since no worker holds it.
  [MediaOperationStatus.Paused]: [MediaOperationStatus.Queued, MediaOperationStatus.Cancelled],
  [MediaOperationStatus.Completed]: [],
  [MediaOperationStatus.Cancelled]: [],
  [MediaOperationStatus.Failed]: [],
};

export const isActiveMediaOperation = (status: MediaOperationStatus) =>
  ACTIVE_MEDIA_OPERATION_STATUSES.includes(status);

export const isTerminalMediaOperation = (status: MediaOperationStatus) =>
  TERMINAL_MEDIA_OPERATION_STATUSES.includes(status);

export const canTransitionMediaOperation = (from: MediaOperationStatus, to: MediaOperationStatus) =>
  MEDIA_OPERATION_TRANSITIONS[from].includes(to);

/**
 * Automatic retries every job gets before a failure is reported (FL-104, owner decision
 * September 22, 2026). Exactly one: a transient failure — a restart, a dropped connection, a
 * worker that ran out of lease — is retried without anybody asking, and a failure that happens
 * again is reported so a person can decide. Manual retry stays available after that.
 */
export const MEDIA_OPERATION_AUTO_RETRIES = 1;

/** How long a job that failed waits before its automatic retry is claimed. */
export const MEDIA_OPERATION_AUTO_RETRY_DELAY_MS = 30_000;

/**
 * The kinds that can stop partway and carry on later (FL-104, owner request September 23, 2026).
 *
 * Each one records where it has got to in a way the next claim resumes from: a bulk job its cursor
 * and per-item result, a Studio export and a restoration their checkpointed chunks, a Google Photos
 * import (FL-65) every staged file and imported item. The rest are
 * one-shot — a preview, a still edit — or rebuild their output from the start (a portable project
 * bundle), so pausing one would only throw its work away; they are offered no pause at all.
 */
export const PAUSABLE_MEDIA_OPERATION_KINDS: readonly MediaOperationKind[] = [
  MediaOperationKind.Bulk,
  MediaOperationKind.StudioExport,
  MediaOperationKind.Restoration,
  // FL-59: an enrichment plan records every asset as it finishes and resumes from its cursor.
  MediaOperationKind.EnrichmentPlan,
  // A Library Care scan or search records its asset or directory cursor after every batch (FL-69).
  MediaOperationKind.MediaHealth,
  // An iCloud sync resumes from its inventory checkpoints and leased resources (FL-68).
  MediaOperationKind.ICloudSync,
  // A Google Photos import records every staged file and imported item as it goes (FL-65).
  MediaOperationKind.TakeoutImport,
  // FL-73: a reviewed deduplication plan records every copy as it finishes and resumes from its cursor.
  MediaOperationKind.PhysicalDeduplication,
  // FL-78: an external library scan records its phase and item cursor after every batch.
  MediaOperationKind.LibraryScan,
  // FL-74: every preservation job records each item as it finishes and carries on from the rest.
  MediaOperationKind.PreservationExport,
  MediaOperationKind.PreservationVerify,
  MediaOperationKind.PreservationReview,
  MediaOperationKind.PreservationRestore,
  // FL-160: a cloud backup run records its phase and asset cursor every 25 assets and finishes the same
  // manifest when it resumes.
  MediaOperationKind.CloudBackup,
];

export const isPausableMediaOperationKind = (kind: MediaOperationKind) => PAUSABLE_MEDIA_OPERATION_KINDS.includes(kind);

/**
 * The kinds that resume where they stopped when a claim is lost (FL-43). The same set that can
 * pause, for the same reason: each records where it has got to, so a new claim carries on rather
 * than starting again. Every other kind starts from nothing on a new claim, so for them a lost
 * claim is simply a failure and gets the one automatic retry every failure gets.
 */
export const RESUMABLE_MEDIA_OPERATION_KINDS: readonly MediaOperationKind[] = PAUSABLE_MEDIA_OPERATION_KINDS;

/**
 * Lost claims a resumable job may resume from before a lapse counts as its failure (owner decision,
 * September 22, 2026: "resumable jobs may resume a lost claim up to twice first"). After that the
 * lapse is a failure like any other: one automatic retry, then it is reported. Claims a runner
 * hands back on purpose — a pause, a shutdown, a deliberate requeue — give their attempt back and
 * are not counted.
 */
export const MEDIA_OPERATION_LOST_CLAIM_RESUMES = 2;

/**
 * Whether a job whose claim lapsed on attempt `attempt` goes back to the queue to resume, rather
 * than being treated as failed. `maxAttempts` may only lower the allowance, never raise it.
 */
export const canResumeLostClaim = (operation: { kind: MediaOperationKind; attempt: number; maxAttempts: number }) =>
  RESUMABLE_MEDIA_OPERATION_KINDS.includes(operation.kind) &&
  operation.attempt < Math.min(operation.maxAttempts, 1 + MEDIA_OPERATION_LOST_CLAIM_RESUMES);

/**
 * The kinds a remote render worker may ever claim (FL-73): the renders. Bulk jobs (duplicate
 * decisions included), project bundles, enrichment plans, Library Care, iCloud and Google Photos
 * imports and physical deduplication run on this server's own workers, and their snapshots can name
 * other accounts' files; a worker whose saved scope lists one of them, whatever its destination, is
 * still never handed it.
 */
export const RENDER_WORKER_MEDIA_OPERATION_KINDS: readonly MediaOperationKind[] = [
  MediaOperationKind.StudioExport,
  MediaOperationKind.StudioPreview,
  MediaOperationKind.Restoration,
  MediaOperationKind.RestorationPreview,
  MediaOperationKind.QuickEdit,
];

export const isRenderWorkerMediaOperationKind = (kind: MediaOperationKind) =>
  RENDER_WORKER_MEDIA_OPERATION_KINDS.includes(kind);

/**
 * Statuses a pause may be asked for from. `validating` is left out: the output is already written
 * and about to be adopted, and stopping there would only discard it.
 */
export const PAUSABLE_MEDIA_OPERATION_STATUSES: readonly MediaOperationStatus[] = [
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
];

export const canPauseMediaOperation = (operation: {
  kind: MediaOperationKind;
  status: MediaOperationStatus;
  cancelRequestedAt?: unknown;
}) =>
  isPausableMediaOperationKind(operation.kind) &&
  PAUSABLE_MEDIA_OPERATION_STATUSES.includes(operation.status) &&
  !operation.cancelRequestedAt;

/** Statuses a job can be in while a pause it was asked for has not been reached yet. */
const PAUSE_PENDING_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
]);

/**
 * A paused job can be resumed, and so can one whose pause was asked for but not yet reached: the
 * worker is still on it, so resuming simply withdraws the request.
 */
export const canResumeMediaOperation = (operation: { status: MediaOperationStatus; pauseRequestedAt?: unknown }) =>
  operation.status === MediaOperationStatus.Paused ||
  (!!operation.pauseRequestedAt && PAUSE_PENDING_STATUSES.has(operation.status));

/** Only a failed or cancelled job may be retried; retry copies the snapshot into a new row. */
export const canRetryMediaOperation = (status: MediaOperationStatus) =>
  status === MediaOperationStatus.Failed || status === MediaOperationStatus.Cancelled;

/** A finished job may be cleared from Activity. A running one may not — cancel it first. */
export const canDismissMediaOperation = (status: MediaOperationStatus) => isTerminalMediaOperation(status);

/** Everything that decides whether a chunk of rendering is the same work as before. */
export type ChunkIdentity = {
  /** Digest over the source media, trims and resource checksums feeding the chunk. */
  inputDigest: string;
  /** Digest over the complete effect and audio history preceding the chunk, including preroll. */
  historyDigest: string;
  /** Digest over engine, codec, colour policy and output profile. */
  configDigest: string;
  /** Model seed, when the workload has one. */
  seed: string | null;
  /** Rational timebase the ticks below are expressed in, e.g. `30000/1001`. */
  timebase: string;
  startTicks: bigint;
  endTicks: bigint;
};

export type StoredChunk = ChunkIdentity & {
  sequence: number;
  state: MediaOperationCheckpointState;
  chunkKey: string;
  /** True when a filter inside the chunk carries serialized state across its boundary. */
  requiresSequentialContext: boolean;
  outputPath: string | null;
};

export type ChunkPlan = ChunkIdentity & {
  sequence: number;
  chunkKey: string;
  requiresSequentialContext: boolean;
};

export type ChunkReuseRejection =
  | 'not-found'
  | 'not-complete'
  | 'no-output'
  | 'chunk-key-mismatch'
  | 'input-mismatch'
  | 'history-mismatch'
  | 'config-mismatch'
  | 'seed-mismatch'
  | 'timebase-mismatch'
  | 'range-mismatch';

export type ChunkReuseDecision = { reusable: true } | { reusable: false; reason: ChunkReuseRejection };

/**
 * Whether a stored chunk may be reused for a planned one.
 *
 * Every field is compared, in the order that fails fastest and reads most clearly. The chunk
 * number is deliberately not part of the decision: two renders of the same project can produce
 * chunk 7 from entirely different inputs, and reusing one because the number matched is exactly
 * the corruption this checkpoint model exists to prevent.
 */
export const canReuseChunk = (stored: StoredChunk | undefined, planned: ChunkPlan): ChunkReuseDecision => {
  if (!stored) {
    return { reusable: false, reason: 'not-found' };
  }

  if (stored.state !== MediaOperationCheckpointState.Complete) {
    return { reusable: false, reason: 'not-complete' };
  }

  if (!stored.outputPath) {
    // A chunk marked complete with nothing on disk is not evidence of anything.
    return { reusable: false, reason: 'no-output' };
  }

  if (stored.chunkKey !== planned.chunkKey) {
    return { reusable: false, reason: 'chunk-key-mismatch' };
  }

  if (stored.inputDigest !== planned.inputDigest) {
    return { reusable: false, reason: 'input-mismatch' };
  }

  if (stored.historyDigest !== planned.historyDigest) {
    return { reusable: false, reason: 'history-mismatch' };
  }

  if (stored.configDigest !== planned.configDigest) {
    return { reusable: false, reason: 'config-mismatch' };
  }

  if (stored.seed !== planned.seed) {
    return { reusable: false, reason: 'seed-mismatch' };
  }

  if (stored.timebase !== planned.timebase) {
    return { reusable: false, reason: 'timebase-mismatch' };
  }

  if (stored.startTicks !== planned.startTicks || stored.endTicks !== planned.endTicks) {
    return { reusable: false, reason: 'range-mismatch' };
  }

  return { reusable: true };
};

export type ResumePlan = {
  /** Chunks, in order, that may be kept from the previous attempt. */
  reusable: ChunkPlan[];
  /** The first chunk the resumed render must produce. */
  resumeFrom: number;
  /**
   * Chunks that were reusable on their own but must be rendered again anyway, because the render
   * has to restart at a boundary that can legitimately begin: the region after a chunk carrying
   * serialized filter or audio state cannot be entered halfway.
   */
  rerendered: ChunkPlan[];
};

/**
 * Work out where a resumed render is allowed to start.
 *
 * Reuse runs forward from the beginning and stops at the first chunk that fails any digest
 * comparison: chunks after a break inherit a history that no longer holds, so nothing past the
 * break is reusable even when its own digests happen to match.
 *
 * The boundary is then walked back over any run of chunks that require sequential context. Those
 * chunks cannot be re-entered from a cold decoder and filter graph, so the safe start is the
 * first chunk of that run, and the chunks given up are reported rather than silently dropped.
 * Correctness wins over reuse; this function never chooses the cheaper answer.
 */
export const planChunkResume = (stored: readonly StoredChunk[], planned: readonly ChunkPlan[]): ResumePlan => {
  const byFrame = new Map(stored.map((chunk) => [chunk.sequence, chunk]));
  const ordered = [...planned].sort((a, b) => a.sequence - b.sequence);

  let boundary = 0;
  while (
    boundary < ordered.length &&
    canReuseChunk(byFrame.get(ordered[boundary].sequence), ordered[boundary]).reusable
  ) {
    boundary++;
  }

  // Walk back over a run of chunks a render may not start in the middle of.
  let safe = boundary;
  while (safe > 0 && ordered[safe - 1].requiresSequentialContext) {
    safe--;
  }

  return {
    reusable: ordered.slice(0, safe),
    resumeFrom: safe < ordered.length ? ordered[safe].sequence : ordered.length,
    rerendered: ordered.slice(safe, boundary),
  };
};

/**
 * Progress as a percentage, from real counted work.
 *
 * Returns null rather than a guess when the total is not known yet; Activity shows an
 * indeterminate bar in that case instead of inventing a number.
 */
export const mediaOperationProgress = (processedUnits: number, totalUnits: number | null): number | null => {
  if (!totalUnits || totalUnits <= 0) {
    return null;
  }

  const percent = (processedUnits / totalUnits) * 100;
  return Math.min(100, Math.max(0, Math.round(percent * 100) / 100));
};
