import { RenderWorkerAdmissionDto } from 'src/dtos/render-worker.dto.js';
import { StudioExportSettingsDto } from 'src/dtos/studio-export.dto.js';
import { MediaOperationDestination, MediaOperationKind, RenderWorkerRefusalReason } from 'src/enum.js';
import {
  ClaimAdmissionInput,
  RenderOutputRefusal,
  SessionAdmissionInput,
  evaluateClaimAdmission,
  evaluateRenderOutput,
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
    engineDigest: 'engine-1',
    conformanceMaxAgeMs: 60 * 60_000,
    ...overrides.worker,
  },
  session: {
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    revoked: false,
    scopes: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration],
    gpuMemoryBytes: 24 * 1024 ** 3,
    engineDigest: 'engine-1',
    conformanceReportedAt: minutesAgo(5),
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

  it('never lets a LAN worker take a job the person sent to Frameleaf Cloud, or the reverse', () => {
    expect(
      evaluateClaimAdmission(claimInput({ operation: { destination: MediaOperationDestination.FrameleafCloud } })),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.DestinationMismatch });
    expect(
      evaluateClaimAdmission(
        claimInput({
          worker: { destination: MediaOperationDestination.FrameleafCloud },
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

    it('admits the measured WebCodecs AVC writer at creation and claim without treating a decoder as a writer', () => {
      const capabilities = { codecs: ['webcodecs-avc'], formats: ['mp4'] };
      expect(
        evaluateRenderOutput(
          [
            {
              gpuMemoryBytes: 2 * 1024 ** 3,
              ...capabilities,
              colorPrecision: { maxBitDepth: 8, hdr10: false, dolbyVision: false },
            },
          ],
          { format: 'mp4-h264', color: 'preserve', resolution: '720p' },
        ),
      ).toEqual({ supported: true });
      expect(
        evaluateClaimAdmission(claimInput({ session: { capabilities }, operation: exporting('mp4-h264') })),
      ).toEqual({ admitted: true });
      for (const codecs of [['h264'], ['avc1.64001f'], ['h264_cuvid']]) {
        expect(
          evaluateClaimAdmission(
            claimInput({ session: { capabilities: { codecs, formats: ['mp4'] } }, operation: exporting('mp4-h264') }),
          ),
        ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
      }
      for (const format of ['mp4-hevc-main10', 'webm-av1', 'prores-422-hq']) {
        expect(evaluateClaimAdmission(claimInput({ session: { capabilities }, operation: exporting(format) }))).toEqual(
          { admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported },
        );
      }
      expect(
        provesOutput({ codecs: ['webcodecs-avc'], formats: ['webm'] }, requiredOutput({ format: 'mp4-h264' })!),
      ).toBe(false);
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

describe('evaluateRenderOutput (FL-42)', () => {
  const gib = 1024 ** 3;
  const sdr = {
    gpuMemoryBytes: 12 * gib,
    codecs: ['h264_nvenc', 'hevc_nvenc'],
    formats: ['mp4'],
    colorPrecision: null,
  };
  const hdr = { ...sdr, colorPrecision: { maxBitDepth: 10, hdr10: true, dolbyVision: false } };
  const request = { format: 'mp4-h264', color: 'preserve', resolution: '1080p' };

  it.each([
    ['sdr-jpeg', 'frameleaf-sdr-jpeg', 'jpeg', 8, false],
    ['hdr-jpeg', 'frameleaf-ultrahdr-jpeg', 'jpeg', 10, true],
    ['hdr-heic', 'frameleaf-heic-pq', 'heic', 10, true],
  ] as const)(
    'requires actual %s writer and range proof independently of video capabilities',
    (format, codec, container, maxBitDepth, hdr10) => {
      const settings = { format, color: 'preserve', resolution: 'original' };
      expect(evaluateRenderOutput([hdr], settings)).toMatchObject({ supported: false, refusal: 'codec-unavailable' });
      const candidate = {
        gpuMemoryBytes: 8 * gib,
        codecs: [codec],
        formats: [container],
        colorPrecision: { maxBitDepth, hdr10, dolbyVision: false },
      };
      expect(evaluateRenderOutput([candidate], settings)).toEqual({ supported: true });
      expect(evaluateRenderOutput([{ ...candidate, gpuMemoryBytes: 4 * gib }], settings)).toMatchObject({
        supported: false,
        refusal: 'insufficient-memory',
      });
      if (hdr10)
        expect(
          evaluateRenderOutput(
            [{ ...candidate, colorPrecision: { maxBitDepth: 8, hdr10: false, dolbyVision: false } }],
            settings,
          ),
        ).toMatchObject({ supported: false, refusal: 'incompatible-color' });
    },
  );

  // These fixtures independently exercise submission and real claim admission. A decoder, or
  // encoder evidence without its muxer, must never leave an export queued with no eligible worker.
  it.each([
    ['decoder only', ['h264_cuvid'], ['mp4']],
    ['bare codec name', ['h264'], ['mp4']],
    ['wrong container', ['webcodecs-avc'], ['webm']],
    ['missing container', ['webcodecs-avc'], []],
  ])('refuses %s evidence at submission as well as claim', (_name, codecs, formats) => {
    const capabilities = { codecs, formats };
    const candidate = { ...sdr, ...capabilities };

    expect(evaluateClaimAdmission(claimInput({ session: { capabilities }, operation: { settings: request } }))).toEqual(
      { admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported },
    );
    expect(evaluateRenderOutput([candidate], request)).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.CodecUnavailable,
    });
  });

  it('refuses legacy sessions without any container evidence', () => {
    const candidate = { gpuMemoryBytes: 12 * gib, codecs: ['webcodecs-avc'], colorPrecision: null };
    expect(
      evaluateClaimAdmission(claimInput({ session: { capabilities: null }, operation: { settings: request } })),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
    expect(evaluateRenderOutput([candidate], request)).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.CodecUnavailable,
    });
  });

  it('never joins encoder and container evidence from different sessions', () => {
    const candidates = [
      { ...sdr, codecs: ['webcodecs-avc'], formats: ['webm'] },
      { ...sdr, codecs: ['libaom-av1'], formats: ['mp4'] },
    ];
    for (const { codecs, formats } of candidates) {
      expect(
        evaluateClaimAdmission(
          claimInput({ session: { capabilities: { codecs, formats } }, operation: { settings: request } }),
        ),
      ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
    }
    expect(evaluateRenderOutput(candidates, request)).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.CodecUnavailable,
    });
  });

  it.each([
    ['webcodecs-avc', 'mp4'],
    ['WEBCODECS-AVC', 'MP4'],
    ['LIBX264', 'MP4'],
  ])('admits the same session proving writer %s and container %s', (codec, container) => {
    const capabilities = { codecs: [codec], formats: [container] };
    const candidate = { ...sdr, ...capabilities };
    expect(evaluateRenderOutput([candidate], request)).toEqual({ supported: true });
    expect(evaluateClaimAdmission(claimInput({ session: { capabilities }, operation: { settings: request } }))).toEqual(
      { admitted: true },
    );
  });

  it('needs a qualified session at all', () => {
    expect(evaluateRenderOutput([], request)).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.NoQualifiedWorker,
    });
  });

  it('never infers memory, codecs or colour a check did not verify', () => {
    expect(evaluateRenderOutput([{ ...sdr, gpuMemoryBytes: null }], request)).toMatchObject({
      refusal: RenderOutputRefusal.InsufficientMemory,
    });
    expect(
      evaluateRenderOutput([{ ...sdr, gpuMemoryBytes: 4 * gib }], { ...request, resolution: '2160p' }),
    ).toMatchObject({
      refusal: RenderOutputRefusal.InsufficientMemory,
    });
    expect(evaluateRenderOutput([{ ...sdr, codecs: [] }], request)).toMatchObject({
      refusal: RenderOutputRefusal.CodecUnavailable,
    });
    expect(evaluateRenderOutput([sdr], { ...request, format: 'mp4-hevc-main10' })).toMatchObject({
      refusal: RenderOutputRefusal.IncompatibleColor,
    });
    expect(evaluateRenderOutput([hdr], { ...request, format: 'mp4-hevc-main10', color: 'dolby-vision' })).toMatchObject(
      {
        refusal: RenderOutputRefusal.IncompatibleColor,
      },
    );
  });

  it('admits what one session verified in full', () => {
    expect(evaluateRenderOutput([sdr], request)).toEqual({ supported: true });
    expect(
      evaluateRenderOutput([sdr, hdr], { format: 'mp4-hevc-main10', color: 'hdr10', resolution: '2160p' }),
    ).toEqual({
      supported: true,
    });
  });
});

describe('Sidecar v1 same-session capability admission', () => {
  // Synthetic protocol fixtures exercise admission; they do not qualify a real worker.
  const profile = 'mp4-h264+srt-sidecar-v1';
  const settings = {
    format: 'mp4-h264',
    color: 'preserve',
    resolution: '720p',
    quality: 'high',
    audio: 'preserve',
    subtitleMode: 'sidecar',
  };
  const capabilities = { codecs: ['webcodecs-avc'], formats: ['mp4', profile] };
  const candidate = { gpuMemoryBytes: 8 * 1024 ** 3, ...capabilities, colorPrecision: null, engineDigest: 'engine-1' };

  it('requires the exact profile, real encoder and MP4 in the same session', () => {
    expect(provesOutput(capabilities, requiredOutput(settings)!)).toBe(true);
    for (const evidence of [
      null,
      { codecs: [], formats: ['mp4', profile] },
      { codecs: ['h264'], formats: ['mp4', profile] },
      { codecs: capabilities.codecs, formats: [profile] },
      ...[
        [],
        ['mp4'],
        ['mp4', 'srt'],
        ['mp4', profile.toUpperCase()],
        ['mp4', 'mp4-h264+srt-sidecar-v2'],
        ['mp4', `${profile}-extra`],
      ].map((formats) => ({ codecs: capabilities.codecs, formats })),
    ]) {
      expect(provesOutput(evidence, requiredOutput(settings)!)).toBe(false);
    }
  });

  it('refuses unknown modes and unsupported v1 tuples without ordinary-output fallback', () => {
    for (const patch of [
      { subtitleMode: 'unknown' },
      { format: 'prores-422-hq' },
      { color: 'hdr10' },
      { resolution: '1080p' },
      { quality: 'draft' },
      { audio: 'off' },
      { format: '' },
    ]) {
      expect(provesOutput(capabilities, requiredOutput({ ...settings, ...patch })!)).toBe(false);
    }
    for (const subtitleMode of [undefined, 'burn', 'off']) {
      expect(
        provesOutput({ codecs: capabilities.codecs, formats: ['mp4'] }, requiredOutput({ ...settings, subtitleMode })!),
      ).toBe(true);
    }
  });

  it('uses immutable claim settings and requires the expected engine binding', () => {
    expect(evaluateClaimAdmission(claimInput({ session: { capabilities }, operation: { settings } }))).toEqual({
      admitted: true,
    });
    for (const session of [{ engineDigest: null }, { engineDigest: 'engine-2' }]) {
      expect(
        evaluateClaimAdmission(claimInput({ session: { ...session, capabilities }, operation: { settings } })),
      ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.EngineDigestMismatch });
    }
    expect(
      evaluateClaimAdmission(claimInput({ session: { capabilities }, operation: { settings, snapshot: {} } })),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.EngineDigestMismatch });
    expect(
      evaluateClaimAdmission(
        claimInput({ session: { capabilities: { ...capabilities, formats: ['mp4'] } }, operation: { settings } }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.CodecUnsupported });
  });

  it('never combines memory, media or profile across candidates', () => {
    expect(evaluateRenderOutput([candidate], settings)).toEqual({ supported: true });
    expect(
      evaluateRenderOutput(
        [
          { ...candidate, formats: ['mp4'] },
          { ...candidate, gpuMemoryBytes: 1, formats: [profile] },
        ],
        settings,
      ),
    ).toEqual({ supported: false, refusal: RenderOutputRefusal.CodecUnavailable });
    expect(evaluateRenderOutput([{ ...candidate, engineDigest: undefined }], settings)).toEqual({
      supported: false,
      refusal: RenderOutputRefusal.CodecUnavailable,
    });
  });

  it('round-trips the profile through the native bounded admission DTO without changing legacy strings', () => {
    expect(StudioExportSettingsDto.schema.shape.subtitleMode.safeParse('sidecar').success).toBe(false);
    const formats = RenderWorkerAdmissionDto.schema.shape.formats;
    expect(formats.parse(['mp4', profile, 'legacy-container'])).toEqual(['mp4', profile, 'legacy-container']);
    expect(formats.safeParse(['x'.repeat(31)]).success).toBe(false);
    expect(formats.safeParse(Array.from({ length: 33 }, () => 'mp4')).success).toBe(false);
  });
});
