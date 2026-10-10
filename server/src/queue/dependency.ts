import type { JobDependencyReason } from 'src/queue/types.js';
import { MlAdmissionRefusal } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';

export class JobDependencyUnavailable extends Error {
  constructor(readonly reason: JobDependencyReason) {
    super(`Job dependency is unavailable (${reason})`);
  }
}

/** Explicit pre-work check. Direct API callers retain their existing skipped/refused response. */
export function deferJobUntilDependency(reason: JobDependencyReason) {
  const context = queueExecution.getStore();
  if (!context || context.claim.data.operationId) return;
  context.signal.throwIfAborted();
  context.dependencyReason = reason;
  throw new JobDependencyUnavailable(reason);
}

/** Admission errors can be caught by services; retain the deferred outcome in their execution scope. */
export function noteAdmissionDependency(refusal: MlAdmissionRefusal) {
  const context = queueExecution.getStore();
  if (!context?.claim.safeToRetry || context.claim.data.operationId || refusal === MlAdmissionRefusal.RequestInvalid)
    return;
  const reason: JobDependencyReason = [
    MlAdmissionRefusal.ConsentMissing,
    MlAdmissionRefusal.ConsentVersionOutdated,
    MlAdmissionRefusal.DisclosurePending,
  ].includes(refusal)
    ? 'destination-consent'
    : [
          MlAdmissionRefusal.BudgetExceeded,
          MlAdmissionRefusal.WalletInsufficient,
          MlAdmissionRefusal.QuotaExceeded,
        ].includes(refusal)
      ? 'destination-budget'
      : [
            MlAdmissionRefusal.DestinationUnhealthy,
            MlAdmissionRefusal.CloudUnavailable,
            MlAdmissionRefusal.InsufficientMemory,
          ].includes(refusal)
        ? 'destination-unavailable'
        : 'destination-configuration';
  context.dependencyReason ??= reason;
}
