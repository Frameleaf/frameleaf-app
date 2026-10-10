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
