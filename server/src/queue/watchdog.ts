import { QUEUE_TIMING } from 'src/queue/types.js';

/** Pure monotonic-clock deadline policy, shared with fault-injection tests. */
export class QueueWatchdog {
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
        entry.units > 0 ? entry.progress + QUEUE_TIMING.noProgressDeadline : entry.started + entry.deadline;
      const unavailable = now - lastDatabaseHeartbeat >= QUEUE_TIMING.lease - QUEUE_TIMING.cancelGrace;
      if (entry.cancel !== undefined || now >= deadline || unavailable) {
        entry.cancel ??= now;
        cancel.push(id);
        terminate ||= now - entry.cancel >= QUEUE_TIMING.cancelGrace;
      }
    }
    return { cancel, terminate };
  }
}
