import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bufferLimit,
  downloadManager as downloads,
  holdOrStream,
  StreamedDownload,
} from '$lib/managers/download-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

const pending = () => downloads.start({ name: 'photo.jpg' }, () => new Promise<Blob>(() => {}));
beforeEach(() => downloads.clearAll());
afterEach(() => downloads.clearAll());

describe('download reservations', () => {
  it.each([NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid byte counts %s without corrupting later admission',
    (bytes) => {
      const key = pending();
      expect(downloads.reserve(key, bytes)).toBe(false);
      expect(downloads.reservedBytes()).toBe(0);
      expect(downloads.reserve(key, 1)).toBe(true);
      expect(downloads.reservedBytes()).toBe(1);
    },
  );

  it('keeps reservations monotonic, excludes the current row, and releases only once', () => {
    const first = pending();
    const second = pending();
    expect(downloads.reserve(first, 20)).toBe(true);
    expect(downloads.reserve(second, 30)).toBe(true);
    expect(downloads.reserve(first, 5)).toBe(true);
    expect(downloads.reservedBytes()).toBe(50);
    expect(downloads.reservedBytes(first)).toBe(30);
    expect(downloads.reservedBytes(second)).toBe(20);
    expect(downloads.reservedBytes('missing')).toBe(50);
    expect(downloads.reserve(first, 40)).toBe(true);
    expect(downloads.reservedBytes()).toBe(70);
    downloads.release(first);
    downloads.release(first);
    expect(downloads.reservedBytes()).toBe(30);
    downloads.cancel(second);
    expect(downloads.reservedBytes()).toBe(0);
  });

  it('admits exactly the remaining capacity without allocating a large file', async () => {
    const held = downloads.start({ name: 'held.jpg' }, async () => new Blob(['abc']));
    await downloads.settled(held);
    const first = pending();
    const second = pending();
    expect(downloads.reserve(first, bufferLimit() - 3)).toBe(true);
    expect(downloads.reserve(second, 1)).toBe(false);
    expect(downloads.reserve(first, bufferLimit() - 2)).toBe(false);
    expect(downloads.heldBytes() + downloads.reservedBytes()).toBe(bufferLimit());
    downloads.remove(held);
    expect(downloads.reserve(second, 3)).toBe(true);
    expect(downloads.reservedBytes()).toBe(bufferLimit());
  });

  it('releases completed and failed reservations before retrying', async () => {
    const ready = downloads.start({ name: 'ready.jpg' }, async ({ key }) => {
      expect(downloads.reserve(key, 3)).toBe(true);
      return new Blob(['abc']);
    });
    await downloads.settled(ready);
    expect(downloads.reservedBytes()).toBe(0);
    expect(downloads.heldBytes()).toBe(3);
    let attempt = 0;
    const flaky = downloads.start({ name: 'flaky.jpg' }, async ({ key }) => {
      expect(downloads.reserve(key, 5)).toBe(true);
      if (attempt++ === 0) {
        throw new Error('offline');
      }
      return new Blob(['ok']);
    });
    await expect(downloads.settled(flaky)).rejects.toThrow('offline');
    expect(downloads.reservedBytes()).toBe(0);
    downloads.retry(flaky);
    await downloads.settled(flaky);
    expect(downloads.reservedBytes()).toBe(0);
    expect(downloads.heldBytes()).toBe(5);
  });

  it('forgets a reservation whose public row was removed before clearAll', () => {
    const key = pending();
    expect(downloads.reserve(key, 10)).toBe(true);
    downloads.assets.delete(key);
    try {
      downloads.clearAll();
      expect(downloads.reservedBytes()).toBe(0);
    } finally {
      downloads.release(key);
    }
  });

  it('aborts and releases all pending budgets on logout', async () => {
    const signals: AbortSignal[] = [];
    const keys = [10, 20].map((bytes) =>
      downloads.start({ name: 'private.jpg' }, ({ key, signal }) => {
        signals.push(signal);
        downloads.reserve(key, bytes);
        return new Promise<Blob>(() => {});
      }),
    );
    const outcomes = keys.map((key) => downloads.settled(key).catch((error: unknown) => error));
    eventManager.emit('AuthLogout');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(downloads.assets.size).toBe(0);
    expect(downloads.reservedBytes()).toBe(0);
    expect(await Promise.all(outcomes)).toEqual([
      expect.objectContaining({ name: 'AbortError' }),
      expect.objectContaining({ name: 'AbortError' }),
    ]);
  });

  it('streams an invalid planned size before requesting or holding a response', async () => {
    let requests = 0;
    const stream = new StreamedDownload(() => {});
    const key = downloads.start({ name: 'unknown.jpg' }, (context) =>
      holdOrStream(context, {
        size: NaN,
        stream,
        request: async () => {
          requests++;
          return new Blob(['bytes']);
        },
      }),
    );
    await downloads.settled(key);
    expect(requests).toBe(0);
    expect(downloads.assets.get(key)).toMatchObject({ status: 'ready', buffered: false });
    expect(downloads.reservedBytes()).toBe(0);
    expect(downloads.heldBytes()).toBe(0);
  });
});
