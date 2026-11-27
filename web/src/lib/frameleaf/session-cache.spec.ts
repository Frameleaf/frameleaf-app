import { sessionCache } from '$lib/frameleaf/session-cache';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** FL-1802 */
describe('sessionCache', () => {
  afterEach(() => vi.useRealTimers());

  it('asks once for readers at the same moment and for later ones', async () => {
    const load = vi.fn().mockResolvedValue(['a']);
    const cache = sessionCache(load);
    await expect(Promise.all([cache.get(), cache.get()])).resolves.toEqual([['a'], ['a']]);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps each key its own answer', async () => {
    const load = vi.fn((key: string) => Promise.resolve(key.toUpperCase()));
    const cache = sessionCache(load);
    await expect(cache.get('library')).resolves.toBe('LIBRARY');
    await expect(cache.get('boards')).resolves.toBe('BOARDS');
    cache.invalidate('boards');
    await cache.get('library');
    await cache.get('boards');
    expect(load.mock.calls.map(([key]) => key)).toEqual(['library', 'boards', 'boards']);
  });

  it('asks again after a change made here, and never keeps a failed read', async () => {
    const load = vi.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(3);
    const cache = sessionCache(load);
    await cache.get();
    cache.invalidate();
    await expect(cache.get()).rejects.toThrow('offline');
    await expect(cache.get()).resolves.toBe(3);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it.each(['SessionLocked', 'AuthLogout'] as const)('drops what it holds on %s', async (event) => {
    const load = vi.fn().mockResolvedValue('answer');
    const cache = sessionCache(load);
    await cache.get();
    eventManager.emit(event);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('asks again once the answer is older than its lifetime', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue('answer');
    const cache = sessionCache(load, 1000);
    await cache.get();
    vi.advanceTimersByTime(1000);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
