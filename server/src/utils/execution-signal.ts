import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';

export type OperationExecution = {
  signal: AbortSignal;
  progress: (units: number) => void;
  settle: () => Promise<void>;
  settled: boolean;
  completed: Map<string, number>;
};
export const operationExecution = new AsyncLocalStorage<OperationExecution>();

/** An operation never invents a queue claim or a second queue retry owner. */
export const executionSignal = () => {
  const operation = operationExecution.getStore();
  return operation && !operation.settled ? operation.signal : jobSignal();
};
export const assertExecutionActive = () => executionSignal()?.throwIfAborted();
export const advanceExecutionProgress = (units: number) => {
  if (!Number.isSafeInteger(units) || units <= 0) return;
  const operation = operationExecution.getStore();
  if (operation && !operation.settled) operation.progress(units);
  else advanceJobProgress(units);
};
export const executionDelay = (milliseconds: number) => delay(milliseconds, undefined, { signal: executionSignal() });
export const executionTimeout = (milliseconds: number) => {
  const signal = executionSignal();
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

/** Call only after awaited work has stopped, before recording failure/cancellation in the database. */
export const settleOperationExecution = async () => {
  await operationExecution.getStore()?.settle();
};

export const reportExecutionProgress = (key: string, completed: number) => {
  const state = operationExecution.getStore();
  if (!state || !Number.isSafeInteger(completed) || completed < 0) return;
  const before = state.completed.get(key) ?? 0;
  if (completed > before) {
    state.completed.set(key, completed);
    advanceExecutionProgress(completed - before);
  }
};

/** Mandatory resource cleanup has a separate bounded lifetime, never a retry or publication claim. */
export const withExecutionCleanup = <T>(callback: () => Promise<T>, timeoutMs = 5000): Promise<T> =>
  operationExecution.run(
    {
      signal: AbortSignal.timeout(timeoutMs),
      settled: false,
      completed: new Map(),
      progress: () => {},
      settle: async () => {},
    },
    callback,
  );
