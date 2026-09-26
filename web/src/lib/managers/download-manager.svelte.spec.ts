import {
  downloadManager,
  progressFetch,
  StreamedDownload,
  type DownloadContext,
} from '$lib/managers/download-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

/**
 * FL-45 D-1…D-3: the download manager runs real requests with a status, progress, a true Cancel
 * (the request's AbortController) and Retry. Tasks here stand in for the SDK calls.
 */

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const deferred = () => {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Blob>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const only = () => {
  const entries = [...downloadManager.assets.entries()];
  expect(entries).toHaveLength(1);
  return entries[0];
};

beforeEach(() => {
  downloadManager.clearAll();
});

describe('downloadManager', () => {
  it('shows a new download as preparing, then ready with its file', async () => {
    const pending = deferred();
    downloadManager.start({ name: 'trip.zip', assetIds: ['a', 'b'], total: 100 }, () => pending.promise);

    const [key, preparing] = only();
    expect(preparing).toMatchObject({ status: 'preparing', progress: 0, count: 2, archiveName: 'trip' });
    expect(downloadManager.summary).toMatchObject({ preparing: 1, ready: 0, active: true });

    pending.resolve(new Blob(['zip']));
    await flush();

    expect(downloadManager.assets.get(key)).toMatchObject({ status: 'ready', progress: 100 });
    expect(downloadManager.file(key)).toBeInstanceOf(Blob);
    expect(downloadManager.summary).toMatchObject({ preparing: 0, ready: 1, active: false });
  });

  it('reports progress in whole percent and never 100% before the file is complete', async () => {
    let context!: DownloadContext;
    downloadManager.start({ name: 'a.jpg', total: 200 }, (ctx) => {
      context = ctx;
      return new Promise<Blob>(() => {});
    });
    const [key] = only();

    context.onProgress({ received: 101 });
    expect(downloadManager.assets.get(key)?.progress).toBe(50);

    context.onProgress({ received: 500, total: 400 });
    expect(downloadManager.assets.get(key)).toMatchObject({ progress: 99, total: 400 });
  });

  it('aborts the request when a preparing download is cancelled', async () => {
    let signal!: AbortSignal;
    downloadManager.start({ name: 'big.zip' }, (context) => {
      signal = context.signal;
      return new Promise<Blob>(() => {});
    });
    const [key] = only();

    downloadManager.cancel(key);

    expect(signal.aborted).toBe(true);
    expect(downloadManager.assets.size).toBe(0);
  });

  it('keeps a failed download as an error row that can be retried', async () => {
    let attempt = 0;
    downloadManager.start({ name: 'flaky.jpg' }, () => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(new Blob(['ok']));
    });
    await flush();
    const [key, failed] = only();
    expect(failed.status).toBe('error');
    expect(failed.error).toBeInstanceOf(Error);

    downloadManager.retry(key);
    expect(downloadManager.assets.get(key)?.status).toBe('preparing');
    await flush();

    expect(attempt).toBe(2);
    expect(downloadManager.assets.get(key)?.status).toBe('ready');
  });

  it('does not turn an aborted request into an error row', async () => {
    const pending = deferred();
    downloadManager.start({ name: 'x.zip' }, () => pending.promise);
    const [key] = only();

    downloadManager.cancel(key);
    pending.reject(new DOMException('aborted', 'AbortError'));
    await flush();

    expect(downloadManager.assets.size).toBe(0);
  });

  it('saves a ready file and removes its row', async () => {
    downloadManager.start({ name: 'photo.jpg' }, () => Promise.resolve(new Blob(['jpg'])));
    await flush();
    const [key] = only();
    const saveFile = vi.fn();

    expect(downloadManager.save(key, saveFile)).toBe(true);

    expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), 'photo.jpg');
    expect(downloadManager.assets.size).toBe(0);
  });

  it('aborts every request and forgets every name on clearAll (session lock)', async () => {
    const signals: AbortSignal[] = [];
    for (const name of ['locked-1.jpg', 'locked-2.jpg']) {
      downloadManager.start({ name }, ({ signal }) => {
        signals.push(signal);
        return new Promise<Blob>(() => {});
      });
    }
    downloadManager.start({ name: 'ready.jpg' }, () => Promise.resolve(new Blob(['x'])));
    await flush();

    downloadManager.clearAll();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(downloadManager.assets.size).toBe(0);
  });

  it('lets a task describe its row once it knows what it is downloading', async () => {
    downloadManager.start({ name: 'album.zip' }, ({ describe }) => {
      describe({ name: 'album+1.zip', count: 3, total: 30, assetIds: ['a', 'b', 'c'] });
      return new Promise<Blob>(() => {});
    });

    expect(only()[1]).toMatchObject({ name: 'album+1.zip', archiveName: 'album+1', count: 3, total: 30 });
  });
});

describe('downloadManager (review B1, B2, M3)', () => {
  it('aborts every request and forgets every row and name on logout (B2)', async () => {
    let signal!: AbortSignal;
    downloadManager.start({ name: 'private.jpg' }, (context) => {
      signal = context.signal;
      return new Promise<Blob>(() => {});
    });
    downloadManager.start({ name: 'ready.jpg' }, () => Promise.resolve(new Blob(['x'])));
    await flush();

    eventManager.emit('AuthLogout');

    expect(signal.aborted).toBe(true);
    expect(downloadManager.assets.size).toBe(0);
    expect(downloadManager.hasUnsavedFiles).toBe(false);
  });

  it('marks only a buffered ready file as unsaved', async () => {
    const start = vi.fn();
    const streamed = downloadManager.start({ name: 'big.zip' }, () => Promise.resolve(new StreamedDownload(start)));
    await flush();
    expect(downloadManager.hasUnsavedFiles).toBe(false);

    downloadManager.start({ name: 'small.jpg' }, () => Promise.resolve(new Blob(['x'])));
    await flush();
    expect(downloadManager.hasUnsavedFiles).toBe(true);

    const saveFile = vi.fn();
    expect(downloadManager.save(streamed, saveFile)).toBe(true);
    expect(start).toHaveBeenCalledWith('big.zip');
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('settles a row: resolved when ready, rejected with its error, AbortError when cancelled', async () => {
    const ok = downloadManager.start({ name: 'a.jpg' }, () => Promise.resolve(new Blob(['x'])));
    await expect(downloadManager.settled(ok)).resolves.toBeUndefined();

    const bad = downloadManager.start({ name: 'b.jpg' }, () => Promise.reject(new Error('offline')));
    await expect(downloadManager.settled(bad)).rejects.toThrow('offline');

    const slow = downloadManager.start({ name: 'c.jpg' }, () => new Promise<Blob>(() => {}));
    const waiting = downloadManager.settled(slow);
    downloadManager.cancel(slow);
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not reserve room for a row that was removed', () => {
    const key = downloadManager.start({ name: 'a.jpg' }, () => new Promise<Blob>(() => {}));
    expect(downloadManager.reserve(key, 10)).toBe(true);

    downloadManager.remove(key);

    expect(downloadManager.reserve(key, 10)).toBe(false);
    expect(downloadManager.reservedBytes()).toBe(0);
  });

  it('keeps share rows out of the Downloads panel', () => {
    downloadManager.start({ name: 'share.zip', group: 'share' }, () => new Promise<Blob>(() => {}));
    downloadManager.start({ name: 'mine.zip' }, () => new Promise<Blob>(() => {}));

    expect(downloadManager.panelRows.map(([, download]) => download.name)).toEqual(['mine.zip']);
    expect(downloadManager.rows('share').map(([, download]) => download.name)).toEqual(['share.zip']);
    expect(downloadManager.summary.preparing).toBe(1);
  });
});

describe('progressFetch', () => {
  it('reports the bytes the response body delivers', async () => {
    const onProgress = vi.fn();
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetcher = vi.fn(async () => new Response(body, { headers: { 'content-length': '4' } }));

    const response = await progressFetch(onProgress, fetcher as typeof fetch)('/x');
    const blob = await response.blob();

    expect(blob.size).toBe(4);
    expect(onProgress).toHaveBeenLastCalledWith({ received: 4, total: 4 });
  });

  it('passes a failed response through untouched', async () => {
    const onProgress = vi.fn();
    const failed = new Response('nope', { status: 401 });
    const fetcher = vi.fn(async () => failed);

    expect(await progressFetch(onProgress, fetcher as typeof fetch)('/x')).toBe(failed);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
