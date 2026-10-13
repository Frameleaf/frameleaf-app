import { AbortError, handlePromiseError } from '$lib/utils';

interface Options {
  concurrency: number;
}

type Runnable = () => Promise<unknown>;
type QueueEntry = { run: Runnable; reject: (reason?: unknown) => void };

export class ExecutorQueue {
  private queue: Array<QueueEntry | undefined> = [];
  private head = 0;
  private running = 0;
  private draining = false;
  private _concurrency = 2;

  constructor(options?: Options) {
    this.concurrency = options?.concurrency ?? 2;
  }

  get concurrency() {
    return this._concurrency;
  }

  set concurrency(concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      return;
    }

    this._concurrency = concurrency;

    while (this.running < this.concurrency && this.head < this.queue.length) {
      this.tryRun();
    }
  }

  addTask<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      // Add a custom task that wrap the original one;
      this.queue.push({
        run: async () => {
          try {
            this.running++;
            const result = task();
            resolve(await result);
          } catch (error) {
            reject(error);
          } finally {
            this.taskFinished();
          }
        },
        reject,
      });
      // Then run it if possible !
      this.tryRun();
    });
  }

  /**
   * Drops every task that has not started yet and rejects its promise, so a caller
   * awaiting the batch (`Promise.all` in `fileUploadHandler`) settles instead of hanging
   * forever. Tasks already running are unaffected — cancelling those is the caller's job
   * (aborting their underlying request), since this queue has no visibility into what a
   * running task is doing.
   */
  clear(reason: unknown = new AbortError('Cancelled before it started')): void {
    const pending = this.queue;
    const head = this.head;
    this.queue = [];
    this.head = 0;
    for (let i = head; i < pending.length; i++) {
      pending[i]?.reject(reason);
    }
  }

  private taskFinished(): void {
    this.running--;
    // Synchronous failures finish before run() returns; drain them without recursive dispatch.
    if (this.draining) {
      return;
    }

    this.draining = true;
    try {
      while (this.running < this.concurrency && this.head < this.queue.length) {
        this.tryRun();
      }
    } finally {
      this.draining = false;
    }
  }

  private tryRun() {
    if (this.running >= this.concurrency) {
      return;
    }

    const entry = this.queue[this.head];
    if (!entry) {
      return;
    }

    this.queue[this.head++] = undefined;
    if (this.head === this.queue.length) {
      this.queue = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
      // Compact only after consuming half the array, keeping dequeue amortized constant time.
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }

    handlePromiseError(entry.run());
  }
}
