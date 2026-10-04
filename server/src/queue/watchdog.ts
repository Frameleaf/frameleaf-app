import { performance } from 'node:perf_hooks';
import { QUEUE_TIMING } from 'src/queue/types.js';

/** Pure monotonic-clock deadline policy, shared with fault-injection tests. */
export class QueueWatchdog {
  constructor(private timing: { noProgressDeadline: number; lease: number; cancelGrace: number } = QUEUE_TIMING) {}

  private entries = new Map<
    string,
    { started: number; progress: number; units: number; deadline: number; cancel?: number }
  >();

  add(id: string, now: number, deadline: number) {
    this.entries.set(id, { started: now, progress: now, units: 0, deadline });
  }

  progress(id: string, units: number, now: number) {
    const entry = this.entries.get(id);
    if (entry && Number.isSafeInteger(units) && units > entry.units) {
      entry.units = units;
      entry.progress = now;
    }
  }

  cancel(id: string, now: number) {
    const entry = this.entries.get(id);
    if (entry) {
      entry.cancel ??= now;
    }
  }

  remove(id: string) {
    this.entries.delete(id);
  }

  inspect(now: number, lastDatabaseHeartbeat: number) {
    const cancel: string[] = [];
    let terminate = false;
    for (const [id, entry] of this.entries) {
      const deadline =
        entry.units > 0 ? entry.progress + this.timing.noProgressDeadline : entry.started + entry.deadline;
      const unavailable = now - lastDatabaseHeartbeat >= this.timing.lease - this.timing.cancelGrace;
      if (entry.cancel !== undefined || now >= deadline || unavailable) {
        entry.cancel ??= now;
        cancel.push(id);
        terminate ||= now - entry.cancel >= this.timing.cancelGrace;
      }
    }
    return { cancel, terminate };
  }
}

/** The production coordinator's independent timer, shared with process fault acceptance tests. */
export function monitorQueueProgress(
  watchdog: QueueWatchdog,
  callbacks: { alive: () => void; cancel: (id: string) => void; terminate: () => void; lastHeartbeat: () => number },
  scanMs = 1000,
) {
  const timer = setInterval(() => {
    callbacks.alive();
    const result = watchdog.inspect(performance.now(), callbacks.lastHeartbeat());
    for (const id of result.cancel) callbacks.cancel(id);
    if (result.terminate) callbacks.terminate();
  }, scanMs);
  return () => clearInterval(timer);
}
