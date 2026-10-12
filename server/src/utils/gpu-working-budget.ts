export type GpuWorkingBudgetEvidence = {
  metric: 'measured-usable-gpu-working-budget-v1';
  profileDigest: string;
  measurementId: string;
  receiptDigest: string;
  workerId: string;
  engineDigest: string;
  buildDigest: string;
  browserIdentity: string;
  deviceLifetimeId: string;
  bindingMethod: 'same-export-device';
  topology: 'unified' | 'dedicated' | 'unknown';
  topologyEvidenceDigest: string | null;
  hardwareBackend: 'hardware';
  encoderEvidenceDigest: string;
  pressureEnvelopeDigest: string;
  outputReceiptDigest: string;
  measuredBytes: string;
  headroomBytes: string;
  completedAt: string;
  validUntil: string;
  status: 'passed';
};

export type GpuWorkingBudgetContext = {
  workerId: string;
  engineDigest: string;
  buildDigest: string;
  browserIdentity: string;
  deviceLifetimeId: string;
  approvedProfileDigest: string | null;
  reportedBytes: string | null;
  administratorCeiling: string | null;
  phase: { kind: 'admission' } | { kind: 'session'; admittedBudgetBytes: string | null };
  now: Date;
  conformanceExpiresAt: Date;
  credentialExpiresAt: Date;
};

export type GpuWorkingBudgetDecision =
  | { valid: true; measuredBytes: string; qualifiedBytes: string; expiresAt: string }
  | {
      valid: false;
      reason:
        | 'evidence-invalid'
        | 'identity-mismatch'
        | 'profile-unapproved'
        | 'expired'
        | 'ceiling-invalid'
        | 'session-unqualified';
    };

const EVIDENCE_FIELDS = [
  'metric',
  'profileDigest',
  'measurementId',
  'receiptDigest',
  'workerId',
  'engineDigest',
  'buildDigest',
  'browserIdentity',
  'deviceLifetimeId',
  'bindingMethod',
  'topology',
  'topologyEvidenceDigest',
  'hardwareBackend',
  'encoderEvidenceDigest',
  'pressureEnvelopeDigest',
  'outputReceiptDigest',
  'measuredBytes',
  'headroomBytes',
  'completedAt',
  'validUntil',
  'status',
] as const;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;

/**
 * Validate compact receipt data and compute M/A/Q; this does not attest hardware or reserve memory.
 * Approval and expected identities come from the owner, never from the receipt being validated.
 * Replay, live device health and exclusive lifetime custody still require the session/producer owners.
 * A valid Q below an operation's requirement must still refuse that operation.
 */
export const evaluateGpuWorkingBudget = (
  evidence: unknown,
  context: GpuWorkingBudgetContext,
): GpuWorkingBudgetDecision => {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  const value = evidence as Record<string, unknown>;
  if (
    Object.keys(value).length !== EVIDENCE_FIELDS.length ||
    EVIDENCE_FIELDS.some((key) => !Object.hasOwn(value, key))
  ) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  if (
    value.metric !== 'measured-usable-gpu-working-budget-v1' ||
    value.bindingMethod !== 'same-export-device' ||
    value.hardwareBackend !== 'hardware' ||
    value.status !== 'passed'
  ) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  for (const key of [
    'profileDigest',
    'receiptDigest',
    'buildDigest',
    'encoderEvidenceDigest',
    'pressureEnvelopeDigest',
    'outputReceiptDigest',
  ] as const) {
    if (typeof value[key] !== 'string' || !DIGEST.test(value[key])) {
      return { valid: false, reason: 'evidence-invalid' };
    }
  }
  for (const key of ['measurementId', 'workerId', 'deviceLifetimeId'] as const) {
    if (typeof value[key] !== 'string' || !UUID.test(value[key])) {
      return { valid: false, reason: 'evidence-invalid' };
    }
  }
  for (const key of ['engineDigest', 'browserIdentity'] as const) {
    if (
      typeof value[key] !== 'string' ||
      value[key].length === 0 ||
      value[key].length > 200 ||
      value[key].trim() !== value[key]
    ) {
      return { valid: false, reason: 'evidence-invalid' };
    }
  }
  if (value.topology === 'unknown') {
    if (value.topologyEvidenceDigest !== null) return { valid: false, reason: 'evidence-invalid' };
  } else if (
    !['unified', 'dedicated'].includes(value.topology as string) ||
    typeof value.topologyEvidenceDigest !== 'string' ||
    !DIGEST.test(value.topologyEvidenceDigest)
  ) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  if (!context.approvedProfileDigest || value.profileDigest !== context.approvedProfileDigest) {
    return { valid: false, reason: 'profile-unapproved' };
  }
  for (const key of ['workerId', 'engineDigest', 'buildDigest', 'browserIdentity', 'deviceLifetimeId'] as const) {
    if (value[key] !== context[key]) return { valid: false, reason: 'identity-mismatch' };
  }
  if (!context.phase || !['admission', 'session'].includes(context.phase.kind)) {
    return { valid: false, reason: 'session-unqualified' };
  }
  const quantities = [value.measuredBytes, value.headroomBytes, context.reportedBytes];
  for (const quantity of quantities) {
    if (typeof quantity !== 'string' || !DECIMAL.test(quantity) || BigInt(quantity) > 9223372036854775807n) {
      return { valid: false, reason: 'evidence-invalid' };
    }
  }
  if (
    value.measuredBytes !== '2147483648' ||
    value.headroomBytes !== '536870912' ||
    context.reportedBytes !== value.measuredBytes
  ) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  let qualified = 2147483648n;
  if (context.administratorCeiling !== null) {
    const ceiling = context.administratorCeiling;
    if (typeof ceiling !== 'string' || !DECIMAL.test(ceiling) || BigInt(ceiling) > 9223372036854775807n) {
      return { valid: false, reason: 'ceiling-invalid' };
    }
    if (BigInt(ceiling) < qualified) qualified = BigInt(ceiling);
  }
  if (context.phase.kind === 'session') {
    const admitted = context.phase.admittedBudgetBytes;
    if (typeof admitted !== 'string' || !DECIMAL.test(admitted) || BigInt(admitted) > 2147483648n) {
      return { valid: false, reason: 'session-unqualified' };
    }
    if (BigInt(admitted) < qualified) qualified = BigInt(admitted);
  }
  const times: number[] = [];
  for (const key of ['completedAt', 'validUntil'] as const) {
    const timestamp = value[key];
    if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
      return { valid: false, reason: 'evidence-invalid' };
    }
    const parsed = new Date(timestamp);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
      return { valid: false, reason: 'evidence-invalid' };
    }
    times.push(parsed.getTime());
  }
  const [completedAt, validUntil] = times;
  if (validUntil <= completedAt || validUntil - completedAt > 60_000) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  for (const timestamp of [context.now, context.conformanceExpiresAt, context.credentialExpiresAt]) {
    if (!(timestamp instanceof Date) || !Number.isFinite(timestamp.getTime())) {
      return { valid: false, reason: 'expired' };
    }
  }
  const now = context.now.getTime();
  const expiresAt = Math.min(validUntil, context.conformanceExpiresAt.getTime(), context.credentialExpiresAt.getTime());
  if (completedAt > now || now >= expiresAt) return { valid: false, reason: 'expired' };
  return {
    valid: true,
    measuredBytes: '2147483648',
    qualifiedBytes: qualified.toString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
};
