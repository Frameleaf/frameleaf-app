import { AbortError, handlePromiseError } from '$lib/utils';

interface Options {
  concurrency: number;
}

type Runnable = () => Promise<unknown>;
type QueueEntry = { run: Runnable; reject: (reason?: unknown) => void };

export class ExecutorQueue {
  private queue: Array<QueueEntry> = [];
  private running = 0;
  private _concurrency: number;

  constructor(options?: Options) {
    this._concurrency = options?.concurrency || 2;
  }

  get concurrency() {
    return this._concurrency;
  }

  set concurrency(concurrency: number) {
    if (concurrency < 1) {
      return;
    }

    this._concurrency = concurrency;

    const v = concurrency - this.running;
    if (v > 0) {
      for (let i = 0; i < v; i++) {
        this.tryRun();
      }
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
    this.queue = [];
    for (const { reject } of pending) {
      reject(reason);
    }
  }

  private taskFinished(): void {
    this.running--;
    this.tryRun();
  }

  private tryRun() {
    if (this.running >= this.concurrency) {
      return;
    }

    const entry = this.queue.shift();
    if (!entry) {
      return;
    }

    handlePromiseError(entry.run());
  }
}
