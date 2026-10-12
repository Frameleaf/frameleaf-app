export type QueuePauseSnapshot = { name: string; paused: boolean }[];

/** Restoration is inside the reset's ownership and follows mutation, including a failed mutation. */
export const resetWhilePaused = async (driver: {
  pause: () => Promise<QueuePauseSnapshot>;
  drain: () => Promise<void>;
  mutate: () => Promise<void>;
  restore: (snapshot: QueuePauseSnapshot) => Promise<void>;
}) => {
  const snapshot = await driver.pause();
  let primary: unknown;
  let failed = false;
  try {
    await driver.drain();
    await driver.mutate();
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await driver.restore(snapshot);
  } catch (error) {
    if (failed) {
      throw new AggregateError([primary, error], 'Reset failed and queue state could not be restored', {
        cause: error,
      });
    }
    throw error;
  }
  if (failed) {
    throw primary;
  }
};

/**
 * Bounds for the fixture reset transaction. Its TRUNCATE needs ACCESS EXCLUSIVE on every cascaded table,
 * and an autovacuum worker on any of them holds a conflicting lock. Postgres cancels that worker only once
 * the waiter's deadlock_timeout (default 1 s) expires, so with a 1 s statement timeout the reset failed
 * before the worker was ever asked to yield. Check well inside the budget instead.
 */
export const resetLockSettings = (timeoutMs: number) => ({
  text: `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true), set_config('deadlock_timeout', $2, true)`,
  values: [`${timeoutMs}ms`, `${Math.max(1, Math.min(100, Math.floor(timeoutMs / 4)))}ms`],
});
