type MaintenanceCleanup = {
  config: (timeoutMs: number) => Promise<{ maintenanceMode: boolean }>;
  status: (timeoutMs: number) => Promise<{ action: string; error?: unknown }>;
  end: (timeoutMs: number) => Promise<unknown>;
};

/** Await every request, including failure, before releasing the teardown owner. */
export async function settleMaintenanceCleanup(
  requests: MaintenanceCleanup,
  {
    timeoutMs = 50_000,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  let lastError: unknown;
  const requestBudget = () => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error('Restore cleanup deadline exceeded', { cause: lastError });
    }
    return Math.min(5000, remaining);
  };
  while (true) {
    const budget = requestBudget();
    try {
      const config = await requests.config(budget);
      // Check the budget after responses too: a late response must not start another request.
      requestBudget();
      if (!config.maintenanceMode) {
        return;
      }
      const state = await requests.status(requestBudget());
      requestBudget();
      // Never interrupt a healthy restore. Explicit failure or selection state permits End.
      if (state.action !== 'restore_database' || state.error) {
        await requests.end(requestBudget());
      }
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error('Restore cleanup deadline exceeded', { cause: lastError });
    }
    await sleep(Math.min(500, remaining));
  }
}
