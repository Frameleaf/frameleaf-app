import { MediaOperationCheckpointState, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import {
  type ChunkPlan,
  MEDIA_OPERATION_AUTO_RETRIES,
  MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
  type StoredChunk,
  canDismissMediaOperation,
  canPauseMediaOperation,
  canResumeLostClaim,
  canResumeMediaOperation,
  canRetryMediaOperation,
  canReuseChunk,
  canTransitionMediaOperation,
  isActiveMediaOperation,
  isPausableMediaOperationKind,
  isRenderWorkerMediaOperationKind,
  mediaOperationProgress,
  planChunkResume,
} from 'src/utils/media-operation.js';

const plan = (sequence: number, overrides: Partial<ChunkPlan> = {}): ChunkPlan => ({
  sequence,
  chunkKey: `chunk-${sequence}`,
  inputDigest: `input-${sequence}`,
  historyDigest: `history-${sequence}`,
  configDigest: 'config',
  seed: 'seed',
  timebase: '30000/1001',
  startTicks: BigInt(sequence) * 1000n,
  endTicks: (BigInt(sequence) + 1n) * 1000n,
  requiresSequentialContext: false,
  ...overrides,
});

const stored = (sequence: number, overrides: Partial<StoredChunk> = {}): StoredChunk => ({
  ...plan(sequence),
  state: MediaOperationCheckpointState.Complete,
  outputPath: `/chunks/${sequence}.mkv`,
  ...overrides,
});

describe('media operation state machine', () => {
  it('allows the ordinary render path', () => {
    expect(canTransitionMediaOperation(MediaOperationStatus.Queued, MediaOperationStatus.Preparing)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Preparing, MediaOperationStatus.Rendering)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Rendering, MediaOperationStatus.Validating)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Validating, MediaOperationStatus.Completed)).toBe(true);
  });

  it('never reopens a job that has already finished', () => {
    for (const to of Object.values(MediaOperationStatus)) {
      expect(canTransitionMediaOperation(MediaOperationStatus.Completed, to)).toBe(false);
      expect(canTransitionMediaOperation(MediaOperationStatus.Cancelled, to)).toBe(false);
      expect(canTransitionMediaOperation(MediaOperationStatus.Failed, to)).toBe(false);
    }
  });

  it('only reaches cancelled through cancelling', () => {
    expect(canTransitionMediaOperation(MediaOperationStatus.Rendering, MediaOperationStatus.Cancelled)).toBe(false);
    expect(canTransitionMediaOperation(MediaOperationStatus.Rendering, MediaOperationStatus.Cancelling)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Cancelling, MediaOperationStatus.Cancelled)).toBe(true);
  });

  it('lets a lost claim requeue rather than fail outright', () => {
    expect(canTransitionMediaOperation(MediaOperationStatus.Rendering, MediaOperationStatus.Queued)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Validating, MediaOperationStatus.Queued)).toBe(true);
  });

  it('retries only failed and cancelled jobs', () => {
    expect(canRetryMediaOperation(MediaOperationStatus.Failed)).toBe(true);
    expect(canRetryMediaOperation(MediaOperationStatus.Cancelled)).toBe(true);
    expect(canRetryMediaOperation(MediaOperationStatus.Completed)).toBe(false);
    expect(canRetryMediaOperation(MediaOperationStatus.Rendering)).toBe(false);
  });

  it('clears only finished jobs from the list', () => {
    expect(canDismissMediaOperation(MediaOperationStatus.Completed)).toBe(true);
    expect(canDismissMediaOperation(MediaOperationStatus.Queued)).toBe(false);
    expect(canDismissMediaOperation(MediaOperationStatus.Cancelling)).toBe(false);
  });
});

describe('render worker kinds (FL-73)', () => {
  it('hands a remote render worker only renders, never a job that runs on the server', () => {
    for (const kind of [
      MediaOperationKind.StudioExport,
      MediaOperationKind.StudioPreview,
      MediaOperationKind.Restoration,
      MediaOperationKind.RestorationPreview,
      MediaOperationKind.QuickEdit,
    ]) {
      expect(isRenderWorkerMediaOperationKind(kind)).toBe(true);
    }
    for (const kind of [
      MediaOperationKind.Bulk,
      MediaOperationKind.StudioBundleExport,
      MediaOperationKind.StudioBundleImport,
      MediaOperationKind.EnrichmentPlan,
      MediaOperationKind.MediaHealth,
      MediaOperationKind.ICloudSync,
      MediaOperationKind.TakeoutImport,
      MediaOperationKind.PhysicalDeduplication,
    ]) {
      expect(isRenderWorkerMediaOperationKind(kind)).toBe(false);
    }
  });
});

describe('pause and resume (FL-104)', () => {
  it('pauses only the kinds that can carry on from where they stopped', () => {
    expect(isPausableMediaOperationKind(MediaOperationKind.Bulk)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.StudioExport)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.Restoration)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.EnrichmentPlan)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.MediaHealth)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.ICloudSync)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.PhysicalDeduplication)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.PreservationExport)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.PreservationVerify)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.PreservationReview)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.PreservationRestore)).toBe(true);
    expect(isPausableMediaOperationKind(MediaOperationKind.StudioPreview)).toBe(false);
    expect(isPausableMediaOperationKind(MediaOperationKind.RestorationPreview)).toBe(false);
    expect(isPausableMediaOperationKind(MediaOperationKind.QuickEdit)).toBe(false);
    expect(isPausableMediaOperationKind(MediaOperationKind.StudioBundleExport)).toBe(false);
    expect(isPausableMediaOperationKind(MediaOperationKind.StudioBundleImport)).toBe(false);
    expect(isPausableMediaOperationKind(MediaOperationKind.TakeoutImport)).toBe(true);
  });

  it('pauses a queued or running job, but not one validating, stopping or finished', () => {
    const bulk = (status: MediaOperationStatus, cancelRequestedAt: Date | null = null) =>
      canPauseMediaOperation({ kind: MediaOperationKind.Bulk, status, cancelRequestedAt });

    expect(bulk(MediaOperationStatus.Queued)).toBe(true);
    expect(bulk(MediaOperationStatus.Preparing)).toBe(true);
    expect(bulk(MediaOperationStatus.Rendering)).toBe(true);
    expect(bulk(MediaOperationStatus.Validating)).toBe(false);
    expect(bulk(MediaOperationStatus.Cancelling)).toBe(false);
    expect(bulk(MediaOperationStatus.Completed)).toBe(false);
    expect(bulk(MediaOperationStatus.Paused)).toBe(false);
    expect(bulk(MediaOperationStatus.Rendering, new Date())).toBe(false);
    const preview = { kind: MediaOperationKind.StudioPreview, status: MediaOperationStatus.Queued };
    expect(canPauseMediaOperation(preview)).toBe(false);
  });

  it('resumes a paused job, and withdraws a pause its worker has not reached', () => {
    const requested = new Date();
    expect(canResumeMediaOperation({ status: MediaOperationStatus.Paused, pauseRequestedAt: requested })).toBe(true);
    expect(canResumeMediaOperation({ status: MediaOperationStatus.Rendering, pauseRequestedAt: requested })).toBe(true);
    expect(canResumeMediaOperation({ status: MediaOperationStatus.Rendering, pauseRequestedAt: null })).toBe(false);
    const finished = { status: MediaOperationStatus.Completed, pauseRequestedAt: requested };
    expect(canResumeMediaOperation(finished)).toBe(false);
  });

  it('keeps a paused job unfinished: it can be cancelled, not retried or cleared', () => {
    expect(isActiveMediaOperation(MediaOperationStatus.Paused)).toBe(true);
    expect(canRetryMediaOperation(MediaOperationStatus.Paused)).toBe(false);
    expect(canDismissMediaOperation(MediaOperationStatus.Paused)).toBe(false);
  });

  it('only leaves paused for the queue or a cancel', () => {
    expect(canTransitionMediaOperation(MediaOperationStatus.Queued, MediaOperationStatus.Paused)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Rendering, MediaOperationStatus.Paused)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Paused, MediaOperationStatus.Queued)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Paused, MediaOperationStatus.Cancelled)).toBe(true);
    expect(canTransitionMediaOperation(MediaOperationStatus.Paused, MediaOperationStatus.Preparing)).toBe(false);
    expect(canTransitionMediaOperation(MediaOperationStatus.Paused, MediaOperationStatus.Completed)).toBe(false);
    expect(canTransitionMediaOperation(MediaOperationStatus.Cancelling, MediaOperationStatus.Paused)).toBe(false);
  });
});

describe('automatic retry (FL-104)', () => {
  it('gives every job exactly one automatic retry, after a delay', () => {
    expect(MEDIA_OPERATION_AUTO_RETRIES).toBe(1);
    expect(MEDIA_OPERATION_AUTO_RETRY_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('lost claims (FL-43)', () => {
  it('resumes a resumable kind at most twice, whatever its maxAttempts', () => {
    const job = (attempt: number, maxAttempts = 20) => ({
      kind: MediaOperationKind.StudioExport,
      attempt,
      maxAttempts,
    });
    expect([1, 2, 3].map((attempt) => canResumeLostClaim(job(attempt)))).toEqual([true, true, false]);
    // A lower allowance still wins.
    expect(canResumeLostClaim(job(1, 1))).toBe(false);
  });

  it('never resumes a kind that would start again from nothing', () => {
    for (const kind of [
      MediaOperationKind.StudioPreview,
      MediaOperationKind.RestorationPreview,
      MediaOperationKind.QuickEdit,
      MediaOperationKind.StudioBundleExport,
      MediaOperationKind.StudioBundleImport,
    ]) {
      expect(canResumeLostClaim({ kind, attempt: 1, maxAttempts: 3 })).toBe(false);
    }
  });
});

describe('chunk reuse', () => {
  it('reuses an identical completed chunk', () => {
    expect(canReuseChunk(stored(3), plan(3))).toEqual({ reusable: true });
  });

  it('refuses a chunk that only matches by number', () => {
    const different = stored(3, { chunkKey: 'chunk-from-another-render' });
    expect(canReuseChunk(different, plan(3))).toEqual({ reusable: false, reason: 'chunk-key-mismatch' });
  });

  it('refuses when the effect or audio history changed', () => {
    const changed = stored(3, { historyDigest: 'history-after-a-new-transition' });
    expect(canReuseChunk(changed, plan(3))).toEqual({ reusable: false, reason: 'history-mismatch' });
  });

  it('refuses when the seed, configuration or timebase changed', () => {
    expect(canReuseChunk(stored(3, { seed: 'other' }), plan(3))).toEqual({ reusable: false, reason: 'seed-mismatch' });
    expect(canReuseChunk(stored(3, { configDigest: 'hdr' }), plan(3))).toEqual({
      reusable: false,
      reason: 'config-mismatch',
    });
    expect(canReuseChunk(stored(3, { timebase: '24000/1001' }), plan(3))).toEqual({
      reusable: false,
      reason: 'timebase-mismatch',
    });
  });

  it('refuses a chunk marked complete with nothing on disk', () => {
    expect(canReuseChunk(stored(3, { outputPath: null }), plan(3))).toEqual({ reusable: false, reason: 'no-output' });
  });

  it('refuses a pending or invalidated chunk', () => {
    expect(canReuseChunk(stored(3, { state: MediaOperationCheckpointState.Pending }), plan(3))).toEqual({
      reusable: false,
      reason: 'not-complete',
    });
    expect(canReuseChunk(stored(3, { state: MediaOperationCheckpointState.Invalid }), plan(3))).toEqual({
      reusable: false,
      reason: 'not-complete',
    });
  });

  it('refuses a chunk covering a different range', () => {
    expect(canReuseChunk(stored(3, { endTicks: 9999n }), plan(3))).toEqual({
      reusable: false,
      reason: 'range-mismatch',
    });
  });
});

describe('resume planning', () => {
  const planned = [plan(0), plan(1), plan(2), plan(3), plan(4)];

  it('resumes at the first chunk that no longer matches', () => {
    const result = planChunkResume([stored(0), stored(1)], planned);

    expect(result.resumeFrom).toBe(2);
    expect(result.reusable.map((chunk) => chunk.sequence)).toEqual([0, 1]);
    expect(result.rerendered).toEqual([]);
  });

  it('stops at the first break even when a later chunk still matches', () => {
    // Chunk 1 is gone; chunk 2 is intact but inherits a history that no longer holds.
    const result = planChunkResume([stored(0), stored(2)], planned);

    expect(result.resumeFrom).toBe(1);
    expect(result.reusable.map((chunk) => chunk.sequence)).toEqual([0]);
  });

  it('walks back to a boundary a render may legitimately start at', () => {
    // Chunks 1 and 2 carry serialized filter state, so a resume cannot enter chunk 3 cold.
    const withState = [
      plan(0),
      plan(1, { requiresSequentialContext: true }),
      plan(2, { requiresSequentialContext: true }),
      plan(3),
      plan(4),
    ];
    const result = planChunkResume([stored(0), stored(1), stored(2)], withState);

    expect(result.resumeFrom).toBe(1);
    expect(result.reusable.map((chunk) => chunk.sequence)).toEqual([0]);
    // Chunks 1 and 2 matched on their own, and are rendered again anyway.
    expect(result.rerendered.map((chunk) => chunk.sequence)).toEqual([1, 2]);
  });

  it('starts from the beginning when nothing was checkpointed', () => {
    const result = planChunkResume([], planned);

    expect(result.resumeFrom).toBe(0);
    expect(result.reusable).toEqual([]);
  });

  it('reports the end when every chunk is reusable', () => {
    const result = planChunkResume(
      planned.map((chunk) => stored(chunk.sequence)),
      planned,
    );

    expect(result.resumeFrom).toBe(planned.length);
    expect(result.reusable).toHaveLength(planned.length);
  });
});

describe('progress', () => {
  it('reports null rather than a guess when the total is unknown', () => {
    expect(mediaOperationProgress(120, null)).toBeNull();
    expect(mediaOperationProgress(120, 0)).toBeNull();
  });

  it('counts real work and never exceeds 100', () => {
    expect(mediaOperationProgress(50, 200)).toBe(25);
    expect(mediaOperationProgress(400, 200)).toBe(100);
  });
});
