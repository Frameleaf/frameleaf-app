import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { ServerBinding } from './api';
import type { MediaOperationView } from './media-api';
import type { MediaLibrary } from './media-runner';

let queue: typeof import('./media-queue');
let runner: typeof import('./media-runner');
let failure: typeof import('./media-api').LibraryFailure;
const binding: ServerBinding = {
  serverId: 'server-one',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example',
};
const INSPECTION = '0190a000-0000-7000-8000-000000000001';
const ITEM = '0190a000-0000-7000-8000-000000000002';
const ALBUM = '33333333-3333-4333-8333-333333333333';
const REMOTE = '0190a000-0000-7000-8000-0000000000aa';
const download = (overrides = {}) => ({
  kind: 'download' as const,
  binding,
  label: 'A clip',
  request: {
    inspectionId: INSPECTION,
    itemIds: [ITEM],
    albumId: ALBUM,
    tagIds: [],
    overrideSuppression: false,
    ...overrides,
  },
});
const remote = (
  state: MediaOperationView['state'],
  overrides: Partial<MediaOperationView> = {},
): MediaOperationView => ({
  id: REMOTE,
  state,
  kind: 'item',
  provider: 'example',
  creator: null,
  complete: true,
  limitation: null,
  error: null,
  albumId: ALBUM,
  items: [],
  discovered: 1,
  saved: 0,
  skipped: 0,
  failed: 0,
  ...overrides,
});
const api = () =>
  ({
    startDownload: vi.fn().mockResolvedValue(remote('queued')),
    subscribe: vi.fn(),
    readOperation: vi.fn().mockResolvedValue(remote('downloading')),
    cancelDownload: vi.fn().mockResolvedValue(remote('cancelled')),
    retryDownload: vi.fn().mockResolvedValue(remote('queued')),
  }) satisfies MediaLibrary;
const live = new AbortController().signal;
/** The browser stopped the extension and started it again: fresh code, the same database. */
async function restart() {
  vi.resetModules();
  queue = await import('./media-queue');
  runner = await import('./media-runner');
  failure = (await import('./media-api')).LibraryFailure;
}
beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  await restart();
});

describe('media receipts in the saving list (FL-1427)', () => {
  it('keeps a request before it is sent, and still has it after the extension restarts', async () => {
    const added = await queue.addMediaReceipt(download());
    expect(added.state).toBe('submitting');

    await restart();

    expect(await queue.listMediaReceipts(binding)).toEqual([
      expect.objectContaining({
        id: added.id,
        state: 'submitting',
        label: 'A clip',
        binding,
      }),
    ]);
  });

  it('joins the saving list an earlier version made, without touching what is waiting in it', async () => {
    // the database as the version before media downloads left it, with one item waiting
    vi.stubGlobal('indexedDB', new IDBFactory());
    await new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('frameleaf-captures-v1', 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('tasks', { keyPath: 'id' });
        opening.result.createObjectStore('blobs', { keyPath: 'id' });
        opening.result.createObjectStore('meta').put(0, 'bytes');
      };
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const tx = opening.result.transaction('tasks', 'readwrite');
        tx.objectStore('tasks').put({ id: 'waiting', marker: true });
        tx.oncomplete = () => {
          opening.result.close();
          resolve();
        };
      };
    });
    await restart();

    await queue.addMediaReceipt(download());

    expect(await queue.listMediaReceipts(binding)).toHaveLength(1);
    const kept = await new Promise<unknown>((resolve) => {
      const opening = indexedDB.open('frameleaf-captures-v1');
      opening.onsuccess = () => {
        const read = opening.result
          .transaction('tasks')
          .objectStore('tasks')
          .get('waiting');
        read.onsuccess = () => {
          opening.result.close();
          resolve(read.result);
        };
      };
    });
    expect(kept).toEqual({ id: 'waiting', marker: true });
  });

  it('holds only ids and choices: no address, cookie or media', async () => {
    const added = await queue.addMediaReceipt({
      ...download(),
      // anything extra a caller passes is not kept
      ...({
        cookies: [{ value: 'cookie-secret' }],
        url: 'https://v.example/?t=1',
      } as object),
    });
    expect(Object.keys(added).sort()).toEqual(
      [
        'albumId',
        'attempts',
        'binding',
        'createdAt',
        'discovered',
        'failed',
        'id',
        'kind',
        'label',
        'request',
        'saved',
        'skipped',
        'state',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect(JSON.stringify(await queue.listMediaReceipts(binding))).not.toMatch(
      /cookie-secret|v\.example/,
    );
  });

  it('hands the request to the Library with the receipt’s own key, then follows it', async () => {
    const added = await queue.addMediaReceipt(download());
    const library = api();

    await expect(
      runner.syncMediaReceipts(binding, 'key', live, library),
    ).resolves.toBe(true);

    expect(library.startDownload).toHaveBeenCalledWith(binding, 'key', {
      inspectionId: INSPECTION,
      itemIds: [ITEM],
      albumId: ALBUM,
      tagIds: [],
      overrideSuppression: false,
      streamMp4: false,
      idempotencyKey: added.id,
    });
    expect(await queue.listMediaReceipts(binding)).toEqual([
      expect.objectContaining({ remoteId: REMOTE, state: 'active' }),
    ]);

    library.readOperation.mockResolvedValue(remote('saved', { saved: 1 }));
    await expect(
      runner.syncMediaReceipts(binding, 'key', live, library),
    ).resolves.toBe(false);
    expect(library.startDownload).toHaveBeenCalledTimes(1);
    expect(await queue.listMediaReceipts(binding)).toEqual([
      expect.objectContaining({ state: 'saved', saved: 1, albumId: ALBUM }),
    ]);
  });

  it('sends an unconfirmed request again with the same key, even across a restart', async () => {
    const added = await queue.addMediaReceipt(download());
    const library = api();
    // the request left, and the browser closed before the answer came back
    library.startDownload.mockRejectedValueOnce(new failure('unreachable'));
    await runner.syncMediaReceipts(binding, 'key', live, library);
    expect(await queue.listMediaReceipts(binding)).toEqual([
      expect.objectContaining({ state: 'submitting', attempts: 1 }),
    ]);

    await restart();
    await runner.syncMediaReceipts(binding, 'key', live, library);

    const keys = library.startDownload.mock.calls.map(
      ([, , dto]) => (dto as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual([added.id, added.id]);
    expect(await queue.listMediaReceipts(binding)).toEqual([
      expect.objectContaining({
        remoteId: REMOTE,
        state: 'active',
        attempts: 2,
      }),
    ]);
  });

  it('a Library that refuses for good is not asked again', async () => {
    await queue.addMediaReceipt(download());
    const library = api();
    library.startDownload.mockRejectedValue(new failure('refused', 400));

    await runner.syncMediaReceipts(binding, 'key', live, library);
    await runner.syncMediaReceipts(binding, 'key', live, library);

    expect(library.startDownload).toHaveBeenCalledTimes(1);
    expect(await queue.listMediaReceipts(binding)).toEqual([
      expect.objectContaining({ state: 'failed' }),
    ]);
  });

  it('follows the same account’s work after this browser signs in again, with the new key', async () => {
    await queue.addMediaReceipt(download());
    const library = api();
    await runner.syncMediaReceipts(binding, 'old-key', live, library);
    // signing in again (or allowing media downloads) gives this browser a new access
    const again = {
      ...binding,
      credentialId: '44444444-4444-4444-8444-444444444444',
    };

    await runner.syncMediaReceipts(again, 'new-key', live, library);

    expect(library.readOperation).toHaveBeenLastCalledWith(
      again,
      'new-key',
      REMOTE,
    );
    // the receipt still says which access made it
    expect((await queue.listMediaReceipts(again))[0].binding).toEqual(binding);
  });

  it('never lists, follows or changes a receipt for another account or server', async () => {
    const added = await queue.addMediaReceipt(download());
    const library = api();
    for (const other of [
      { ...binding, userId: '99999999-9999-4999-8999-999999999999' },
      { ...binding, serverId: 'server-two' },
      { ...binding, origin: 'https://elsewhere.example' },
    ]) {
      expect(await queue.listMediaReceipts(other)).toEqual([]);
      await runner.syncMediaReceipts(other, 'key', live, library);
      await expect(queue.requestMediaCancel(added.id, other)).rejects.toThrow();
    }
    expect(library.startDownload).not.toHaveBeenCalled();
    expect((await queue.listMediaReceipts(binding))[0].state).toBe(
      'submitting',
    );
  });

  it('Cancel before anything was sent just forgets it; after, the Library is asked', async () => {
    const unsent = await queue.addMediaReceipt(download());
    const library = api();
    await queue.requestMediaCancel(unsent.id, binding);
    await runner.syncMediaReceipts(binding, 'key', live, library);
    expect(library.startDownload).not.toHaveBeenCalled();
    expect(library.cancelDownload).not.toHaveBeenCalled();
    expect((await queue.listMediaReceipts(binding))[0].state).toBe('cancelled');

    const sent = await queue.addMediaReceipt(download());
    await runner.syncMediaReceipts(binding, 'key', live, library);
    await queue.requestMediaCancel(sent.id, binding);
    await runner.syncMediaReceipts(binding, 'key', live, library);
    expect(library.cancelDownload).toHaveBeenCalledWith(binding, 'key', REMOTE);
    expect((await queue.listMediaReceipts(binding))[0]).toEqual(
      expect.objectContaining({ id: sent.id, state: 'cancelled' }),
    );
    expect((await queue.listMediaReceipts(binding))[0]).not.toHaveProperty(
      'cancelRequested',
    );
  });

  it('Retry pressed twice, or sent twice, is one retry', async () => {
    const added = await queue.addMediaReceipt(download());
    const library = api();
    library.readOperation.mockResolvedValue(remote('partial', { failed: 1 }));
    await runner.syncMediaReceipts(binding, 'key', live, library);
    await runner.syncMediaReceipts(binding, 'key', live, library);

    const first = await queue.requestMediaRetry(added.id, binding);
    const second = await queue.requestMediaRetry(added.id, binding);
    expect(second.retryKey).toBe(first.retryKey);

    library.retryDownload.mockRejectedValueOnce(new failure('unreachable'));
    await runner.syncMediaReceipts(binding, 'key', live, library);
    await restart();
    await runner.syncMediaReceipts(binding, 'key', live, library);

    expect(library.retryDownload.mock.calls.map((call) => call[3])).toEqual([
      first.retryKey,
      first.retryKey,
    ]);
    expect((await queue.listMediaReceipts(binding))[0]).toEqual(
      expect.objectContaining({ state: 'active' }),
    );
    expect((await queue.listMediaReceipts(binding))[0]).not.toHaveProperty(
      'retryKey',
    );
  });

  it('losing permission for media leaves the work with the Library and says how to see it again', async () => {
    await queue.addMediaReceipt(download());
    const library = api();
    await runner.syncMediaReceipts(binding, 'key', live, library);
    library.readOperation.mockRejectedValue(new failure('grant', 403));

    await expect(
      runner.syncMediaReceipts(binding, 'key', live, library),
    ).resolves.toBe(true);

    expect((await queue.listMediaReceipts(binding))[0]).toEqual(
      expect.objectContaining({
        state: 'active',
        remoteId: REMOTE,
        error: expect.stringContaining('Allow media downloads again'),
      }),
    );
  });

  it('a subscription always carries the history you chose, and is created once', async () => {
    await expect(
      queue.addMediaReceipt({
        kind: 'subscription',
        binding,
        label: 'Creator',
        request: { inspectionId: INSPECTION, intervalMinutes: 60 } as never,
      }),
    ).rejects.toThrow();
    const added = await queue.addMediaReceipt({
      kind: 'subscription',
      binding,
      label: 'Creator',
      request: {
        inspectionId: INSPECTION,
        history: { mode: 'new' },
        intervalMinutes: 60,
      },
    });
    const library = api();
    library.subscribe.mockResolvedValue({
      id: REMOTE,
      creator: 'Someone',
      provider: 'example',
      albumId: ALBUM,
    });

    await expect(
      runner.syncMediaReceipts(binding, 'key', live, library),
    ).resolves.toBe(false);
    await runner.syncMediaReceipts(binding, 'key', live, library);

    expect(library.subscribe).toHaveBeenCalledTimes(1);
    expect(library.subscribe).toHaveBeenCalledWith(binding, 'key', {
      inspectionId: INSPECTION,
      history: { mode: 'new' },
      intervalMinutes: 60,
      idempotencyKey: added.id,
    });
    expect((await queue.listMediaReceipts(binding))[0]).toEqual(
      expect.objectContaining({
        state: 'subscribed',
        label: 'Someone · example',
        albumId: ALBUM,
      }),
    );
  });

  it('restoring something you removed is off unless you chose it', async () => {
    const plain = await queue.addMediaReceipt(
      download({ overrideSuppression: undefined }),
    );
    expect(
      (plain.request as { overrideSuppression: boolean }).overrideSuppression,
    ).toBe(false);
  });
});
