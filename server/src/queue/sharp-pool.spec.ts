import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { parentPort } from 'node:worker_threads';
import sharp from 'sharp';
import { SharpProcessPool } from 'src/queue/sharp-pool.js';
import { sharpConfiguration } from 'src/queue/sharp-configuration.js';
import { operationExecution } from 'src/utils/execution-signal.js';

vi.mock('node:worker_threads', async (original) => ({
  ...(await original<typeof import('node:worker_threads')>()),
  parentPort: { postMessage: vi.fn() },
}));
beforeEach(() => vi.mocked(parentPort!.postMessage).mockClear());

const fixture = new URL('../../test/fixtures/sharp/pool-child.mjs', import.meta.url);
const pools: SharpProcessPool[] = [];
const children: ChildProcess[] = [];
const createChild = () => {
  const child = fork(fixture, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
  });
  children.push(child);
  return child;
};
const pool = (options: ConstructorParameters<typeof SharpProcessPool>[0] = {}) => {
  const value = new SharpProcessPool({
    workers: 1,
    pending: 1,
    deadlineMs: 3000,
    graceMs: 30,
    createChild,
    ...options,
  });
  pools.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(pools.splice(0).map((value) => value.close()));
  children.length = 0;
});

describe('bounded native image process pool', () => {
  it('kills an opaque nonqueue hang before releasing its slot and reuses the replacement', async () => {
    const value = pool({ deadlineMs: 1500 });
    await value.run('getImageMetadata', ['warm']);
    const first = children[0];
    const closed = once(first, 'close');
    let didClose = false;
    first.once('close', () => {
      didClose = true;
    });
    const failed = value.run('getImageMetadata', ['hang']).then(
      () => {
        throw new Error('expected timeout');
      },
      (error: Error) => {
        expect(didClose).toBe(true);
        return error;
      },
    );
    expect(children).toHaveLength(1);
    expect((await failed).message).toContain('execution deadline');
    expect((await closed)[1]).toBe('SIGKILL');
    const result = await value.run('getImageMetadata', ['replacement']);
    expect(result.width).not.toBe(first.pid);
    expect(children).toHaveLength(2);
    expect((await value.run('getImageMetadata', ['reuse'])).width).toBe(result.width);
    expect(children).toHaveLength(2);
  });

  it('cancels queued admission without starting a child or spending a worker slot', async () => {
    const value = pool();
    await value.run('getImageMetadata', ['warm']);
    const activeAbort = new AbortController();
    const active = value.run('getImageMetadata', ['hang'], activeAbort.signal).then(
      () => {
        throw new Error('expected cancellation');
      },
      (error: Error) => error,
    );
    const queuedAbort = new AbortController();
    const queued = value.run('getImageMetadata', ['queued'], queuedAbort.signal);
    await expect(value.run('getImageMetadata', ['overflow'])).rejects.toThrow('admission is full');
    queuedAbort.abort(new Error('cancel queued'));
    await expect(queued).rejects.toThrow('cancel queued');
    expect(children).toHaveLength(1);
    activeAbort.abort(new Error('cancel active'));
    expect((await active).message).toBe('cancel active');
    expect(children[0].signalCode).toBe('SIGKILL');
  });

  it('uses the current execution cancellation context and removes per-task listeners on reuse', async () => {
    const value = pool();
    const abort = new AbortController();
    const progress = vi.fn();
    await operationExecution.run(
      { signal: abort.signal, progress, settle: () => Promise.resolve(), settled: false, completed: new Map() },
      async () => {
        for (let index = 0; index < 25; index++) {
          await value.run('getImageMetadata', ['warm']);
        }
        expect(children).toHaveLength(1);
        expect(parentPort!.postMessage).toHaveBeenCalledExactlyOnceWith({
          type: 'queue-child',
          pid: children[0].pid,
          active: true,
        });
        expect(children[0].listenerCount('close')).toBe(2); // Pool + lifetime PID registration only.
        const pending = value.run('getImageMetadata', ['hang']);
        abort.abort(new Error('operation cancelled'));
        await expect(pending).rejects.toThrow('operation cancelled');
        expect(children[0].signalCode).toBe('SIGKILL');
      },
    );
    expect(progress).toHaveBeenCalledTimes(25);
    expect(parentPort!.postMessage).toHaveBeenLastCalledWith({
      type: 'queue-child',
      pid: children[0].pid,
      active: false,
    });
  });

  it('terminates a stopped actual Sharp child and then decodes through a new process', async () => {
    const nativeChildren: ChildProcess[] = [];
    const value = pool({
      deadlineMs: 10_000,
      createChild: () => {
        const child = fork(new URL('./sharp-worker.ts', import.meta.url), [], {
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          execArgv: ['--import', 'tsx'],
        });
        nativeChildren.push(child);
        return child;
      },
    });
    const input = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#abcdef80' } })
      .png()
      .toBuffer();
    expect(await value.run('getImageMetadata', [input])).toEqual({ width: 3, height: 2, isTransparent: true });
    const original = nativeChildren[0];
    original.kill('SIGSTOP');
    const closed = once(original, 'close');
    await expect(value.run('getImageMetadata', [input], AbortSignal.timeout(100))).rejects.toThrow();
    expect((await closed)[1]).toBe('SIGKILL');
    expect(await value.run('getImageMetadata', [input])).toEqual({ width: 3, height: 2, isTransparent: true });
    expect(nativeChildren).toHaveLength(2);
    expect(nativeChildren[1].pid).not.toBe(original.pid);
  }, 20_000);

  it('retires idle children and rejects rather than silently resizing over-limit input', async () => {
    const value = pool({ idleChildMs: 20, maxBytes: 8 });
    await expect(value.run('getImageMetadata', [Buffer.alloc(9)])).rejects.toThrow('input buffer is too large');
    expect(children).toHaveLength(0);
    await value.run('getImageMetadata', ['ok']);
    const closed = once(children[0], 'close');
    await closed;
    expect(children[0].signalCode).toBe('SIGKILL');
  });
});

describe('Sharp resource configuration', () => {
  it('allows 100MP 16-bit RGB and the existing 200MP artifact size by default', () => {
    const config = sharpConfiguration({});
    expect(config.maxBytes).toBeGreaterThan(100_000_000 * 3 * 2);
    expect(config.maxPixels).toBeGreaterThanOrEqual(200_000_000);
  });
  it.each(['NaN', '-1', 'Infinity', '1.5', '0', '99'])('rejects invalid worker limit %s', (value) => {
    expect(() => sharpConfiguration({ FRAMELEAF_SHARP_WORKERS: value })).toThrow('FRAMELEAF_SHARP_WORKERS');
  });
});
