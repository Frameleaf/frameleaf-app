import { MediaOperationCheckpointState, MediaOperationStatus } from 'src/enum.js';

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

/** Statuses where the job is still the server's problem. */
export const ACTIVE_MEDIA_OPERATION_STATUSES: readonly MediaOperationStatus[] = [
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
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
  ],
  [MediaOperationStatus.Preparing]: [
    MediaOperationStatus.Rendering,
    // Recovery: a lost claim returns the job to the queue rather than failing it outright.
    MediaOperationStatus.Queued,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Failed,
  ],
  [MediaOperationStatus.Rendering]: [
    MediaOperationStatus.Validating,
    MediaOperationStatus.Queued,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Failed,
  ],
  [MediaOperationStatus.Validating]: [
    MediaOperationStatus.Completed,
    MediaOperationStatus.Queued,
    MediaOperationStatus.Cancelling,
    MediaOperationStatus.Failed,
  ],
  [MediaOperationStatus.Cancelling]: [MediaOperationStatus.Cancelled, MediaOperationStatus.Failed],
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
  while (boundary < ordered.length && canReuseChunk(byFrame.get(ordered[boundary].sequence), ordered[boundary]).reusable) {
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
