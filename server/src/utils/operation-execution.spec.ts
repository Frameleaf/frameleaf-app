import { PassThrough, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionSignal, operationExecution, reportExecutionProgress } from 'src/utils/execution-signal.js';
import {
  OperationClaimLostError,
  OperationDeadlineError,
  withOperationExecution,
} from 'src/utils/operation-execution.js';

const deferred = () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
};
const untilAborted = () => {
  const signal = executionSignal()!;
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};

describe('operation execution lifetime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('heartbeats cannot hide stalled work, and failure waits for underlying close', async () => {
    const closing = deferred();
    const started = deferred();
    const renew = vi.fn().mockResolvedValue(true);
    let stopped = false;
    let returned = false;
    const task = withOperationExecution({ renew, pollMs: 10, deadlineMs: 100 }, async () => {
      const source = new PassThrough();
      const sink = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
        destroy(error, done) {
          stopped = true;
          void closing.promise.then(() => done(error));
        },
      });
      const running = pipeline(source, sink, { signal: executionSignal() });
      started.resolve();
      await running;
    }).finally(() => {
      returned = true;
    });
    const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    await vi.advanceTimersByTimeAsync(110);
    expect(renew).toHaveBeenCalled();
    expect(stopped).toBe(true);
    expect(returned).toBe(false);
    closing.resolve();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('claim loss aborts execution without waiting for the progress deadline', async () => {
    const task = withOperationExecution(
      { renew: () => Promise.resolve(false), pollMs: 10, deadlineMs: 1000 },
      untilAborted,
    );
    const rejection = expect(task).rejects.toBeInstanceOf(OperationClaimLostError);
    await vi.advanceTimersByTimeAsync(11);
    await rejection;
  });

  it('actual byte progress extends the idle deadline; repeated counters do not', async () => {
    let progress!: () => void;
    const task = withOperationExecution(
      { renew: () => Promise.resolve(true), pollMs: 10, deadlineMs: 100, idleMs: 100 },
      async () => {
        const state = operationExecution.getStore()!;
        progress = () => operationExecution.run(state, () => reportExecutionProgress('files', 1));
        return untilAborted();
      },
    );
    const rejection = expect(task).rejects.toBeInstanceOf(OperationDeadlineError);
    await vi.advanceTimersByTimeAsync(80);
    progress();
    await vi.advanceTimersByTimeAsync(80);
    progress();
    await vi.advanceTimersByTimeAsync(21);
    await rejection;
  });

  it('rejects late successful returns from a callback that ignored its abort signal', async () => {
    const release = deferred();
    const task = withOperationExecution({ renew: () => Promise.resolve(true), deadlineMs: 100 }, () => release.promise);
    const rejection = expect(task).rejects.toBeInstanceOf(OperationDeadlineError);
    await vi.advanceTimersByTimeAsync(101);
    release.resolve();
    await rejection;
  });
});
