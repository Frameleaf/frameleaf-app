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

/**
 * A transient outage of a dependency (the worker dropped the connection) waits like a refusal, but
 * only for a job's first `maxAttempts` claims (claim attempts count from 1): a request that keeps
 * breaking its worker still ends as an ordinary failure. Only audited repeatable work waits this way.
 */
export function deferJobOnTransientFailure(reason: JobDependencyReason, maxAttempts: number) {
  const context = queueExecution.getStore();
  if (!context?.claim.safeToRetry || context.claim.attempt > maxAttempts) return;
  // A refusal already recorded in this execution (e.g. destination capacity) keeps its own reason.
  deferJobUntilDependency(context.dependencyReason ?? reason);
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
