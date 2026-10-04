import { EnrichmentItemState, EnrichmentStage, MediaOperationStatus } from 'src/enum.js';
import {
  DEFAULT_ENRICHMENT_STAGES,
  coverFrameFor,
  emptyEnrichmentPlanResult,
  enrichmentConfigHash,
  enrichmentItemOutcome,
  enrichmentItemStates,
  enrichmentResumeIds,
  enrichmentStaleReason,
  identityHash,
  mergeEnrichmentItem,
  parseEnrichmentPlanResult,
  parseEnrichmentPlanSnapshot,
  planEnrichmentRetryPass,
  rankVideoFrames,
  resolveEnrichmentStages,
  sourceFingerprint,
  stageAppliesTo,
  stagesToRetry,
  videoMomentFrameTimestamps,
} from 'src/utils/enrichment-plan.js';

const ids = ['a1', 'a2', 'a3'];

const completed = (stage: EnrichmentStage) => ({ [stage]: { state: EnrichmentItemState.Completed } });
const failed = (stage: EnrichmentStage) => ({
  [stage]: { state: EnrichmentItemState.Failed, reasonKey: 'model-error' },
});

const pinnedConfig = {
  description: { modelName: 'm', fallbackModelName: 'f', device: 'AUTO', acceleration: 'auto', prompt: {} },
  lockedCheck: { modelName: 'n', threshold: 0.8, device: 'AUTO' },
  search: { modelName: 'clip' },
};

describe('resolveEnrichmentStages', () => {
  it('pulls in the reusable frames for the moment index and moment captions', () => {
    expect(resolveEnrichmentStages([EnrichmentStage.MomentCaptions])).toEqual({
      stages: [EnrichmentStage.Frames, EnrichmentStage.MomentCaptions],
      added: [EnrichmentStage.Frames],
    });
    expect(resolveEnrichmentStages([EnrichmentStage.MomentIndex, EnrichmentStage.Frames]).added).toEqual([]);
  });

  it('runs stages in their fixed order whatever order they were chosen in', () => {
    expect(
      resolveEnrichmentStages([EnrichmentStage.Description, EnrichmentStage.MomentIndex, EnrichmentStage.LockedCheck])
        .stages,
    ).toEqual([
      EnrichmentStage.Frames,
      EnrichmentStage.LockedCheck,
      EnrichmentStage.Description,
      EnrichmentStage.MomentIndex,
    ]);
  });

  it('never includes moment captions by default', () => {
    expect(DEFAULT_ENRICHMENT_STAGES).not.toContain(EnrichmentStage.MomentCaptions);
    expect(resolveEnrichmentStages(DEFAULT_ENRICHMENT_STAGES).stages).not.toContain(EnrichmentStage.MomentCaptions);
  });

  it('does not restore duplicate detection as a prerequisite of anything', () => {
    expect(resolveEnrichmentStages([EnrichmentStage.Description]).stages).toEqual([EnrichmentStage.Description]);
  });
});

describe('stageAppliesTo', () => {
  it('skips video stages for photos and the Locked-content check for videos', () => {
    expect(stageAppliesTo(EnrichmentStage.Frames, false)).toBe(false);
    expect(stageAppliesTo(EnrichmentStage.MomentIndex, true)).toBe(true);
    expect(stageAppliesTo(EnrichmentStage.LockedCheck, true)).toBe(false);
    expect(stageAppliesTo(EnrichmentStage.Description, true)).toBe(true);
    expect(stageAppliesTo(EnrichmentStage.Description, false)).toBe(true);
  });
});

describe('parseEnrichmentPlanSnapshot', () => {
  it('refuses a snapshot without assets, stages or pinned configuration', () => {
    expect(() => parseEnrichmentPlanSnapshot(null)).toThrow();
    expect(() => parseEnrichmentPlanSnapshot({ version: 1, assetIds: [], stages: ['description'] })).toThrow();
    expect(() => parseEnrichmentPlanSnapshot({ version: 1, assetIds: ['a'], stages: ['description'] })).toThrow();
  });

  it('reads a stored plan and orders its stages', () => {
    const snapshot = parseEnrichmentPlanSnapshot({
      version: 1,
      assetIds: ids,
      stages: ['moment-index', 'frames', 'bogus'],
      requestedStages: ['moment-index'],
      destinations: { enrichment: null, search: 'dest' },
      config: pinnedConfig,
      configHash: 'hash',
      requestKey: null,
      elevated: true,
    });
    expect(snapshot.stages).toEqual([EnrichmentStage.Frames, EnrichmentStage.MomentIndex]);
    expect(snapshot.destinations).toEqual({ enrichment: null, search: 'dest' });
    expect(snapshot.elevated).toBe(true);
  });
});

describe('plan result', () => {
  it('merges a retried asset into what the first attempt recorded', () => {
    let result = mergeEnrichmentItem(emptyEnrichmentPlanResult(), {
      id: 'a1',
      stages: { ...completed(EnrichmentStage.Frames), ...failed(EnrichmentStage.MomentIndex) },
    });
    result = mergeEnrichmentItem(result, { id: 'a1', stages: completed(EnrichmentStage.MomentIndex) });
    expect(result.items).toHaveLength(1);
    expect(enrichmentItemOutcome(result.items[0])).toBe(EnrichmentItemState.Completed);
  });

  it('retries only the stages that failed or were skipped because of a failure', () => {
    const item = {
      id: 'a1',
      stages: {
        ...completed(EnrichmentStage.Frames),
        ...failed(EnrichmentStage.Description),
        [EnrichmentStage.MomentCaptions]: { state: EnrichmentItemState.Skipped, reasonKey: 'dependency-failed' },
        [EnrichmentStage.LockedCheck]: { state: EnrichmentItemState.Skipped, reasonKey: 'not-an-image' },
      },
    };
    expect(
      stagesToRetry(item, [
        EnrichmentStage.Frames,
        EnrichmentStage.LockedCheck,
        EnrichmentStage.Description,
        EnrichmentStage.MomentCaptions,
      ]),
    ).toEqual([EnrichmentStage.Description, EnrichmentStage.MomentCaptions]);
  });

  it('plans the automatic retry once, over the failed assets only', () => {
    let result = mergeEnrichmentItem(emptyEnrichmentPlanResult(), {
      id: 'a1',
      stages: completed(EnrichmentStage.Description),
    });
    result = mergeEnrichmentItem(result, { id: 'a2', stages: failed(EnrichmentStage.Description) });
    const planned = planEnrichmentRetryPass({ assetIds: ids }, result);
    expect(planned?.retry).toEqual({ ids: ['a2'], processed: 0 });
    expect(planEnrichmentRetryPass({ assetIds: ids }, planned!)).toBeNull();
  });

  it('parses a damaged result as nothing reached', () => {
    expect(parseEnrichmentPlanResult('nonsense')).toEqual(emptyEnrichmentPlanResult());
    const damaged = { items: [{ id: 'a1', stages: { description: { state: 'bogus' } } }] };
    expect(parseEnrichmentPlanResult(damaged).items).toEqual([{ id: 'a1', stages: {} }]);
  });
});

describe('enrichmentItemStates', () => {
  const result = mergeEnrichmentItem(
    mergeEnrichmentItem(emptyEnrichmentPlanResult(), { id: 'a1', stages: completed(EnrichmentStage.Description) }),
    { id: 'a2', stages: failed(EnrichmentStage.Description) },
  );

  it('shows the asset in hand as running and the rest as queued while the plan runs', () => {
    const states = enrichmentItemStates(
      { assetIds: [...ids, 'a4'] },
      { ...result, inFlight: 'a3' },
      { status: MediaOperationStatus.Rendering },
    );
    expect(states.map(({ state }) => state)).toEqual([
      EnrichmentItemState.Completed,
      EnrichmentItemState.Failed,
      EnrichmentItemState.Running,
      EnrichmentItemState.Queued,
    ]);
  });

  it('shows unreached assets of a cancelled plan as cancelled, not queued', () => {
    const states = enrichmentItemStates({ assetIds: ids }, result, { status: MediaOperationStatus.Cancelled });
    expect(states[2].state).toBe(EnrichmentItemState.Cancelled);
  });

  it('shows a failed asset waiting for its automatic retry as queued, keeping its stages', () => {
    const planned = planEnrichmentRetryPass({ assetIds: ids }, result)!;
    const states = enrichmentItemStates({ assetIds: ids }, planned, { status: MediaOperationStatus.Queued });
    expect(states[1]).toMatchObject({ state: EnrichmentItemState.Queued, retryPending: true });
    expect(states[1].stages.description?.state).toBe(EnrichmentItemState.Failed);
  });

  it('shows assets a manual retry carried over as queued until the cursor reaches them', () => {
    const states = enrichmentItemStates({ assetIds: ['a2'] }, result, {
      status: MediaOperationStatus.Queued,
      processedUnits: '0',
    });
    expect(states[0]).toMatchObject({ state: EnrichmentItemState.Queued });
    expect(states[0].stages.description?.state).toBe(EnrichmentItemState.Failed);
  });

  it('resumes a manual retry from failed, unreached and retry-pending assets only', () => {
    expect(enrichmentResumeIds({ assetIds: ids }, result, 2)).toEqual(['a2', 'a3']);
  });
});

describe('provenance', () => {
  it('digests configurations independently of key order', () => {
    expect(enrichmentConfigHash({ a: 1, b: { c: 2, d: 3 } })).toBe(enrichmentConfigHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(enrichmentConfigHash({ a: 1 })).not.toBe(enrichmentConfigHash({ a: 2 }));
  });

  it('changes the source fingerprint when the original is replaced', () => {
    const fileModifiedAt = new Date('2026-01-01T00:00:00Z');
    const before = sourceFingerprint({ checksum: Buffer.from('aa', 'hex'), fileModifiedAt });
    const after = sourceFingerprint({ checksum: Buffer.from('bb', 'hex'), fileModifiedAt });
    expect(before).not.toBe(after);
  });

  it('keeps the source fingerprint when the original only moves', () => {
    const fileModifiedAt = new Date('2026-01-01T00:00:00Z');
    const atOldPath = { checksum: Buffer.from('aa', 'hex'), originalPath: '/library/a.mp4', fileModifiedAt };
    const atNewPath = { checksum: Buffer.from('aa', 'hex'), originalPath: '/library/2026/a.mp4', fileModifiedAt };
    expect(sourceFingerprint(atOldPath)).toBe(sourceFingerprint(atNewPath));
  });

  it('digests names without regard to order or repetition', () => {
    expect(identityHash(['Bo', 'Al', 'Al '])).toBe(identityHash(['Al', 'Bo']));
    expect(identityHash(['Al'])).not.toBe(identityHash(['Al', 'Bo']));
  });

  it('reports the most fundamental reason a generated result is stale', () => {
    const pinned = { sourceFingerprint: 's1', identityHash: 'i1', configHash: 'c1' };
    expect(enrichmentStaleReason(pinned, { sourceFingerprint: 's2', identityHash: 'i2' })).toBe('source-changed');
    expect(enrichmentStaleReason(pinned, { sourceFingerprint: 's1', identityHash: 'i2' })).toBe('identity-changed');
    expect(enrichmentStaleReason(pinned, { sourceFingerprint: 's1', identityHash: 'i1', configHash: 'c2' })).toBe(
      'config-changed',
    );
    expect(enrichmentStaleReason(pinned, pinned)).toBeNull();
    expect(enrichmentStaleReason(undefined, pinned)).toBeNull();
  });
});

describe('frames', () => {
  it('cuts six evenly spaced frames clear of both ends', () => {
    const times = videoMomentFrameTimestamps(70_000);
    expect(times).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
  });

  it('cuts fewer frames for a very short video and none for an empty one', () => {
    expect(videoMomentFrameTimestamps(0)).toEqual([]);
    expect(videoMomentFrameTimestamps(400)).toEqual([200]);
    expect(new Set(videoMomentFrameTimestamps(1200)).size).toBe(videoMomentFrameTimestamps(1200).length);
  });

  it('ranks frames best first and breaks ties by time', () => {
    const ranks = rankVideoFrames([
      { frameIndex: 0, score: 10 },
      { frameIndex: 1, score: 30 },
      { frameIndex: 2, score: 30 },
    ]);
    expect([...ranks]).toEqual([
      [1, 1],
      [2, 2],
      [0, 3],
    ]);
  });

  it('matches a chosen cover to the nearest frame and otherwise uses the best one', () => {
    const frames = [
      { timestampMs: 1000, rank: 2 },
      { timestampMs: 5000, rank: 1 },
      { timestampMs: 9000, rank: 3 },
    ];
    expect(coverFrameFor(frames, null)).toBe(frames[1]);
    expect(coverFrameFor(frames, 8200)).toBe(frames[2]);
    expect(coverFrameFor([], 100)).toBeUndefined();
  });
});
