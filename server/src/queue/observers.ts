import { setTimeout as sleep } from 'node:timers/promises';

/** Best-effort observers never own an item outcome. A timed-out promise still consumes its allowance. */
export function createObserverDelivery({ maxInFlight = 16, budgetMs = 5000, warningIntervalMs = 30_000 } = {}) {
  let inFlight = 0;
  let lastWarning = -Infinity;
  return async (observers: Array<() => Promise<void>>, warn: () => void) => {
    const deadline = performance.now() + budgetMs;
    const unavailable = () => {
      if (!(performance.now() - lastWarning >= warningIntervalMs)) return;
      lastWarning = performance.now();
      warn();
    };
    for (const observe of observers) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || inFlight >= maxInFlight) {
        unavailable();
        return;
      }
      inFlight++;
      const timer = new AbortController();
      const delivery = Promise.try(observe)
        .then(() => true)
        .catch(() => {
          unavailable();
          return true;
        })
        .finally(() => {
          inFlight--;
        });
      const settled = await Promise.race([
        delivery,
        sleep(remaining, false, { signal: timer.signal }).catch(() => true),
      ]);
      timer.abort();
      if (!settled) {
        unavailable();
        return;
      }
    }
  };
}

export const deliverJobObservers = createObserverDelivery();
