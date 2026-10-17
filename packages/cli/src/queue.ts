import * as fastq from 'fastq';
import { uniqueId } from 'lodash-es';

export type Task<T, R> = {
  readonly id: string;
  status: 'idle' | 'processing' | 'succeeded' | 'failed';
  data: T;
  error: unknown | undefined;
  count: number;
  result: undefined | R;
};

export type QueueOptions = {
  verbose?: boolean;
  concurrency?: number;
  retry?: number;
};

export type ComputedQueueOptions = Required<QueueOptions>;

export const defaultQueueOptions = {
  concurrency: 1,
  retry: 0,
  verbose: false,
};

/**
 * An in-memory queue that processes tasks in parallel with a given concurrency.
 * @see {@link https://www.npmjs.com/package/fastq}
 * @template T - The type of the worker task data.
 * @template R - The type of the worker output data.
 */
export class Queue<T, R> {
  private readonly queue: fastq.queueAsPromised<string, Task<T, R>>;
  private readonly store = new Map<string, Task<T, R>>();
  readonly options: ComputedQueueOptions;
  readonly worker: (data: T) => Promise<R>;

  /**
   * Create a new queue.
   * @param worker - The worker function that processes the task.
   * @param options - The queue options.
   */
  constructor(worker: (data: T) => Promise<R>, options?: QueueOptions) {
    this.options = { ...defaultQueueOptions, ...options };
    this.worker = worker;
    this.queue = fastq.promise((id: string) => this.work(this.getTask(id)), this.options.concurrency);
  }

  get tasks(): Task<T, R>[] {
    return this.store.values().toArray();
  }

  getTask(id: string): Task<T, R> {
    const task = this.store.get(id);
    if (!task) {
      throw new Error(`Task with id ${id} not found`);
    }
    return task;
  }

  /**
   * Wait for the queue to be empty.
   * @returns Promise<void> - The returned Promise will be resolved when all tasks in the queue have been processed by a worker.
   * This promise could be ignored as it will not lead to a `unhandledRejection`.
   */
  drained(): Promise<void> {
    return this.queue.drained();
  }

  /**
   * Add a task at the end of the queue.
   * @see {@link https://www.npmjs.com/package/fastq}
   * @param data
   * @returns Promise<void> - A Promise that will be fulfilled (rejected) when the task is completed successfully (unsuccessfully).
   * This promise could be ignored as it will not lead to a `unhandledRejection`.
   */
  async push(data: T): Promise<Task<T, R>> {
    const id = uniqueId();
    const task: Task<T, R> = { id, status: 'idle', error: undefined, count: 0, data, result: undefined };
    this.store.set(id, task);
    return this.queue.push(id);
  }

  private async work(task: Task<T, R>): Promise<Task<T, R>> {
    for (;;) {
      task.count += 1;
      task.error = undefined;
      task.status = 'processing';
      if (this.options.verbose) {
        console.log('[task] processing:', task);
      }
      try {
        task.result = await this.worker(task.data);
        task.status = 'succeeded';
        if (this.options.verbose) {
          console.log('[task] succeeded:', task);
        }
        return task;
      } catch (error) {
        task.error = error;
        task.status = 'failed';
        if (this.options.verbose) {
          console.log('[task] failed:', task);
        }
        if (this.options.retry > 0 && task.count < this.options.retry) {
          if (this.options.verbose) {
            console.log('[task] retry:', task);
          }
          continue;
        }
        return task;
      }
    }
  }
}
