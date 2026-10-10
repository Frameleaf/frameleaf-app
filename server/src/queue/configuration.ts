/** Deadlines are process-wide so the executor and independent coordinator agree. */
export const readQueueDeadlineProfiles = (env: NodeJS.ProcessEnv = process.env) => {
  const finiteMilliseconds = (name: string, fallback: number, maximum = 86_400_000): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value < 1000 || value > maximum) {
      // Name the setting, never log arbitrary environment contents.
      throw new Error(`${name} must be an integer number of milliseconds between 1000 and ${maximum}`);
    }
    return value;
  };
  return Object.freeze({
    opaqueDeadline: finiteMilliseconds('FRAMELEAF_JOB_DEADLINE_MS', 600_000),
    mlDeadline: finiteMilliseconds('FRAMELEAF_ML_DEADLINE_MS', 1_800_000),
    noProgressDeadline: finiteMilliseconds('FRAMELEAF_JOB_IDLE_DEADLINE_MS', 600_000),
    // Keep cancellation below the fixed lease so fencing precedes possible recovery.
    cancelGrace: finiteMilliseconds('FRAMELEAF_JOB_CANCEL_GRACE_MS', 10_000, 30_000),
  });
};
