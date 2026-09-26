import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('wake lock holders (FL-36)', () => {
  const release = vi.fn(() => Promise.resolve());
  const request = vi.fn(() => Promise.resolve({ released: false, release }));

  beforeEach(() => {
    vi.resetModules();
    release.mockClear();
    request.mockClear();
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'wakeLock');
  });

  it('keeps the screen on until the last holder lets go', async () => {
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');

    await acquireWakeLock('upload');
    await acquireWakeLock('slideshow');
    expect(request).toHaveBeenCalledOnce();

    await releaseWakeLock('upload');
    expect(release).not.toHaveBeenCalled();

    await releaseWakeLock('slideshow');
    expect(release).toHaveBeenCalledOnce();
  });

  it('treats repeated acquires by one holder as one', async () => {
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');

    await acquireWakeLock();
    await acquireWakeLock();
    await releaseWakeLock();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases a lock that arrives after everyone let go', async () => {
    let resolveRequest: (lock: { released: boolean; release: typeof release }) => void = () => {};
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');

    const pending = acquireWakeLock('slideshow');
    await releaseWakeLock('slideshow');
    resolveRequest({ released: false, release });
    await pending;

    expect(release).toHaveBeenCalledOnce();
  });

  it('never rejects when the browser refuses to release', async () => {
    release.mockImplementationOnce(() => Promise.reject(new Error('already released')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { acquireWakeLock, releaseWakeLock } = await import('./wakelock.svelte');

    await acquireWakeLock('slideshow');
    await expect(releaseWakeLock('slideshow')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
