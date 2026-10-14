import { describe, expect, it } from 'vitest';
import {
  RenderWorkerAdmissionDto,
  RenderWorkerCreateDto,
  RenderWorkerSessionDto,
  RenderWorkerUpdateDto,
} from 'src/dtos/render-worker.dto.js';
import { MediaOperationKind, RenderWorkerStatus } from 'src/enum.js';
import {
  GpuWorkingBudgetApprovalSchema,
  GpuWorkingBudgetEvidenceSchema,
  evaluateApprovedGpuWorkingBudget,
  evaluateApprovedRenderSession,
} from 'src/utils/gpu-working-budget-policy.js';

// Synthetic policy fixtures are not reviewed native receipts or actual GPU qualification.
const evidence = {
  metric: 'measured-usable-gpu-working-budget-v1' as const,
  profileDigest: 'a'.repeat(64),
  measurementId: '11111111-1111-4111-8111-111111111111',
  receiptDigest: 'b'.repeat(64),
  workerId: '0195e2a0-0000-7000-8000-00000000aaa1',
  engineDigest: 'sha256:engine',
  buildDigest: 'c'.repeat(64),
  browserIdentity: 'reviewed-browser-build',
  deviceLifetimeId: '22222222-2222-4222-8222-222222222222',
  bindingMethod: 'same-export-device' as const,
  topology: 'unknown' as const,
  topologyEvidenceDigest: null,
  hardwareBackend: 'hardware' as const,
  encoderEvidenceDigest: 'd'.repeat(64),
  pressureEnvelopeDigest: 'e'.repeat(64),
  outputReceiptDigest: 'f'.repeat(64),
  measuredBytes: '2147483648',
  headroomBytes: '536870912',
  completedAt: '2026-10-12T00:00:00.000Z',
  validUntil: '2026-10-12T00:01:00.000Z',
  status: 'passed' as const,
};
const { workerId, ...approvedEvidence } = evidence;
const capabilities = { codecs: ['h264'], formats: ['mp4'], colorPrecision: null };
const approval = { evidence: approvedEvidence, capabilities };
const input = () => ({
  worker: {
    id: workerId,
    engineDigest: evidence.engineDigest as string | null,
    gpuMemoryBytes: null as string | null,
    maxConcurrentOperations: 1,
    gpuWorkingBudgetApproval: approval as unknown,
  },
  evidence: evidence as unknown,
  capabilities: capabilities as unknown,
  reportedBytes: evidence.measuredBytes as string | null,
  phase: { kind: 'admission' as const },
  now: new Date('2026-10-12T00:00:30.000Z'),
  conformanceExpiresAt: new Date('2026-10-12T00:02:00.000Z'),
  credentialExpiresAt: new Date('2026-10-12T00:03:00.000Z'),
});
const success = (qualifiedBytes = '2147483648') => ({
  valid: true,
  measuredBytes: '2147483648',
  qualifiedBytes,
  expiresAt: '2026-10-12T00:01:00.000Z',
});

const liveSessionInput = () => ({
  worker: {
    ...input().worker,
    status: RenderWorkerStatus.Active,
    kinds: [MediaOperationKind.StudioExport],
    conformanceMaxAgeMs: 120_000,
  },
  session: {
    workerId,
    revokedAt: null as Date | null,
    expiresAt: input().credentialExpiresAt,
    engineDigest: evidence.engineDigest as string | null,
    conformanceReportedAt: new Date(evidence.completedAt),
    scopes: [MediaOperationKind.StudioExport],
    gpuMemoryBytes: '2147483648' as string | null,
    gpuWorkingBudgetEvidence: evidence as unknown,
    codecs: capabilities.codecs as string[] | null,
    colorPrecision: null,
  },
  capabilities: { codecs: capabilities.codecs, formats: capabilities.formats } as {
    codecs: string[];
    formats: string[];
  } | null,
  now: input().now,
});

describe('current approved render session', () => {
  it('preserves raw M while tightening persisted Q with current A', () => {
    const value = liveSessionInput();
    value.session.gpuMemoryBytes = '1073741824';
    expect(evaluateApprovedRenderSession(value)).toEqual(success('1073741824'));
    value.worker.gpuMemoryBytes = '536870912';
    expect(evaluateApprovedRenderSession(value)).toEqual(success('536870912'));
    value.worker.gpuMemoryBytes = '9223372036854775807';
    expect(evaluateApprovedRenderSession(value)).toEqual(success('1073741824'));
  });
  it.each([
    'legacy',
    'approval',
    'budget',
    'capabilities',
    'codecs',
    'binding',
    'engine',
    'revoked-worker',
    'revoked-session',
    'scope',
    'credential',
    'conformance',
    'measurement',
  ])('refuses %s', (mode) => {
    const value = liveSessionInput();
    switch (mode) {
      case 'legacy': {
        value.session.gpuWorkingBudgetEvidence = null;
        break;
      }
      case 'approval': {
        value.worker.gpuWorkingBudgetApproval = null;
        break;
      }
      case 'budget': {
        value.session.gpuMemoryBytes = null;
        break;
      }
      case 'capabilities': {
        value.capabilities = null;
        break;
      }
      case 'codecs': {
        value.session.codecs = ['av1'];
        break;
      }
      case 'binding': {
        value.session.workerId = '33333333-3333-4333-8333-333333333333';
        break;
      }
      case 'engine': {
        value.session.engineDigest = 'other-engine';
        break;
      }
      case 'revoked-worker': {
        value.worker.status = RenderWorkerStatus.Revoked;
        break;
      }
      case 'revoked-session': {
        value.session.revokedAt = value.now;
        break;
      }
      case 'scope': {
        value.worker.kinds = [];
        break;
      }
      case 'credential': {
        value.session.expiresAt = value.now;
        break;
      }
      case 'conformance': {
        value.worker.conformanceMaxAgeMs = 1;
        break;
      }
      case 'measurement': {
        value.now = new Date(evidence.validUntil);
        // No default
        break;
      }
    }
    expect(evaluateApprovedRenderSession(value).valid).toBe(false);
  });
});

describe('reviewed approval binding', () => {
  it('binds a reviewed pre-enrollment snapshot to the actual server worker ID', () => {
    expect(evaluateApprovedGpuWorkingBudget(input())).toEqual(success());
    expect(approval.evidence).not.toHaveProperty('workerId');
  });

  it.each([null, undefined, {}, { ...approval, evidence }])('refuses absent or malformed approval %j', (value) => {
    const valueInput = input();
    valueInput.worker.gpuWorkingBudgetApproval = value;
    valueInput.worker.gpuMemoryBytes = '9223372036854775807';
    expect(evaluateApprovedGpuWorkingBudget(valueInput)).toEqual({ valid: false, reason: 'profile-unapproved' });
  });

  it.each([
    { profileDigest: '0'.repeat(64) },
    { receiptDigest: '0'.repeat(64) },
    { measurementId: '33333333-3333-4333-8333-333333333333' },
    { workerId: '0195e2a0-0000-7000-8000-00000000aaa2' },
    { engineDigest: 'another-engine' },
    { buildDigest: '0'.repeat(64) },
    { browserIdentity: 'another-browser' },
    { deviceLifetimeId: '33333333-3333-4333-8333-333333333333' },
    { encoderEvidenceDigest: '0'.repeat(64) },
    { pressureEnvelopeDigest: '0'.repeat(64) },
    { outputReceiptDigest: '0'.repeat(64) },
    { completedAt: '2026-10-12T00:00:01.000Z' },
    { validUntil: '2026-10-12T00:00:59.000Z' },
    { topology: 'unified', topologyEvidenceDigest: '0'.repeat(64) },
  ])('refuses substitution of any otherwise valid approved binding %j', (change) => {
    expect(evaluateApprovedGpuWorkingBudget({ ...input(), evidence: { ...evidence, ...change } }).valid).toBe(false);
  });

  it('does not derive trusted engine/worker/concurrency policy from the receipt', () => {
    for (const change of [
      { id: '0195e2a0-0000-7000-8000-00000000aaa2' },
      { engineDigest: null },
      { engineDigest: 'other' },
      { maxConcurrentOperations: 2 },
    ]) {
      expect(evaluateApprovedGpuWorkingBudget({ ...input(), worker: { ...input().worker, ...change } }).valid).toBe(
        false,
      );
    }
  });

  it.each([
    null,
    {},
    { ...capabilities, codecs: ['hevc'] },
    { ...capabilities, formats: ['webm'] },
    { ...capabilities, colorPrecision: { maxBitDepth: 10, hdr10: true, dolbyVision: false } },
    { ...capabilities, extra: true },
  ])('refuses missing, changed or unknown capability content %j', (value) => {
    expect(evaluateApprovedGpuWorkingBudget({ ...input(), capabilities: value }).valid).toBe(false);
  });

  it('ignores object key ordering without treating changed arrays as the same proof', () => {
    const reverse = (value: object) => Object.fromEntries(Object.entries(value).toReversed());
    expect(
      evaluateApprovedGpuWorkingBudget({
        ...input(),
        evidence: reverse(evidence),
        capabilities: reverse(capabilities),
      }),
    ).toEqual(success());
    const approved = { ...approval, capabilities: { ...capabilities, codecs: ['h264', 'hevc'] } };
    expect(
      evaluateApprovedGpuWorkingBudget({
        ...input(),
        worker: { ...input().worker, gpuWorkingBudgetApproval: approved },
        capabilities: { ...capabilities, codecs: ['hevc', 'h264'] },
      }).valid,
    ).toBe(false);
  });

  it('preserves raw M and enforces current and admitted ceilings losslessly', () => {
    const lower = { ...input().worker, gpuMemoryBytes: '1073741824' };
    expect(evaluateApprovedGpuWorkingBudget({ ...input(), worker: lower })).toEqual(success('1073741824'));
    expect(evaluateApprovedGpuWorkingBudget({ ...input(), worker: { ...lower, gpuMemoryBytes: '0' } })).toEqual(
      success('0'),
    );
    expect(
      evaluateApprovedGpuWorkingBudget({
        ...input(),
        worker: { ...lower, gpuMemoryBytes: '9223372036854775807' },
        phase: { kind: 'session', admittedBudgetBytes: '1073741824' },
      }),
    ).toEqual(success('1073741824'));
    expect(
      evaluateApprovedGpuWorkingBudget({
        ...input(),
        worker: { ...lower, gpuMemoryBytes: '536870912' },
        phase: { kind: 'session', admittedBudgetBytes: '1073741824' },
      }),
    ).toEqual(success('536870912'));
    expect(
      evaluateApprovedGpuWorkingBudget({ ...input(), phase: { kind: 'session', admittedBudgetBytes: null } }).valid,
    ).toBe(false);
  });

  it('refuses legacy/null evidence or raw report even with an administrator amount', () => {
    const worker = { ...input().worker, gpuMemoryBytes: '8589934592' };
    for (const missing of [null, undefined, {}])
      expect(evaluateApprovedGpuWorkingBudget({ ...input(), worker, evidence: missing }).valid).toBe(false);
    expect(evaluateApprovedGpuWorkingBudget({ ...input(), worker, reportedBytes: null }).valid).toBe(false);
  });

  it('never renews approved timestamps at admission or when reading a session', () => {
    for (const phase of [
      { kind: 'admission' as const },
      { kind: 'session' as const, admittedBudgetBytes: '2147483648' },
    ]) {
      expect(evaluateApprovedGpuWorkingBudget({ ...input(), phase, now: new Date(evidence.validUntil) })).toEqual({
        valid: false,
        reason: 'expired',
      });
    }
  });
});

describe('canonical GPU budget wire contract', () => {
  const admission = {
    workerId,
    enrolmentSecret: 'x'.repeat(32),
    engineDigest: evidence.engineDigest,
    conformanceReportedAt: evidence.completedAt,
    softwareRenderer: false,
    gpuMemoryBytes: '2147483648',
  };
  const create = { name: 'Synthetic', destination: 'local', kinds: ['studio_export'] };

  it('round trips evidence and the administrator approval on the existing DTOs', () => {
    expect(
      RenderWorkerCreateDto.schema.parse({ ...create, gpuWorkingBudgetApproval: approval }).gpuWorkingBudgetApproval,
    ).toEqual(approval);
    expect(RenderWorkerUpdateDto.schema.parse({ gpuWorkingBudgetApproval: approval }).gpuWorkingBudgetApproval).toEqual(
      approval,
    );
    expect(
      RenderWorkerAdmissionDto.schema.parse({ ...admission, gpuWorkingBudgetEvidence: evidence })
        .gpuWorkingBudgetEvidence,
    ).toEqual(evidence);
    const session = {
      workerId,
      sessionToken: 'credential',
      expiresAt: evidence.validUntil,
      scopes: ['studio_export'],
      leaseMs: 1000,
      heartbeatIntervalMs: 500,
      gpuMemoryBytes: '1073741824',
      gpuWorkingBudgetEvidence: evidence,
    };
    expect(RenderWorkerSessionDto.schema.parse(session)).toEqual(session);
  });

  it('keeps legacy/absent companions representable without approval', () => {
    expect(RenderWorkerAdmissionDto.schema.parse(admission)).not.toHaveProperty('gpuWorkingBudgetEvidence');
    expect(
      RenderWorkerAdmissionDto.schema.parse({ ...admission, gpuWorkingBudgetEvidence: null }).gpuWorkingBudgetEvidence,
    ).toBeNull();
    expect(RenderWorkerUpdateDto.schema.parse({ gpuWorkingBudgetApproval: null }).gpuWorkingBudgetApproval).toBeNull();
  });

  it.each(['-1', '+1', '1.1', '1e9', ' 1', '1 ', '01', '9223372036854775808'])(
    'refuses malformed/overflowed memory quantities %s',
    (gpuMemoryBytes) => {
      expect(RenderWorkerAdmissionDto.schema.safeParse({ ...admission, gpuMemoryBytes }).success).toBe(false);
      expect(RenderWorkerCreateDto.schema.safeParse({ ...create, gpuMemoryBytes }).success).toBe(false);
      expect(RenderWorkerUpdateDto.schema.safeParse({ gpuMemoryBytes }).success).toBe(false);
    },
  );

  it('preserves decimal strings and null without numeric coercion', () => {
    for (const gpuMemoryBytes of [null, '0', '2147483648', '9007199254740993', '9223372036854775807']) {
      expect(RenderWorkerAdmissionDto.schema.parse({ ...admission, gpuMemoryBytes }).gpuMemoryBytes).toBe(
        gpuMemoryBytes,
      );
    }
  });

  it.each([
    { extra: true },
    { measuredBytes: '2147483649' },
    { headroomBytes: '0' },
    { validUntil: '2026-10-12T00:01:00.001Z' },
    { completedAt: '2026-02-30T00:00:00.000Z' },
    { topologyEvidenceDigest: 'a'.repeat(64) },
    { hardwareBackend: 'software' },
    { status: 'failed' },
  ])('rejects malformed compact evidence at the wire boundary %j', (change) => {
    expect(GpuWorkingBudgetEvidenceSchema.safeParse({ ...evidence, ...change }).success).toBe(false);
    expect(
      RenderWorkerAdmissionDto.schema.safeParse({ ...admission, gpuWorkingBudgetEvidence: { ...evidence, ...change } })
        .success,
    ).toBe(false);
  });

  it('does not permit a client-selected canonical worker ID inside approval', () => {
    expect(GpuWorkingBudgetApprovalSchema.safeParse({ ...approval, evidence }).success).toBe(false);
  });

  it.each(['\n', '\r', '\r\n'])('rejects trailing line terminators in quantities, digests and UUIDs %j', (suffix) => {
    expect(RenderWorkerAdmissionDto.schema.safeParse({ ...admission, gpuMemoryBytes: `1${suffix}` }).success).toBe(
      false,
    );
    for (const key of [
      'profileDigest',
      'receiptDigest',
      'buildDigest',
      'encoderEvidenceDigest',
      'pressureEnvelopeDigest',
      'outputReceiptDigest',
      'measurementId',
      'workerId',
      'deviceLifetimeId',
    ] as const) {
      const changed = { ...evidence, [key]: evidence[key] + suffix };
      expect(GpuWorkingBudgetEvidenceSchema.safeParse(changed).success).toBe(false);
      expect(evaluateApprovedGpuWorkingBudget({ ...input(), evidence: changed }).valid).toBe(false);
    }
  });
});
