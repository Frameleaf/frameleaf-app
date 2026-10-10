import type { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import {
  type OperationExecution,
  executionSignal,
  operationExecution,
  settleOperationExecution,
} from 'src/utils/execution-signal.js';

export class OperationDeadlineError extends Error {
  constructor() {
    super('Operation stopped making progress');
  }
}
export class OperationClaimLostError extends Error {
  constructor() {
    super('Operation claim was lost, cancelled, paused, or expired');
  }
}

/**
 * Own only the execution lifetime. The caller retains its existing durable failure/retry policy.
 * Never race the callback with a timeout: it must unwind streams, children and transactions before
 * it can settle its claim. Progress means completed bytes/items, not successful lease renewal.
 */
export async function withOperationExecution<T>(
  options: {
    renew: () => Promise<boolean>;
    stopped?: () => boolean;
    pollMs?: number;
    deadlineMs?: number;
    idleMs?: number;
  },
  callback: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let deadline: ReturnType<typeof setTimeout>;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  const abort = (error: Error) => controller.abort(error);
  const arm = (ms: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => abort(new OperationDeadlineError()), ms);
    deadline.unref();
  };
  const state: OperationExecution = {
    signal: controller.signal,
    settled: false,
    completed: new Map(),
    progress: () => {
      if (controller.signal.aborted || state.settled) return;
      arm(options.idleMs ?? QUEUE_TIMING.noProgressDeadline);
    },
    settle: async () => {
      controller.abort(new Error('Operation execution settled'));
      state.settled = true;
      clearTimeout(deadline);
      clearTimeout(poll);
      await renewal;
    },
  };
  const check = async () => {
    try {
      if (
        options.stopped?.() ||
        !(await operationExecution.run(
          { ...state, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.pollMs ?? 5000)]) },
          options.renew,
        ))
      )
        abort(new OperationClaimLostError());
    } catch {
      abort(new OperationClaimLostError());
    } finally {
      if (!state.settled && !controller.signal.aborted) schedule();
    }
  };
  const schedule = () => {
    poll = setTimeout(() => {
      renewal = check();
    }, options.pollMs ?? 5000);
    poll.unref();
  };
  return operationExecution.run(state, async () => {
    arm(options.deadlineMs ?? QUEUE_TIMING.opaqueDeadline);
    schedule();
    try {
      const result = await callback();
      if (!state.settled) controller.signal.throwIfAborted();
      return result;
    } finally {
      // No renewal may race a subsequent retry after this execution returns.
      await state.settle();
    }
  });
}

/** Claim loss is not a handler failure. Cancellation/pause are acknowledged only after work unwinds. */
export async function settleOperationStop(
  repository: MediaOperationRepository,
  operation: MediaOperation,
  token: string,
) {
  const stopped = executionSignal()?.reason instanceof OperationClaimLostError;
  await settleOperationExecution();
  if (!stopped) return false;
  const current = await repository.getOfKind(operation.id, operation.kind);
  if (!current || current.claimToken !== token) return true;
  if (current.cancelRequestedAt) {
    await repository.acknowledgeCancel(operation.id, token, { released: false });
    return true;
  }
  if (current.pauseRequestedAt) {
    await repository.settlePause(operation.id, token);
    return true;
  }
  return false;
}
