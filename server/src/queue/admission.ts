import { QUEUE_BATCH } from 'src/queue/types.js';
import { DATABASE_POOL_SIZE } from 'src/utils/execution-database.js';

// Leave session headroom for handler fan-out and non-job work in the execution pool.
// The coordinator and its LISTEN connection retain their own independent pools.
export const QUEUE_EXECUTION_CAPACITY = Math.max(1, DATABASE_POOL_SIZE - 2);

export class QueueAdmissionFull extends Error {
  constructor() {
    super('Local queue execution capacity exhausted');
  }
}

/** Wait before acquiring SQL or starting effects. Cancelled waiters can never receive a late grant. */
export class QueueAdmission {
  private active = 0;
  private waiting = new Set<() => void>();

  constructor(private capacity: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= this.capacity) {
      if (this.waiting.size >= QUEUE_BATCH) throw new QueueAdmissionFull();
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          this.waiting.delete(grant);
          reject(signal.reason);
        };
        const grant = () => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        this.waiting.add(grant);
        signal.addEventListener('abort', cancel, { once: true });
      });
    } else {
      this.active++;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiting.values().next().value;
      if (next) {
        this.waiting.delete(next);
        next();
      } else {
        this.active--;
      }
    };
    // Abort can arrive after a grant but before this continuation resumes.
    if (signal.aborted) {
      release();
      signal.throwIfAborted();
    }
    return release;
  }

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      return await action();
    } finally {
      release();
    }
  }
}

const admissions = new WeakMap<object, { execution: QueueAdmission; publication: QueueAdmission }>();

/** Facades sharing one execution database also share its admission budget. */
export const queueAdmission = (db: object) => {
  let admission = admissions.get(db);
  if (!admission) {
    admission = { execution: new QueueAdmission(QUEUE_EXECUTION_CAPACITY), publication: new QueueAdmission(1) };
    admissions.set(db, admission);
  }
  return admission;
};
