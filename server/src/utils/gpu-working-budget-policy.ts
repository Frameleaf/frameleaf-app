import z from 'zod';
import { MediaOperationKind, RenderWorkerStatus } from 'src/enum.js';
import { RenderColorPrecision, isQualifiedRenderSession } from 'src/utils/render-admission.js';
import {
  GpuWorkingBudgetContext,
  GpuWorkingBudgetDecision,
  evaluateGpuWorkingBudget,
} from 'src/utils/gpu-working-budget.js';

const DECIMAL = /^(0|[1-9][0-9]{0,18})$/;
export const GpuMemoryBytesSchema = z
  .string()
  .regex(DECIMAL)
  .refine((value) => DECIMAL.test(value) && BigInt(value) <= 9223372036854775807n);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const identity = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  });

const EvidenceShape = z.strictObject({
  metric: z.literal('measured-usable-gpu-working-budget-v1'),
  profileDigest: digest,
  measurementId: uuid,
  receiptDigest: digest,
  workerId: uuid,
  engineDigest: identity,
  buildDigest: digest,
  browserIdentity: identity,
  deviceLifetimeId: uuid,
  bindingMethod: z.literal('same-export-device'),
  topology: z.enum(['unified', 'dedicated', 'unknown']),
  topologyEvidenceDigest: digest.nullable(),
  hardwareBackend: z.literal('hardware'),
  encoderEvidenceDigest: digest,
  pressureEnvelopeDigest: digest,
  outputReceiptDigest: digest,
  measuredBytes: z.literal('2147483648'),
  headroomBytes: z.literal('536870912'),
  completedAt: timestamp,
  validUntil: timestamp,
  status: z.literal('passed'),
});

const consistentEvidence = (value: z.infer<typeof EvidenceShape> | Omit<z.infer<typeof EvidenceShape>, 'workerId'>) =>
  (value.topology === 'unknown') === (value.topologyEvidenceDigest === null) &&
  Date.parse(value.validUntil) > Date.parse(value.completedAt) &&
  Date.parse(value.validUntil) - Date.parse(value.completedAt) <= 60_000;

export const GpuWorkingBudgetEvidenceSchema = EvidenceShape.refine(consistentEvidence);
const CapabilitiesSchema = z.strictObject({
  codecs: z.array(z.string().min(1).max(60)).max(64),
  formats: z.array(z.string().min(1).max(30)).max(32),
  colorPrecision: z
    .strictObject({ maxBitDepth: z.int().min(8).max(16), hdr10: z.boolean(), dolbyVision: z.boolean() })
    .nullable(),
});
export const GpuWorkingBudgetApprovalSchema = z.strictObject({
  evidence: EvidenceShape.omit({ workerId: true }).refine(consistentEvidence),
  capabilities: CapabilitiesSchema,
});
export type GpuWorkingBudgetApproval = z.infer<typeof GpuWorkingBudgetApprovalSchema>;

type ApprovedBudgetInput = Pick<
  GpuWorkingBudgetContext,
  'reportedBytes' | 'phase' | 'now' | 'conformanceExpiresAt' | 'credentialExpiresAt'
> & {
  worker: {
    id: string;
    engineDigest: string | null;
    gpuMemoryBytes: string | null;
    maxConcurrentOperations: number;
    gpuWorkingBudgetApproval: unknown;
  };
  evidence: unknown;
  capabilities: unknown;
};

/** Approval is trusted administrator policy; receipt shape and hashes alone cannot attest a GPU. */
export const evaluateApprovedGpuWorkingBudget = (input: ApprovedBudgetInput): GpuWorkingBudgetDecision => {
  const approval = GpuWorkingBudgetApprovalSchema.safeParse(input.worker.gpuWorkingBudgetApproval);
  if (!approval.success) return { valid: false, reason: 'profile-unapproved' };
  const evidence = GpuWorkingBudgetEvidenceSchema.safeParse(input.evidence);
  const capabilities = CapabilitiesSchema.safeParse(input.capabilities);
  if (!evidence.success || !capabilities.success) return { valid: false, reason: 'evidence-invalid' };
  const { workerId, ...snapshot } = evidence.data;
  // Parsing fixes object key order; array order and every bound value must still match exactly.
  if (
    workerId !== input.worker.id ||
    input.worker.engineDigest !== approval.data.evidence.engineDigest ||
    JSON.stringify(snapshot) !== JSON.stringify(approval.data.evidence) ||
    JSON.stringify(capabilities.data) !== JSON.stringify(approval.data.capabilities)
  ) {
    return { valid: false, reason: 'identity-mismatch' };
  }
  if (input.worker.maxConcurrentOperations !== 1) return { valid: false, reason: 'session-unqualified' };
  return evaluateGpuWorkingBudget(evidence.data, {
    workerId: input.worker.id,
    engineDigest: approval.data.evidence.engineDigest,
    buildDigest: approval.data.evidence.buildDigest,
    browserIdentity: approval.data.evidence.browserIdentity,
    deviceLifetimeId: approval.data.evidence.deviceLifetimeId,
    approvedProfileDigest: approval.data.evidence.profileDigest,
    reportedBytes: input.reportedBytes,
    administratorCeiling: input.worker.gpuMemoryBytes,
    phase: input.phase,
    now: input.now,
    conformanceExpiresAt: input.conformanceExpiresAt,
    credentialExpiresAt: input.credentialExpiresAt,
  });
};

/** A live credential alone is not fresh GPU evidence for another render start. */
export const evaluateApprovedRenderSession = (input: {
  worker: ApprovedBudgetInput['worker'] & {
    status: RenderWorkerStatus;
    kinds: readonly MediaOperationKind[];
    conformanceMaxAgeMs: number;
  };
  session: {
    workerId: string;
    revokedAt: Date | null;
    expiresAt: Date;
    engineDigest: string | null;
    conformanceReportedAt: Date;
    scopes: readonly MediaOperationKind[];
    gpuMemoryBytes: string | null;
    gpuWorkingBudgetEvidence: unknown;
    codecs: readonly string[] | null;
    colorPrecision: RenderColorPrecision | null;
  };
  capabilities: { codecs: readonly string[]; formats: readonly string[] } | null | undefined;
  now: Date;
}): GpuWorkingBudgetDecision => {
  const { worker, session, capabilities, now } = input;
  if (
    session.workerId !== worker.id ||
    session.engineDigest !== worker.engineDigest ||
    !capabilities ||
    JSON.stringify(session.codecs) !== JSON.stringify(capabilities.codecs) ||
    !isQualifiedRenderSession({
      worker: { ...worker, revoked: worker.status !== RenderWorkerStatus.Active },
      session: {
        ...session,
        revoked: session.revokedAt !== null,
        scopes: session.scopes.filter((kind) => worker.kinds.includes(kind)),
      },
      now,
    })
  )
    return { valid: false, reason: 'session-unqualified' };
  const evidence = GpuWorkingBudgetEvidenceSchema.safeParse(session.gpuWorkingBudgetEvidence);
  if (!evidence.success) return { valid: false, reason: 'evidence-invalid' };
  return evaluateApprovedGpuWorkingBudget({
    worker,
    evidence: evidence.data,
    capabilities: { ...capabilities, colorPrecision: session.colorPrecision },
    reportedBytes: evidence.data.measuredBytes,
    phase: { kind: 'session', admittedBudgetBytes: session.gpuMemoryBytes },
    now,
    conformanceExpiresAt: new Date(session.conformanceReportedAt.getTime() + worker.conformanceMaxAgeMs),
    credentialExpiresAt: session.expiresAt,
  });
};
