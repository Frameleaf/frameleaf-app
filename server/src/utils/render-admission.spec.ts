import { MediaOperationDestination, MediaOperationKind, RenderWorkerRefusalReason } from 'src/enum.js';
import {
  ClaimAdmissionInput,
  SessionAdmissionInput,
  evaluateClaimAdmission,
  evaluateRunningLimits,
  evaluateSessionAdmission,
  isWorkerRefusal,
  provesOutput,
  requiredOutput,
  signInputGrant,
  tightestLimits,
  verifyInputGrant,
} from 'src/utils/render-admission.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const sessionInput = (
  overrides: Partial<SessionAdmissionInput['worker']> = {},
  report: Partial<SessionAdmissionInput['report']> = {},
) =>
  ({
    worker: {
      revoked: false,
      engineDigest: 'engine-1',
      conformanceMaxAgeMs: 60 * 60_000,
      lastConformanceReportedAt: minutesAgo(120),
      ...overrides,
    },
    report: { engineDigest: 'engine-1', conformanceReportedAt: minutesAgo(5), softwareRenderer: false, ...report },
    now: NOW,
  }) satisfies SessionAdmissionInput;

describe(evaluateSessionAdmission.name, () => {
  it('admits fresh, unreplayed evidence from an active worker with the enrolled engine', () => {
    expect(evaluateSessionAdmission(sessionInput())).toEqual({ admitted: true });
  });

  it('refuses a revoked worker before looking at anything else', () => {
    expect(evaluateSessionAdmission(sessionInput({ revoked: true }, { softwareRenderer: true }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.WorkerRevoked,
    });
  });

  it('refuses evidence older than the configured maximum age', () => {
    expect(evaluateSessionAdmission(sessionInput({}, { conformanceReportedAt: minutesAgo(90) }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.ConformanceStale,
    });
  });

  it('refuses evidence dated in the future beyond clock skew', () => {
    expect(evaluateSessionAdmission(sessionInput({}, { conformanceReportedAt: minutesAgo(-10) }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.ConformanceStale,
    });
  });

  it('refuses a replayed report: the same timestamp as the last one accepted', () => {
    const accepted = minutesAgo(5);
    expect(
      evaluateSessionAdmission(
        sessionInput({ lastConformanceReportedAt: accepted }, { conformanceReportedAt: accepted }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.ConformanceReplayed });
  });

  it('refuses a report older than the last one accepted', () => {
    expect(
      evaluateSessionAdmission(
        sessionInput({ lastConformanceReportedAt: minutesAgo(2) }, { conformanceReportedAt: minutesAgo(5) }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.ConformanceReplayed });
  });

  it('refuses a worker reporting a different engine digest than it was enrolled with', () => {
    expect(evaluateSessionAdmission(sessionInput({}, { engineDigest: 'engine-2' }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.EngineDigestMismatch,
    });
  });

  it('accepts any engine digest when the worker was enrolled without one', () => {
    expect(evaluateSessionAdmission(sessionInput({ engineDigest: null }, { engineDigest: 'anything' }))).toEqual({
      admitted: true,
    });
  });

  it('refuses a software or fallback renderer', () => {
    expect(evaluateSessionAdmission(sessionInput({}, { softwareRenderer: true }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.SoftwareRenderer,
    });
  });
});

const claimInput = (
  overrides: {
    worker?: Partial<ClaimAdmissionInput['worker']>;
    session?: Partial<ClaimAdmissionInput['session']>;
    operation?: Partial<ClaimAdmissionInput['operation']>;
    owner?: Partial<ClaimAdmissionInput['owner']>;
    destinationHealth?: Partial<ClaimAdmissionInput['destinationHealth']>;
  } = {},
): ClaimAdmissionInput => ({
  worker: {
    id: 'worker-1',
    name: 'Basement GPU',
    destination: MediaOperationDestination.Lan,
    revoked: false,
    kinds: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration],
    gpuMemoryBytes: 24 * 1024 ** 3,
    activeOperations: 0,
    limits: { maxConcurrentOperations: 2, maxWallClockMs: null, maxOutputBytes: null },
    ...overrides.worker,
  },
  session: {
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    revoked: false,
    scopes: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration],
    gpuMemoryBytes: 24 * 1024 ** 3,
    engineDigest: 'engine-1',
    ...overrides.session,
  },
  operation: {
    kind: MediaOperationKind.StudioExport,
    destination: MediaOperationDestination.Lan,
    destinationDetail: null,
    snapshot: { engineDigest: 'engine-1' },
    ...overrides.operation,
  },
  owner: {
    activeOperations: 0,
    limits: { maxConcurrentOperations: 2, maxWallClockMs: null, maxOutputBytes: null },
    ...overrides.owner,
  },
  destinationHealth: {
    destination: MediaOperationDestination.Lan,
    state: 'unknown',
    reason: null,
    checkedAt: null,
    ...overrides.destinationHealth,
  },
  now: NOW,
});

describe(evaluateClaimAdmission.name, () => {
  it('admits a scoped, in-budget claim on the right destination', () => {
    expect(evaluateClaimAdmission(claimInput())).toEqual({ admitted: true });
  });

  it('refuses an expired session', () => {
    expect(evaluateClaimAdmission(claimInput({ session: { expiresAt: minutesAgo(1) } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.SessionExpired,
    });
  });

  it('refuses a revoked session even when the worker row still reads active', () => {
    expect(evaluateClaimAdmission(claimInput({ session: { revoked: true } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.WorkerRevoked,
    });
  });

  it('never lets a LAN worker take a job the person sent to RunPod, or the reverse', () => {
    expect(
      evaluateClaimAdmission(claimInput({ operation: { destination: MediaOperationDestination.RunPod } })),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.DestinationMismatch });
    expect(
      evaluateClaimAdmission(
        claimInput({
          worker: { destination: MediaOperationDestination.RunPod },
          operation: { destination: MediaOperationDestination.Local },
        }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.DestinationMismatch });
  });

  it('honours an operation pinned to a specific worker by id or by name', () => {
    expect(evaluateClaimAdmission(claimInput({ operation: { destinationDetail: 'worker-1' } }))).toEqual({
      admitted: true,
    });
    expect(evaluateClaimAdmission(claimInput({ operation: { destinationDetail: 'Basement GPU' } }))).toEqual({
      admitted: true,
    });
    expect(evaluateClaimAdmission(claimInput({ operation: { destinationDetail: 'worker-2' } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.WorkerMismatch,
    });
  });

  it('refuses a kind outside the session scopes even if the worker row allows it', () => {
    expect(evaluateClaimAdmission(claimInput({ session: { scopes: [MediaOperationKind.Restoration] } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.ScopeExceeded,
    });
  });

  it('never admits a job that runs on the server, even one the scopes list (FL-73)', () => {
    for (const kind of [
      MediaOperationKind.Bulk,
      MediaOperationKind.MediaHealth,
      MediaOperationKind.ICloudSync,
      MediaOperationKind.TakeoutImport,
      MediaOperationKind.PhysicalDeduplication,
    ]) {
      expect(
        evaluateClaimAdmission(
          claimInput({
            worker: { kinds: [kind], destination: MediaOperationDestination.Local },
            session: { scopes: [kind] },
            operation: { kind, destination: MediaOperationDestination.Local },
          }),
        ),
      ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.ScopeExceeded });
    }
  });

  it('refuses a kind the worker row no longer allows even if the session was scoped to it', () => {
    expect(evaluateClaimAdmission(claimInput({ worker: { kinds: [MediaOperationKind.Restoration] } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.ScopeExceeded,
    });
  });

  it('refuses when the destination reports itself unavailable, and does not refuse on unknown', () => {
    expect(evaluateClaimAdmission(claimInput({ destinationHealth: { state: 'unavailable' } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.DestinationUnavailable,
    });
    expect(evaluateClaimAdmission(claimInput({ destinationHealth: { state: 'unknown' } }))).toEqual({
      admitted: true,
    });
  });

  it('refuses a job snapshotted against a different engine than the session was admitted with', () => {
    expect(evaluateClaimAdmission(claimInput({ operation: { snapshot: { engineDigest: 'engine-9' } } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.EngineDigestMismatch,
    });
  });

  it('refuses a job that needs more GPU memory than the session was admitted with', () => {
    expect(
      evaluateClaimAdmission(
        claimInput({
          operation: { snapshot: { gpuMemoryHintBytes: 32 * 1024 ** 3 } },
        }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.GpuMemoryInsufficient });
  });

  it('measures the GPU hint against the admitted figure, not a later worker claim', () => {
    expect(
      evaluateClaimAdmission(
        claimInput({
          worker: { gpuMemoryBytes: 80 * 1024 ** 3 },
          session: { gpuMemoryBytes: 8 * 1024 ** 3 },
          operation: { snapshot: { gpuMemoryHintBytes: String(16 * 1024 ** 3) } },
        }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.GpuMemoryInsufficient });
  });

  describe('codecs and containers the session proved (FL-95)', () => {
    const proven = { codecs: ['hevc_nvenc', 'h264_nvenc'], formats: ['mp4', 'mov'] };
    const exporting = (format: string) => ({ settings: { format, resolution: '2160p' } });

    it('admits an export whose encoder and container the session verified', () => {
      expect(
        evaluateClaimAdmission(
          claimInput({ session: { capabilities: proven }, operation: exporting('mp4-hevc-main10') }),
        ),
      ).toEqual({ admitted: true });
      expect(
        evaluateClaimAdmission(claimInput({ session: { capabilities: proven }, operation: exporting('mp4-h264') })),
      ).toEqual({ admitted: true });
    });

    it('refuses an encoder or a container the session did not verify, and an unknown format', () => {
      for (const format of ['webm-av1', 'prores-422-hq', 'gif-89a']) {
        expect(
          evaluateClaimAdmission(claimInput({ session: { capabilities: proven }, operation: exporting(format) })),
          format,
        ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
      }
      // HEVC proven but not the WebM container: still refused.
      expect(
        evaluateClaimAdmission(
          claimInput({
            session: { capabilities: { codecs: ['libaom-av1'], formats: ['mp4'] } },
            operation: exporting('webm-av1'),
          }),
        ),
      ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
    });

    it('gives a session that proved nothing no job that names a format, and does not stop it asking', () => {
      const decision = evaluateClaimAdmission(claimInput({ operation: exporting('mp4-h264') }));
      expect(decision).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
      expect(isWorkerRefusal(RenderWorkerRefusalReason.CodecUnsupported)).toBe(false);
      // A job with no output format (a restoration, a preview) needs no codec evidence.
      expect(evaluateClaimAdmission(claimInput())).toEqual({ admitted: true });
    });

    it('matches encoder names exactly, case-insensitively, so a decoder proves nothing', () => {
      expect(
        provesOutput({ codecs: ['LIBX265'], formats: ['MP4'] }, requiredOutput({ format: 'mp4-hevc-main10' })!),
      ).toBe(true);
      for (const decoder of ['h264_cuvid', 'hevc_cuvid', 'h264', 'hevc', 'av1', 'libdav1d']) {
        expect(
          provesOutput({ codecs: [decoder], formats: ['mp4', 'webm'] }, requiredOutput({ format: 'mp4-h264' })!),
          decoder,
        ).toBe(false);
      }
      expect(
        provesOutput(
          { codecs: ['h264_cuvid', 'hevc_cuvid'], formats: ['mp4'] },
          requiredOutput({ format: 'mp4-hevc-main10' })!,
        ),
      ).toBe(false);
      expect(requiredOutput({})).toBeNull();
      expect(requiredOutput(undefined)).toBeNull();
    });
  });

  it('refuses when the worker already holds its concurrency', () => {
    expect(evaluateClaimAdmission(claimInput({ worker: { activeOperations: 2 } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.WorkerConcurrency,
    });
  });

  it('refuses when the owner already has their concurrency claimed anywhere', () => {
    expect(evaluateClaimAdmission(claimInput({ owner: { activeOperations: 2 } }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.UserConcurrency,
    });
  });

  it('classifies worker refusals apart from per-operation refusals', () => {
    expect(isWorkerRefusal(RenderWorkerRefusalReason.WorkerConcurrency)).toBe(true);
    expect(isWorkerRefusal(RenderWorkerRefusalReason.SessionExpired)).toBe(true);
    expect(isWorkerRefusal(RenderWorkerRefusalReason.UserConcurrency)).toBe(false);
    expect(isWorkerRefusal(RenderWorkerRefusalReason.GpuMemoryInsufficient)).toBe(false);
    expect(isWorkerRefusal(RenderWorkerRefusalReason.DestinationMismatch)).toBe(false);
  });
});

describe(tightestLimits.name, () => {
  it('takes the strictest of every ceiling and treats null as no ceiling', () => {
    expect(
      tightestLimits(
        { maxConcurrentOperations: 4, maxWallClockMs: null, maxOutputBytes: 10 },
        { maxConcurrentOperations: 2, maxWallClockMs: 500, maxOutputBytes: null },
        null,
        { maxConcurrentOperations: 3, maxWallClockMs: 900, maxOutputBytes: 5 },
      ),
    ).toEqual({ maxConcurrentOperations: 2, maxWallClockMs: 500, maxOutputBytes: 5 });
  });

  it('has no concurrency ceiling when no source sets one', () => {
    expect(tightestLimits(null).maxConcurrentOperations).toBe(Infinity);
  });
});

describe(evaluateRunningLimits.name, () => {
  const limits = { maxConcurrentOperations: 1, maxWallClockMs: 10 * 60_000, maxOutputBytes: 1000 };

  it('passes an operation inside both ceilings', () => {
    expect(evaluateRunningLimits({ startedAt: minutesAgo(5), outputBytes: 500, limits, now: NOW })).toEqual({
      admitted: true,
    });
  });

  it('stops an operation over its wall clock', () => {
    expect(evaluateRunningLimits({ startedAt: minutesAgo(11), outputBytes: 0, limits, now: NOW })).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.WallClockExceeded,
    });
  });

  it('stops an operation over its output ceiling', () => {
    expect(evaluateRunningLimits({ startedAt: minutesAgo(1), outputBytes: 1001, limits, now: NOW })).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.OutputBytesExceeded,
    });
  });

  it('never stops an operation with no ceilings', () => {
    expect(
      evaluateRunningLimits({
        startedAt: minutesAgo(10_000),
        outputBytes: Number.MAX_SAFE_INTEGER,
        limits: { maxConcurrentOperations: 1, maxWallClockMs: null, maxOutputBytes: null },
        now: NOW,
      }),
    ).toEqual({ admitted: true });
  });
});

describe('input grants', () => {
  const binding = { claimToken: 'claim-a', sessionTokenHash: Buffer.from('session-a') };
  const payload = {
    operationId: 'op-1',
    inputId: 'source',
    resourceId: 'asset-1',
    token: null,
    expiresAt: NOW.getTime() + 60_000,
  };

  it('verifies a grant against the operation, claim and session it was minted for', () => {
    const grant = signInputGrant(payload, binding);
    expect(verifyInputGrant(grant, { operationId: 'op-1', binding, now: NOW })).toEqual({ valid: true, payload });
  });

  it('rejects a grant presented against another operation, even by the same worker', () => {
    const grant = signInputGrant(payload, binding);
    expect(verifyInputGrant(grant, { operationId: 'op-2', binding, now: NOW })).toEqual({
      valid: false,
      reason: 'operation-mismatch',
    });
  });

  it('rejects a grant once the claim has changed hands', () => {
    const grant = signInputGrant(payload, binding);
    expect(
      verifyInputGrant(grant, { operationId: 'op-1', binding: { ...binding, claimToken: 'claim-b' }, now: NOW }),
    ).toEqual({ valid: false, reason: 'signature' });
  });

  it('rejects a grant presented under a different worker session', () => {
    const grant = signInputGrant(payload, binding);
    expect(
      verifyInputGrant(grant, {
        operationId: 'op-1',
        binding: { ...binding, sessionTokenHash: Buffer.from('session-b') },
        now: NOW,
      }),
    ).toEqual({ valid: false, reason: 'signature' });
  });

  it('rejects an expired grant', () => {
    const grant = signInputGrant(payload, binding);
    expect(verifyInputGrant(grant, { operationId: 'op-1', binding, now: new Date(payload.expiresAt + 1) })).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('rejects a grant whose payload was edited after signing', () => {
    const grant = signInputGrant(payload, binding);
    const [, signature] = grant.split('.', 2);
    const forged = Buffer.from(JSON.stringify({ ...payload, resourceId: 'asset-2' })).toString('base64url');
    expect(verifyInputGrant(`${forged}.${signature}`, { operationId: 'op-1', binding, now: NOW })).toEqual({
      valid: false,
      reason: 'signature',
    });
  });

  it('carries an FL-90 read grant opaquely and rejects a payload without the token field', () => {
    const studio = { ...payload, inputId: 'font:inter', resourceId: 'inter', token: 'fl90-jwt' };
    const grant = signInputGrant(studio, binding);
    expect(verifyInputGrant(grant, { operationId: 'op-1', binding, now: NOW })).toEqual({
      valid: true,
      payload: studio,
    });

    const withoutToken = {
      operationId: payload.operationId,
      inputId: payload.inputId,
      resourceId: payload.resourceId,
      expiresAt: payload.expiresAt,
    };
    const legacy = signInputGrant(withoutToken as never, binding);
    expect(verifyInputGrant(legacy, { operationId: 'op-1', binding, now: NOW })).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rejects malformed grants without throwing', () => {
    expect(verifyInputGrant('', { operationId: 'op-1', binding, now: NOW })).toEqual({
      valid: false,
      reason: 'malformed',
    });
    expect(verifyInputGrant('a.b.c', { operationId: 'op-1', binding, now: NOW })).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });
});
