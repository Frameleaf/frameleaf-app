import { randomUUID } from 'node:crypto';
import { AuthenticatedRenderWorker } from 'src/repositories/render-worker.repository.js';

/** Synthetic approved contract evidence, never native-device qualification. */
export const withSyntheticGpuBudget = (
  entry: AuthenticatedRenderWorker,
  capabilities: { codecs: string[]; formats: string[] },
): AuthenticatedRenderWorker => {
  const completedAt = new Date(Date.now() - 1000);
  const evidence = {
    metric: 'measured-usable-gpu-working-budget-v1' as const,
    profileDigest: 'a'.repeat(64),
    measurementId: randomUUID(),
    receiptDigest: 'b'.repeat(64),
    engineDigest: entry.worker.engineDigest ?? 'unapproved-engine',
    buildDigest: 'c'.repeat(64),
    browserIdentity: 'synthetic-test-browser',
    deviceLifetimeId: randomUUID(),
    bindingMethod: 'same-export-device' as const,
    topology: 'unknown' as const,
    topologyEvidenceDigest: null,
    hardwareBackend: 'hardware' as const,
    encoderEvidenceDigest: 'd'.repeat(64),
    pressureEnvelopeDigest: 'e'.repeat(64),
    outputReceiptDigest: 'f'.repeat(64),
    measuredBytes: '2147483648' as const,
    headroomBytes: '536870912' as const,
    completedAt: completedAt.toISOString(),
    validUntil: new Date(completedAt.getTime() + 60_000).toISOString(),
    status: 'passed' as const,
  };
  return {
    worker: {
      ...entry.worker,
      gpuWorkingBudgetApproval: {
        evidence,
        capabilities: { ...capabilities, colorPrecision: entry.session.colorPrecision },
      },
    },
    session: { ...entry.session, gpuWorkingBudgetEvidence: { ...evidence, workerId: entry.worker.id } },
  };
};
