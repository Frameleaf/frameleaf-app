import { withDeadline, type WaitContext } from './harness-wait';

// Resolve the runner during module collection, never after a test has timed out and
// another test has become current. Playwright does not load Vitest's worker runtime.
const runner = process.env.VITEST ? await import('vitest/suite') : undefined;
const scopes = new WeakMap<AbortSignal, { controller: AbortController; pending: Set<Promise<unknown>> }>();
const callerWaits = new WeakMap<AbortSignal, Set<Promise<unknown>>>();

/** The caller aborts its signal first, then awaits the transport settlement in its teardown. */
export const settlePendingWaits = async (signal: AbortSignal) => {
  await Promise.allSettled(callerWaits.get(signal) ?? []);
};

/** Vitest aborts this signal at the actual test deadline, which can be shorter than
 * the helper's CI budget. Await aborted requests before the runner starts another test.
 * Playwright callers may pass their own cancellation signal and retain the local deadline.
 */
export const ownedWait = async <T>(
  description: string,
  timeout: number,
  operation: (context: WaitContext) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  const task = runner?.getCurrentTest();
  const context = task?.context;
  let scope = context && scopes.get(context.signal);
  if (context && !scope) {
    scope = { controller: new AbortController(), pending: new Set() };
    scopes.set(context.signal, scope);
    const current = scope;
    const cancel = () => current.controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', cancel, { once: true });
    if (context.signal.aborted) {
      cancel();
    }
    context.onTestFinished(async () => {
      current.controller.abort(new Error('Test finished before its E2E wait settled'));
      await Promise.allSettled(current.pending);
      context.signal.removeEventListener('abort', cancel);
      scopes.delete(context.signal);
    });
  }
  const signals = [scope?.controller.signal, signal].filter((value): value is AbortSignal => !!value);
  const pending = withDeadline(
    description,
    timeout,
    operation,
    signals.length > 0 ? AbortSignal.any(signals) : undefined,
  );
  scope?.pending.add(pending);
  const owner = signal ?? context?.signal;
  let caller = owner && callerWaits.get(owner);
  if (owner && !caller) {
    caller = new Set();
    callerWaits.set(owner, caller);
  }
  caller?.add(pending);
  try {
    return await pending;
  } finally {
    scope?.pending.delete(pending);
    caller?.delete(pending);
  }
};
