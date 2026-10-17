const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const createLock = () => ({ released: false, release: vi.fn(() => Promise.resolve()) });

// Keep visibility listeners scoped even though each module import owns fresh state.
const listeners: EventListener[] = [];
vi.mock('svelte/events', () => ({
  on: (_target: EventTarget, _event: string, listener: EventListener) => {
    listeners.push(listener);
    return () => {};
  },
}));

describe('wake lock request races', () => {
  beforeEach(() => {
    vi.resetModules();
    listeners.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('$app/env');
    Reflect.deleteProperty(navigator, 'wakeLock');
    vi.restoreAllMocks();
  });

  const setup = (request: ReturnType<typeof vi.fn>) => {
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  };

  it('remains safe during server rendering without a navigator', async () => {
    vi.doMock('$app/env', () => ({ browser: false }));
    vi.stubGlobal('navigator', undefined);
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    await expect(acquireWakeLock('upload')).resolves.toBeUndefined();
    await expect(releaseWakeLock('upload')).resolves.toBeUndefined();
    expect(listeners).toHaveLength(0);
  });

  it('allows holder cleanup when the browser lacks the wake-lock capability', async () => {
    vi.stubGlobal('navigator', {});
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    await acquireWakeLock();
    await acquireWakeLock('slideshow');
    await releaseWakeLock();
    await releaseWakeLock('slideshow');
    expect(listeners).toHaveLength(0);
  });

  it('acquires for a new holder that arrives while the orphan lock is being released', async () => {
    const acquisition = deferred<ReturnType<typeof createLock>>();
    const releasing = deferred<void>();
    const orphan = createLock();
    orphan.release.mockReturnValueOnce(releasing.promise);
    const active = createLock();
    const request = vi.fn().mockReturnValueOnce(acquisition.promise).mockResolvedValueOnce(active);
    setup(request);
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    const pending = acquireWakeLock('old');
    await releaseWakeLock('old');
    acquisition.resolve(orphan);
    await Promise.resolve();
    expect(orphan.release).toHaveBeenCalledOnce();
    await acquireWakeLock('new');
    releasing.resolve();
    await pending;
    expect(request).toHaveBeenCalledTimes(2);
    expect(active.release).not.toHaveBeenCalled();
    await releaseWakeLock('new');
    expect(active.release).toHaveBeenCalledOnce();
  });

  it('retries a refused acquisition only when a newer acquisition intent arrived', async () => {
    const first = deferred<ReturnType<typeof createLock>>();
    const active = createLock();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(active);
    setup(request);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    const pending = acquireWakeLock('slideshow');
    await acquireWakeLock('upload');
    first.reject(new DOMException('temporarily hidden', 'NotAllowedError'));
    await pending;
    expect(request).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    await releaseWakeLock('slideshow');
    expect(active.release).not.toHaveBeenCalled();
    await releaseWakeLock('upload');
    expect(active.release).toHaveBeenCalledOnce();
  });

  it('stops after refusal when no new intent arrived and keeps retry available', async () => {
    const active = createLock();
    const error = new DOMException('denied', 'NotAllowedError');
    const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(active);
    setup(request);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    await expect(acquireWakeLock('upload')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Failed to acquire wake lock:', error);
    await acquireWakeLock('upload');
    expect(request).toHaveBeenCalledTimes(2);
    await releaseWakeLock('upload');
    expect(active.release).toHaveBeenCalledOnce();
  });

  it('does not reacquire for a queued holder that also left before disposal finished', async () => {
    const acquisition = deferred<ReturnType<typeof createLock>>();
    const releasing = deferred<void>();
    const orphan = createLock();
    orphan.release.mockReturnValueOnce(releasing.promise);
    const request = vi.fn().mockReturnValueOnce(acquisition.promise);
    setup(request);
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    const pending = acquireWakeLock('old');
    await releaseWakeLock('old');
    acquisition.resolve(orphan);
    await Promise.resolve();
    await acquireWakeLock('new');
    await releaseWakeLock('new');
    releasing.resolve();
    await pending;
    expect(request).toHaveBeenCalledOnce();
    expect(orphan.release).toHaveBeenCalledOnce();
  });

  it('coalesces queued acquisitions when the first request already supplies a live lock', async () => {
    const acquisition = deferred<ReturnType<typeof createLock>>();
    const active = createLock();
    const request = vi.fn().mockReturnValueOnce(acquisition.promise);
    setup(request);
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    const pending = acquireWakeLock('upload');
    await acquireWakeLock('slideshow');
    await acquireWakeLock('slideshow');
    acquisition.resolve(active);
    await pending;
    expect(request).toHaveBeenCalledOnce();
    await releaseWakeLock('upload');
    expect(active.release).not.toHaveBeenCalled();
    await releaseWakeLock('slideshow');
    expect(active.release).toHaveBeenCalledOnce();
  });

  it('does not clobber a replacement lock when an older release settles', async () => {
    const old = createLock();
    const next = createLock();
    const releasing = deferred<void>();
    old.release.mockReturnValueOnce(releasing.promise);
    const request = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    setup(request);
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    await acquireWakeLock('old');
    const pending = releaseWakeLock('old');
    await acquireWakeLock('new');
    releasing.resolve();
    await pending;
    await acquireWakeLock('new');
    expect(request).toHaveBeenCalledTimes(2);
    await releaseWakeLock('new');
    expect(next.release).toHaveBeenCalledOnce();
  });

  it('uses a queued visibility intent after an in-flight refusal', async () => {
    const first = deferred<ReturnType<typeof createLock>>();
    const active = createLock();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(active);
    setup(request);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    const pending = acquireWakeLock('slideshow');
    expect(listeners).toHaveLength(1);
    listeners[0](new Event('visibilitychange'));
    first.reject(new DOMException('hidden', 'NotAllowedError'));
    await pending;
    expect(request).toHaveBeenCalledTimes(2);
    await releaseWakeLock('slideshow');
    expect(active.release).toHaveBeenCalledOnce();
  });

  it('keeps newer intent when orphan disposal itself rejects', async () => {
    const acquisition = deferred<ReturnType<typeof createLock>>();
    const releasing = deferred<void>();
    const orphan = createLock();
    orphan.release.mockReturnValueOnce(releasing.promise);
    const active = createLock();
    const request = vi.fn().mockReturnValueOnce(acquisition.promise).mockResolvedValueOnce(active);
    setup(request);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');
    const pending = acquireWakeLock('old');
    await releaseWakeLock('old');
    acquisition.resolve(orphan);
    await Promise.resolve();
    await acquireWakeLock('new');
    const error = new Error('release refused');
    releasing.reject(error);
    await expect(pending).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Failed to release wake lock:', error);
    expect(request).toHaveBeenCalledTimes(2);
    await releaseWakeLock('new');
    expect(active.release).toHaveBeenCalledOnce();
  });
});
