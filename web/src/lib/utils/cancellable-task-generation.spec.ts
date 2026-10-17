import { CancellableTask } from '$lib/utils/cancellable-task';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('CancellableTask completion ownership', () => {
  it.each([
    ['throw', true],
    ['throw', false],
    ['controller', true],
    ['controller', false],
  ] as const)('settles %s aborts with cancellable=%s and permits a retry', async (mode, cancellable) => {
    const canceled = vi.fn();
    const errored = vi.fn();
    const task = new CancellableTask(undefined, canceled, errored);
    const completion = task.complete;
    const owner = task.execute(async () => {
      if (mode === 'throw') {
        throw new DOMException('Request was aborted', 'AbortError');
      }
      task.cancelToken!.abort();
    }, cancellable);
    const waited = vi.fn();
    const joined = vi.fn();
    const waiting = task.waitUntilCompletion().then(waited);
    const joining = task.execute(async () => {}, true).then(joined);

    expect(await owner).toBe('CANCELED');
    await Promise.resolve();
    expect(waited).toHaveBeenCalledExactlyOnceWith('CANCELED');
    expect(joined).toHaveBeenCalledExactlyOnceWith('CANCELED');
    await Promise.all([waiting, joining]);
    await expect(completion).rejects.toBeUndefined();
    expect(canceled).toHaveBeenCalledTimes(1);
    expect(errored).not.toHaveBeenCalled();
    expect(task.loading).toBe(false);
    expect(task.executed).toBe(false);
    expect(task.complete).not.toBe(completion);
    expect(await task.execute(async () => {}, true)).toBe('LOADED');
  });

  it.each(['idle', 'running'])('reset preserves a callback replacement from %s state', async (state) => {
    const oldRequest = deferred();
    const nextRequest = deferred();
    let replacement!: Promise<unknown>;
    const canceled = vi.fn(() => {
      replacement = task.execute(() => nextRequest.promise, true);
    });
    const task = new CancellableTask(undefined, canceled);
    const old = state === 'running' ? task.execute(() => oldRequest.promise, true) : undefined;

    const resetting = task.reset();
    const replacementCompletion = task.complete;
    const waiting = task.waitUntilCompletion();
    oldRequest.resolve();
    nextRequest.resolve();
    if (old) {
      expect(await old).toBe('CANCELED');
    }
    expect(await replacement).toBe('LOADED');
    expect(await waiting).toBe('WAITED');
    await resetting;

    expect(task.complete).toBe(replacementCompletion);
    expect(task.executed).toBe(true);
    expect(task.loading).toBe(false);
    expect(canceled).toHaveBeenCalledTimes(1);
  });

  it('a reset waiting on a protected request preserves its error-callback retry', async () => {
    const oldRequest = deferred();
    const nextRequest = deferred();
    let replacement!: Promise<unknown>;
    let replacementCompletion!: Promise<unknown>;
    let replacementToken: AbortController | null = null;
    const task = new CancellableTask(undefined, undefined, () => {
      replacement = task.execute(() => nextRequest.promise, true);
      replacementCompletion = task.complete;
      replacementToken = task.cancelToken;
    });
    const old = task.execute(() => oldRequest.promise, false);
    const resetting = task.reset();
    oldRequest.reject(new Error('Protected request failed'));
    expect(await old).toBe('ERRORED');
    await resetting;
    const observed = { completion: task.complete, token: task.cancelToken, loading: task.loading };
    nextRequest.resolve();
    expect(await replacement).toBe('LOADED');

    expect(observed.completion).toBe(replacementCompletion);
    expect(observed.token).toBe(replacementToken);
    expect(observed.loading).toBe(true);
    expect(task.executed).toBe(true);
  });

  it('retires the old completion before abort listeners launch a replacement', async () => {
    const oldRequest = deferred();
    const nextRequest = deferred();
    const next = vi.fn(() => nextRequest.promise);
    let replacement!: Promise<unknown>;
    const task = new CancellableTask();
    const old = task.execute((signal) => {
      signal.addEventListener(
        'abort',
        () => {
          replacement = task.execute(next, true);
        },
        { once: true },
      );
      return oldRequest.promise;
    }, true);

    task.cancel();
    oldRequest.resolve();
    nextRequest.resolve();
    expect(await old).toBe('CANCELED');
    const result = await replacement;
    expect(next).toHaveBeenCalledTimes(1);
    expect(result).toBe('LOADED');
    expect(task.executed).toBe(true);
  });

  it('retains loaded-callback error handling and the already-resolved completion', async () => {
    const error = new Error('Loaded callback failed');
    const errored = vi.fn();
    const task = new CancellableTask(
      () => {
        throw error;
      },
      undefined,
      errored,
    );
    const completion = task.complete;

    expect(await task.execute(async () => {}, true)).toBe('ERRORED');
    await expect(completion).resolves.toBeUndefined();
    expect(errored).toHaveBeenCalledExactlyOnceWith(error);
    expect(task.executed).toBe(false);
    expect(task.loading).toBe(false);
  });

  it('propagates cancellation-callback errors after retiring the completion', async () => {
    const error = new Error('Canceled callback failed');
    const task = new CancellableTask(undefined, () => {
      throw error;
    });
    const completion = task.complete;

    expect(() => task.cancel()).toThrow(error);
    await expect(completion).rejects.toBeUndefined();
    expect(task.complete).not.toBe(completion);
    expect(task.loading).toBe(false);
  });

  it('propagates error-callback errors after retiring the completion', async () => {
    const error = new Error('Error callback failed');
    const task = new CancellableTask(undefined, undefined, () => {
      throw error;
    });
    const completion = task.complete;

    await expect(task.execute(() => Promise.reject(new Error('Request failed')), true)).rejects.toBe(error);
    await expect(completion).rejects.toBeUndefined();
    expect(task.complete).not.toBe(completion);
    expect(task.loading).toBe(false);
  });

  it.each(['AbortError', 'aborted-controller'])('retains the loaded completion after callback %s', async (mode) => {
    const canceled = vi.fn();
    const errored = vi.fn();
    const task = new CancellableTask(
      () => {
        if (mode === 'aborted-controller') {
          task.cancelToken!.abort();
          throw new Error('Callback failed after aborting its controller');
        }
        throw new DOMException('Callback was aborted', 'AbortError');
      },
      canceled,
      errored,
    );
    const completion = task.complete;

    expect(await task.execute(async () => {}, true)).toBe('CANCELED');
    await expect(completion).resolves.toBeUndefined();
    expect(task.executed).toBe(true);
    expect(task.complete).toBe(completion);
    expect(task.loading).toBe(false);
    expect(canceled).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  it('retains successful completion when the loaded callback only aborts its controller', async () => {
    const canceled = vi.fn();
    const task = new CancellableTask(() => task.cancelToken!.abort(), canceled);
    const completion = task.complete;

    expect(await task.execute(async () => {}, true)).toBe('LOADED');
    await expect(completion).resolves.toBeUndefined();
    expect(task.executed).toBe(true);
    expect(task.complete).toBe(completion);
    expect(canceled).not.toHaveBeenCalled();
  });
});
