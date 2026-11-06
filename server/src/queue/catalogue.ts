import { setTimeout as sleep } from 'node:timers/promises';

/** A lost lock wait (`lock_timeout`) or a deadlock: nothing committed, the whole transaction can run again. */
export const isLockContention = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && (error.code === '55P03' || error.code === '40P01');

const CONTENTION_ATTEMPTS = 4;

/**
 * FL-1265: completions no longer queue behind one global lock; two of them that touch the same rows in a different
 * order can deadlock instead. PostgreSQL rolls one back, so it runs again after a short jittered wait. `reset` undoes
 * in-memory effects of the rolled-back attempt before the next one.
 */
export async function retryLockContention<T>(
  signal: AbortSignal | undefined,
  action: () => Promise<T>,
  reset: () => void = () => {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= CONTENTION_ATTEMPTS || !isLockContention(error)) throw error;
      signal?.throwIfAborted();
      reset();
      await sleep(50 * 2 ** attempt * (0.5 + Math.random()), undefined, signal ? { signal } : undefined);
    }
  }
}
