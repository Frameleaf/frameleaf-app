import { QUEUE_BATCH, QUEUE_EXECUTION_CAPACITY } from 'src/queue/types.js';

export { QUEUE_EXECUTION_CAPACITY } from 'src/queue/types.js';

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

  /** Applies at once: a larger capacity grants waiters now, a smaller one lets running work finish. */
  resize(capacity: number) {
    this.capacity = capacity;
    while (this.active < this.capacity && this.waiting.size > 0) {
      const next = this.waiting.values().next().value!;
      this.waiting.delete(next);
      this.active++;
      next();
    }
  }

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
      const next = this.active <= this.capacity ? this.waiting.values().next().value : undefined;
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

const admissions = new WeakMap<object, { execution: QueueAdmission }>();

/** Facades sharing one execution database also share its admission budget. */
export const queueAdmission = (db: object) => {
  let admission = admissions.get(db);
  if (!admission) {
    admission = { execution: new QueueAdmission(QUEUE_EXECUTION_CAPACITY) };
    admissions.set(db, admission);
  }
  return admission;
};
