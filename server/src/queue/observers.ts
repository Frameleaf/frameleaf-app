import { setTimeout as sleep } from 'node:timers/promises';
import { QueueAdmission } from 'src/queue/admission.js';

/** Reserve before execution; committed callbacks keep their allowance until the entire chain drains. */
export function createObserverDelivery({ maxInFlight = 16, budgetMs = 5000, warningIntervalMs = 30_000 } = {}) {
  const admission = new QueueAdmission(maxInFlight);
  let lastWarning = -Infinity;
  const deliver = async (observers: Array<() => Promise<void>>, warn: () => void, onDrained: () => void) => {
    const unavailable = () => {
      if (!(performance.now() - lastWarning >= warningIntervalMs)) return;
      lastWarning = performance.now();
      try {
        warn();
      } catch {
        // Diagnostics must not suppress committed callbacks.
      }
    };
    const delivery = (async () => {
      try {
        for (const observe of observers) {
          try {
            await observe();
          } catch {
            unavailable();
          }
        }
      } finally {
        onDrained();
      }
      return true;
    })();
    const timer = new AbortController();
    try {
      // The budget bounds waiting, never the callbacks or their retained reservation.
      if (!(await Promise.race([delivery, sleep(budgetMs, false, { signal: timer.signal })]))) unavailable();
    } finally {
      timer.abort();
    }
  };
  return Object.assign(deliver, { reserve: (signal: AbortSignal) => admission.acquire(signal) });
}

export const deliverJobObservers = createObserverDelivery();
