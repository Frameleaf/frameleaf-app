import { ExecutorQueue } from '$lib/utils/executor-queue';

describe('Executor Queue test', function () {
  it('should run all promises', async function () {
    const eq = new ExecutorQueue({ concurrency: 1 });
    const n1 = await eq.addTask(() => Promise.resolve(10));
    expect(n1).toBe(10);
    const n2 = await eq.addTask(() => Promise.resolve(11));
    expect(n2).toBe(11);
    const n3 = await eq.addTask(() => Promise.resolve(12));
    expect(n3).toBe(12);
  });

  it('starts tasks in FIFO order and respects concurrency', async () => {
    const eq = new ExecutorQueue({ concurrency: 2 });
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, id) =>
      eq.addTask(() => {
        started.push(id);
        return new Promise<number>((resolve) => {
          releases.push(() => resolve(id));
        });
      }),
    );
    expect(started).toEqual([0, 1]);
    releases[1]();
    await tasks[1];
    expect(started).toEqual([0, 1, 2]);
    releases[0]();
    await tasks[0];
    expect(started).toEqual([0, 1, 2, 3]);
    releases[2]();
    releases[3]();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
    'defaults invalid constructor concurrency %s to two',
    (concurrency) => {
      expect(new ExecutorQueue({ concurrency }).concurrency).toBe(2);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])('ignores invalid concurrency assignment %s', (concurrency) => {
    const eq = new ExecutorQueue({ concurrency: 2 });
    // Stop the original Infinity loop at its first dispatch, so this regression cannot hang tests.
    vi.spyOn(eq as unknown as { tryRun(): void }, 'tryRun').mockImplementation(() => {
      throw new Error('Invalid concurrency dispatched a task');
    });
    expect(() => {
      eq.concurrency = concurrency;
    }).not.toThrow();
    expect(eq.concurrency).toBe(2);
  });

  it('does not loop over unused slots for a large valid concurrency', () => {
    const eq = new ExecutorQueue();
    vi.spyOn(eq as unknown as { tryRun(): void }, 'tryRun').mockImplementation(() => {
      throw new Error('Empty queue dispatched a task');
    });
    expect(() => {
      eq.concurrency = Number.MAX_SAFE_INTEGER;
    }).not.toThrow();
    expect(eq.concurrency).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('raises capacity immediately and lowering it lets running tasks finish', async () => {
    const eq = new ExecutorQueue({ concurrency: 1 });
    const started: number[] = [];
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, id) =>
      eq.addTask(() => {
        started.push(id);
        return new Promise<number>((resolve) => {
          releases.push(() => resolve(id));
        });
      }),
    );
    eq.concurrency = 3;
    expect(started).toEqual([0, 1, 2]);
    eq.concurrency = 1;
    releases[0]();
    releases[1]();
    await Promise.all([tasks[0], tasks[1]]);
    expect(started).toEqual([0, 1, 2]);
    releases[2]();
    await tasks[2];
    expect(started).toEqual([0, 1, 2, 3]);
    releases[3]();
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3]);
  });

  it('propagates thrown and rejected errors and keeps draining', async () => {
    const eq = new ExecutorQueue({ concurrency: 1 });
    const thrown = new Error('thrown');
    const rejected = new Error('rejected');
    const tasks = [
      eq.addTask(() => {
        throw thrown;
      }),
      eq.addTask(() => Promise.reject(rejected)),
      eq.addTask(() => Promise.resolve('last')),
    ];
    expect(await Promise.allSettled(tasks)).toEqual([
      { status: 'rejected', reason: thrown },
      { status: 'rejected', reason: rejected },
      { status: 'fulfilled', value: 'last' },
    ]);
  });

  it('drains a large pending batch in FIFO order', async () => {
    const eq = new ExecutorQueue({ concurrency: 1 });
    let release!: () => void;
    const first = eq.addTask(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const started: number[] = [];
    const tasks = Array.from({ length: 5000 }, (_, id) =>
      eq.addTask(async () => {
        started.push(id);
        return id;
      }),
    );
    release();
    await first;
    const expected = Array.from({ length: 5000 }, (_, id) => id);
    expect(await Promise.all(tasks)).toEqual(expected);
    expect(started).toEqual(expected);
  });

  it('rejects only pending promises with a supplied reason and can be reused after clear', async () => {
    const eq = new ExecutorQueue({ concurrency: 1 });
    let release!: () => void;
    const started: string[] = [];
    const first = eq.addTask(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('first');
        }),
    );
    const pending = Array.from({ length: 20 }, () =>
      eq.addTask(async () => {
        started.push('cancelled');
      }),
    );
    const settled = Promise.allSettled(pending);
    const reason = new Error('cancel');
    eq.clear(reason);
    eq.clear(reason);
    const next = eq.addTask(async () => {
      started.push('next');
      return 'next';
    });
    expect(await settled).toEqual(pending.map(() => ({ status: 'rejected', reason })));
    release();
    expect(await first).toBe('first');
    expect(await next).toBe('next');
    expect(started).toEqual(['next']);
  });

  it('clears after dequeuing part of a pending batch without rejecting its running task', async () => {
    const eq = new ExecutorQueue({ concurrency: 1 });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = eq.addTask(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    const second = eq.addTask(
      () =>
        new Promise<string>((resolve) => {
          releaseSecond = () => resolve('second');
        }),
    );
    const pending = Array.from({ length: 30 }, () => eq.addTask(async () => 'cancelled'));
    const settled = Promise.allSettled(pending);
    releaseFirst();
    await first;
    const reason = new Error('cancel after dequeue');
    eq.clear(reason);
    expect(await settled).toEqual(pending.map(() => ({ status: 'rejected', reason })));
    const next = eq.addTask(async () => 'next');
    releaseSecond();
    expect(await second).toBe('second');
    expect(await next).toBe('next');
  });

  it('rejects queued-but-not-started tasks on clear() without touching running ones', async () => {
    const eq = new ExecutorQueue({ concurrency: 1 });

    let releaseFirst: (() => void) | undefined;
    const first = eq.addTask(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve('first');
        }),
    );
    const second = eq.addTask(() => Promise.resolve('second'));

    // `second` is still waiting for a slot behind `first`; clearing must drop only that one.
    eq.clear();

    await expect(second).rejects.toThrow();

    releaseFirst?.();
    await expect(first).resolves.toBe('first');
  });
});
