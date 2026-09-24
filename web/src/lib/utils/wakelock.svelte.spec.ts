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
});
