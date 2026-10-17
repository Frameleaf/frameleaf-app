import { Queue, defaultQueueOptions } from 'src/queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Queue', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves task lookup overrides used to prepare dispatched data', async () => {
    class PreparedQueue extends Queue<number, number> {
      override getTask(id: string) {
        const task = super.getTask(id);
        task.data += 1;
        return task;
      }
    }
    const queue = new PreparedQueue(async (input) => input, { retry: 3 });
    const task = await queue.push(1);
    expect(task.data).toBe(2);
    expect(task.result).toBe(2);
  });

  it('keeps task identity, insertion order and the worker result', async () => {
    const result = { uploaded: true };
    const input = { path: 'photo.jpg' };
    const worker = vi.fn(async () => result);
    const queue = new Queue(worker);
    const task = await queue.push(input);
    expect(queue.options).toEqual(defaultQueueOptions);
    expect(task).toEqual({
      id: expect.any(String),
      status: 'succeeded',
      error: undefined,
      count: 1,
      data: input,
      result,
    });
    expect(task.data).toBe(input);
    expect(task.result).toBe(result);
    expect(queue.getTask(task.id)).toBe(task);
    expect(queue.tasks).toEqual([task]);
    expect(queue.tasks).not.toBe(queue.tasks);
    expect(worker).toHaveBeenCalledWith(input);
    expect(() => queue.getTask('missing')).toThrow('Task with id missing not found');
  });

  it('limits active workers and drains only after queued and running work completes', async () => {
    const releases = new Map<number, () => void>();
    const started: number[] = [];
    const queue = new Queue(
      async (input: number) => {
        started.push(input);
        await new Promise<void>((resolve) => releases.set(input, resolve));
        return input * 2;
      },
      { concurrency: 2 },
    );
    const promises = [queue.push(0), queue.push(1), queue.push(2), queue.push(3)];
    let isDrained = false;
    const drain = (async () => {
      await queue.drained();
      isDrained = true;
    })();
    expect(started).toEqual([0, 1]);
    expect(queue.tasks.map((task) => task.status)).toEqual(['processing', 'processing', 'idle', 'idle']);
    releases.get(1)!();
    await promises[1];
    expect(started).toEqual([0, 1, 2]);
    expect(isDrained).toBe(false);
    releases.get(0)!();
    await promises[0];
    expect(started).toEqual([0, 1, 2, 3]);
    releases.get(2)!();
    await promises[2];
    expect(isDrained).toBe(false);
    releases.get(3)!();
    await drain;
    const tasks = await Promise.all(promises);
    expect(tasks.map((task) => task.result)).toEqual([0, 2, 4, 6]);
    expect(new Set(queue.tasks.map((task) => task.id)).size).toBe(4);
  });

  it.each([0, 1, 2, 3, 2.5])('preserves the existing attempt budget for retry=%s', async (retry) => {
    const error = { reason: 'temporary failure' };
    const worker = vi.fn(async () => {
      throw error;
    });
    const queue = new Queue(worker, { retry });
    const task = await queue.push('input');
    expect(task.status).toBe('failed');
    expect(task.error).toBe(error);
    expect(task.result).toBeUndefined();
    expect(task.count).toBe(Math.max(1, Math.ceil(retry)));
    expect(worker).toHaveBeenCalledTimes(task.count);
    await queue.drained();
  });

  it('clears a previous error before each retry and keeps the same task object', async () => {
    const snapshots: Array<[string, number, unknown]> = [];
    const queue = new Queue(
      async () => {
        const task = queue.tasks[0];
        snapshots.push([task.status, task.count, task.error]);
        if (task.count < 3) {
          throw new Error('retry');
        }
        return 'done';
      },
      { retry: 3 },
    );
    const task = await queue.push('input');
    expect(snapshots).toEqual([
      ['processing', 1, undefined],
      ['processing', 2, undefined],
      ['processing', 3, undefined],
    ]);
    expect(task).toBe(queue.getTask(task.id));
    expect(task).toMatchObject({ status: 'succeeded', count: 3, result: 'done', error: undefined });
  });

  it('retains the worker receiver and honors option changes made during an attempt', async () => {
    const queue = new Queue(
      function (this: unknown) {
        expect(this).toBe(queue);
        queue.options.retry = 1;
        return Promise.reject('failed');
      },
      { retry: 3 },
    );
    const task = await queue.push('input');
    expect(task).toMatchObject({ status: 'failed', count: 1, error: 'failed' });
  });

  it('logs each processing, failure, retry and success transition in order', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = vi.fn().mockRejectedValueOnce('failed').mockResolvedValueOnce('done');
    const queue = new Queue(worker, { retry: 2, verbose: true });
    await queue.push('input');
    expect(log.mock.calls.map(([message]) => message)).toEqual([
      '[task] processing:',
      '[task] failed:',
      '[task] retry:',
      '[task] processing:',
      '[task] succeeded:',
    ]);
    expect(log.mock.calls.every(([, task]) => task === queue.tasks[0])).toBe(true);
  });

  it('can be drained while idle and used again, with ignored failed-task promises', async () => {
    const queue = new Queue(async (input: number) => {
      if (input < 0) {
        throw new Error('failed');
      }
      return input;
    });
    await queue.drained();
    void queue.push(-1);
    await queue.drained();
    const task = await queue.push(2);
    await queue.drained();
    expect(task.status).toBe('succeeded');
    expect(queue.tasks.map((task) => task.status)).toEqual(['failed', 'succeeded']);
  });
});
