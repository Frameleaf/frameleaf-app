import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { ServerBinding } from './api';
let queue: typeof import('./queue');
const binding: ServerBinding = {
  serverId: 'server-one',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example/subpath',
};
const albumId = '33333333-3333-4333-8333-333333333333';
const source = {
  pageUrl: 'https://page.example/work?private=1#fragment',
  mediaUrl: 'https://images.example/photo.png?signature=secret',
  title: 'Reference',
  capturedAt: '2026-10-28T12:00:00.000Z',
};
const file = () => ({
  binding,
  albumId,
  tagIds: [],
  source,
  note: 'Reference note',
  file: {
    blob: new Blob(['abc'], { type: 'image/png' }),
    filename: 'reference.png',
  },
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', {
    storage: {
      estimate: vi
        .fn()
        .mockResolvedValue({ quota: 1024 * 1024 * 1024, usage: 0 }),
    },
  });
  queue = await import('./queue');
});
afterEach(() => vi.useRealTimers());
describe('durable capture queue', () => {
  it('bounds completed local history without deleting pending originals or other accounts', async () => {
    const original = await queue.enqueueCapture(file());
    const bookmark = await queue.enqueueCapture({
      binding,
      albumId,
      tagIds: [],
      source,
      bookmark: { title: 'Reference', url: 'https://page.example/' },
    });
    const [{ name }] = await indexedDB.databases();
    const database = await new Promise<IDBDatabase>((resolve) => {
      const opening = indexedDB.open(name!);
      opening.onsuccess = () => resolve(opening.result);
    });
    const tx = database.transaction('tasks', 'readwrite');
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    const ids: string[] = [];
    for (let i = 0; i < 202; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      tx.objectStore('tasks').put({
        ...bookmark,
        id,
        captureId: id,
        state: 'cancelled',
        updatedAt: i,
      });
    }
    const otherId = crypto.randomUUID();
    const otherBinding = { ...binding, userId: albumId };
    tx.objectStore('tasks').put({
      ...bookmark,
      id: otherId,
      captureId: otherId,
      binding: otherBinding,
      state: 'cancelled',
      updatedAt: 0,
    });
    // A damaged terminal record must not orphan its retained original.
    tx.objectStore('tasks').put({
      ...original,
      state: 'cancelled',
      updatedAt: 0,
    });
    await committed;
    database.close();
    await queue.pruneCaptureHistory(binding);
    const remaining = await queue.listCaptures(binding);
    expect(remaining).toHaveLength(202);
    expect(remaining.map((task) => task.id)).not.toContain(ids[0]);
    expect(remaining.map((task) => task.id)).not.toContain(ids[1]);
    expect(remaining).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original.id }),
        expect.objectContaining({ id: bookmark.id, state: 'queued' }),
      ]),
    );
    expect(await (await queue.captureBlob(original.id))?.text()).toBe('abc');
    expect(await queue.listCaptures(otherBinding)).toHaveLength(1);
    await queue.cancelQueuedCapture(bookmark.id, binding, 1000);
    expect(await queue.listCaptures(binding)).toHaveLength(201);
    expect(
      (await queue.listCaptures(binding)).map((task) => task.id),
    ).not.toContain(ids[2]);
    expect(await (await queue.captureBlob(original.id))?.text()).toBe('abc');
  });
  it('persists cancellation intent without stealing a claim or dropping originals', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'worker', 1000);
    await expect(
      queue.requestCaptureCancellation(
        task.id,
        { ...binding, userId: albumId },
        1001,
      ),
    ).rejects.toThrow();
    await queue.requestCaptureCancellation(task.id, binding, 1001);
    vi.resetModules();
    queue = await import('./queue');
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      cancelRequested: true,
      claim: { owner: 'worker' },
      phase: 'upload',
    });
    expect(await (await queue.captureBlob(task.id))?.text()).toBe('abc');
    await expect(
      queue.saveCaptureProgress(
        task.id,
        'worker',
        { state: 'committing', offset: 3 },
        1002,
      ),
    ).rejects.toMatchObject({ code: 'cancel' });
    await queue.finishCaptureCancellation(
      task.id,
      'worker',
      { captureId: task.id, status: 'cancelled' },
      1003,
    );
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      state: 'cancelled',
      cancellationReceipt: { captureId: task.id, status: 'cancelled' },
    });
    expect(
      (await queue.listCaptures(binding))[0].cancelRequested,
    ).toBeUndefined();
    expect(await queue.captureBlob(task.id)).toBeNull();
    await expect(
      queue.finishCaptureCancellation(
        task.id,
        'worker',
        { captureId: task.id, status: 'cancelled' },
        1004,
      ),
    ).rejects.toMatchObject({ code: 'claim' });
  });
  it('retains bytes for mismatched, contradictory and stale cancellation receipts', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'worker', 1000);
    await queue.requestCaptureCancellation(task.id, binding, 1001);
    const receipt = {
      captureId: task.id,
      status: 'created' as const,
      kind: 'asset' as const,
      itemId: albumId,
    };
    for (const outcome of [
      { captureId: albumId, status: 'cancelled' },
      { captureId: task.id, status: 'cancelled', receipt },
      {
        captureId: task.id,
        status: 'already-published',
        receipt: { ...receipt, captureId: albumId },
      },
      {
        captureId: task.id,
        status: 'already-published',
        receipt: { ...receipt, kind: 'bookmark' },
      },
    ])
      await expect(
        queue.finishCaptureCancellation(
          task.id,
          'worker',
          outcome as never,
          1002,
        ),
      ).rejects.toThrow();
    await expect(
      queue.finishCaptureCancellation(
        task.id,
        'stale',
        { captureId: task.id, status: 'cancelled' },
        1002,
      ),
    ).rejects.toMatchObject({ code: 'claim' });
    expect(await queue.captureBlob(task.id)).not.toBeNull();
    expect((await queue.listCaptures(binding))[0].cancelRequested).toBe(true);
  });
  it('records the exact server outcome when publication wins cancellation', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'worker', 1000);
    await queue.requestCaptureCancellation(task.id, binding, 1001);
    const receipt = {
      captureId: task.id,
      status: 'duplicate' as const,
      kind: 'asset' as const,
      itemId: albumId,
    };
    await queue.finishCaptureCancellation(
      task.id,
      'worker',
      { captureId: task.id, status: 'already-published', receipt },
      1002,
    );
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      state: 'duplicate',
      phase: 'commit',
      offset: 3,
      receipt,
    });
    expect(
      (await queue.listCaptures(binding))[0].cancelRequested,
    ).toBeUndefined();
    expect(await queue.captureBlob(task.id)).toBeNull();
  });
  it('accepts an in-flight verified receipt after cancellation intent arrives', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'worker', 1000);
    await queue.saveCaptureProgress(
      task.id,
      'worker',
      { state: 'committing', offset: 3 },
      1001,
    );
    await queue.requestCaptureCancellation(task.id, binding, 1002);
    await queue.finishCapture(
      task.id,
      'worker',
      { captureId: task.id, status: 'created', kind: 'asset', itemId: albumId },
      1003,
    );
    expect((await queue.listCaptures(binding))[0].state).toBe('saved');
    expect(
      (await queue.listCaptures(binding))[0].cancelRequested,
    ).toBeUndefined();
  });
  it('keeps cancellation intent and backoff across retries and repeated requests', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'worker', 1000);
    await queue.deferCapture(
      task.id,
      'worker',
      { kind: 'retry', retryAt: 50000, message: 'Wait' },
      1001,
    );
    await queue.requestCaptureCancellation(task.id, binding, 1002);
    await queue.requestCaptureCancellation(task.id, binding, 1003);
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      cancelRequested: true,
      retryAt: 50000,
    });
    await queue.retryCapture(task.id, binding, 50001);
    expect((await queue.listCaptures(binding))[0].cancelRequested).toBe(true);
  });
  it('confirms bookmark cancellation without fabricating a saved item', async () => {
    const task = await queue.enqueueCapture({
      binding,
      albumId,
      source,
      bookmark: { url: 'https://page.example/?v=1#part', title: 'Reference' },
    });
    await queue.claimCapture(binding, 'worker', 1000);
    await queue.requestCaptureCancellation(task.id, binding, 1001);
    await queue.finishCaptureCancellation(
      task.id,
      'worker',
      { captureId: task.id, status: 'cancelled' },
      1002,
    );
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      state: 'cancelled',
      bookmark: { url: 'https://page.example/?v=1#part' },
    });
    expect((await queue.listCaptures(binding))[0].receipt).toBeUndefined();
  });
  it('reports an unproven stored cancellation instead of hiding an attempted capture', async () => {
    const original = await queue.enqueueCapture(file());
    const task = (await queue.claimCapture(binding, 'worker'))!;
    task.state = 'cancelled';
    delete task.claim;
    const [{ name }] = await indexedDB.databases();
    const database = await new Promise<IDBDatabase>((resolve) => {
      const opening = indexedDB.open(name!);
      opening.onsuccess = () => resolve(opening.result);
    });
    const tx = database.transaction('tasks', 'readwrite');
    const committed = new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    tx.objectStore('tasks').put(task);
    await committed;
    database.close();
    await expect(queue.listCaptures(binding)).rejects.toThrow('damaged');
    expect(await queue.captureBlob(original.id)).not.toBeNull();
  });
  it('commits stable UUID, checksum and bytes together, strips transient attribution and never stores a credential', async () => {
    const input = file();
    Object.assign(input.binding, { token: 'never-store-this' });
    const task = await queue.enqueueCapture(input);
    expect(task.captureId).toBe(task.id);
    expect(task.file).toMatchObject({
      size: 3,
      sha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      filename: 'reference.png',
    });
    expect(task.source).toMatchObject({
      pageUrl: 'https://page.example/work',
      mediaUrl: 'https://images.example/photo.png',
    });
    expect(task.state).toBe('queued');
    expect(await (await queue.captureBlob(task.id))?.text()).toBe('abc');
    expect(JSON.stringify(await queue.listCaptures(binding))).not.toContain(
      'never-store-this',
    );
    vi.resetModules();
    queue = await import('./queue');
    expect((await queue.listCaptures(binding))[0].captureId).toBe(
      task.captureId,
    );
    expect(await (await queue.captureBlob(task.id))?.text()).toBe('abc');
  });
  it('snapshots the exact metadata and Blob before hashing can yield to caller changes', async () => {
    const input = file();
    const bytes = Promise.withResolvers<ArrayBuffer>();
    vi.spyOn(input.file.blob, 'arrayBuffer').mockReturnValue(bytes.promise);
    const pending = queue.enqueueCapture(input);
    input.file.filename = '../changed.png';
    input.file.blob = new Blob(['changed']);
    bytes.resolve(new TextEncoder().encode('abc').buffer);
    const task = await pending;
    expect(task.file?.filename).toBe('reference.png');
    expect(await (await queue.captureBlob(task.id))?.text()).toBe('abc');
  });
  it('rolls back metadata, bytes and accounting when a Blob write fails', async () => {
    const original = IDBObjectStore.prototype.add;
    const failure = vi
      .spyOn(IDBObjectStore.prototype, 'add')
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === 'blobs')
          throw new DOMException(
            'Synthetic quota exceeded',
            'QuotaExceededError',
          );
        return original.call(this, value, key);
      });
    await expect(queue.enqueueCapture(file())).rejects.toThrow('space');
    failure.mockRestore();
    expect(await queue.listCaptures(binding)).toEqual([]);
    expect((await queue.enqueueCapture(file())).file?.size).toBe(3);
  });
  it('refuses a blocked/unavailable IDB open instead of acknowledging an indefinitely pending capture', async () => {
    vi.useFakeTimers();
    vi.spyOn(indexedDB, 'open').mockReturnValue({} as IDBOpenDBRequest);
    const refused = expect(
      queue.enqueueCapture({
        binding,
        albumId,
        source,
        bookmark: { url: 'https://example.com/', title: 'Reference' },
      }),
    ).rejects.toThrow('storage');
    await vi.advanceTimersByTimeAsync(5001);
    await refused;
  });
  it('reports a corrupted saved marker instead of showing success or discarding bytes', async () => {
    const task = await queue.enqueueCapture(file());
    const [{ name }] = await indexedDB.databases();
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open(name!);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const tx = database.transaction('tasks', 'readwrite');
    const committed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    tx.objectStore('tasks').put({ ...task, state: 'saved' });
    await committed;
    database.close();
    await expect(queue.listCaptures(binding)).rejects.toThrow('damaged');
    expect(await (await queue.captureBlob(task.id))?.text()).toBe('abc');
  });
  it('reports missing original bytes and lets the user cancel an unstarted damaged capture', async () => {
    const task = await queue.enqueueCapture(file());
    const [{ name }] = await indexedDB.databases();
    const database = await new Promise<IDBDatabase>((resolve) => {
      const opening = indexedDB.open(name!);
      opening.onsuccess = () => resolve(opening.result);
    });
    const tx = database.transaction('blobs', 'readwrite');
    const committed = new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    tx.objectStore('blobs').delete(task.id);
    await committed;
    database.close();
    expect(await queue.claimCapture(binding, 'worker')).toBeNull();
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      state: 'needs-attention',
      attempts: 0,
    });
    await queue.cancelQueuedCapture(task.id, binding);
    expect((await queue.listCaptures(binding))[0].state).toBe('cancelled');
  });
  it('stores bookmarks without file bytes, preserving target query but cleaning attribution', async () => {
    const task = await queue.enqueueCapture({
      binding,
      albumId,
      source,
      bookmark: {
        url: 'https://page.example/watch?v=123#part',
        title: 'Watch later',
      },
    });
    expect(task.bookmark?.url).toBe('https://page.example/watch?v=123#part');
    expect(await queue.captureBlob(task.id)).toBeNull();
  });
  it('keeps the capture time as written, with its UTC offset, and refuses one that is not ISO (FL-698)', async () => {
    const capturedAt = '2026-10-29T23:08:00.000-06:00';
    const task = await queue.enqueueCapture({
      ...file(),
      source: { ...source, capturedAt },
    });
    expect(task.source.capturedAt).toBe(capturedAt);
    await expect(
      queue.enqueueCapture({
        ...file(),
        source: { ...source, capturedAt: 'Oct 29 2026 23:08' },
      }),
    ).rejects.toThrow();
  });
  it('rejects invalid metadata and insufficient actual quota without acknowledging or retaining a task', async () => {
    for (const change of [
      { albumId: 'bad' },
      { tagIds: ['bad'] },
      { note: 'x'.repeat(20001) },
      { file: { blob: new Blob([]), filename: 'empty.png' } },
      { file: { blob: new Blob(['abc']), filename: '../unsafe.png' } },
    ])
      await expect(
        queue.enqueueCapture({ ...file(), ...change }),
      ).rejects.toThrow();
    vi.mocked(navigator.storage.estimate).mockResolvedValue({
      quota: 2,
      usage: 0,
    });
    await expect(queue.enqueueCapture(file())).rejects.toThrow('space');
    expect(await queue.listCaptures(binding)).toEqual([]);
  });
  it('enforces logical file and queue byte caps independently of browser quota estimates', () => {
    expect(() => queue.assertQueueCapacity(512 * 1024 * 1024 - 2, 3)).toThrow(
      '512 MB',
    );
    expect(() => queue.assertQueueCapacity(0, 100 * 1024 * 1024 + 1)).toThrow(
      '100 MB',
    );
    expect(() => queue.assertQueueCapacity(0, 3)).not.toThrow();
  });
  it('claims at most two captures across competing runners and excludes other destinations', async () => {
    const tasks = await Promise.all([
      queue.enqueueCapture(file()),
      queue.enqueueCapture(file()),
      queue.enqueueCapture(file()),
    ]);
    const claimed = await Promise.all([
      queue.claimCapture(binding, 'worker-a', 1000),
      queue.claimCapture(binding, 'worker-b', 1000),
      queue.claimCapture(binding, 'worker-c', 1000),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(2);
    expect(new Set(claimed.filter(Boolean).map((task) => task!.id)).size).toBe(
      2,
    );
    expect(
      await queue.claimCapture(
        { ...binding, userId: '44444444-4444-4444-8444-444444444444' },
        'other',
        1001,
      ),
    ).toBeNull();
    expect(
      await queue.listCaptures({ ...binding, origin: 'https://other.example' }),
    ).toEqual([]);
    expect(tasks).toHaveLength(3);
  });
  it('recovers an expired claim using the same capture UUID and refuses stale-owner writes', async () => {
    const task = await queue.enqueueCapture(file());
    expect((await queue.claimCapture(binding, 'old', 1000))?.id).toBe(task.id);
    const reclaimed = await queue.claimCapture(
      binding,
      'new',
      1000 + queue.CLAIM_MS,
    );
    expect(reclaimed?.captureId).toBe(task.captureId);
    await expect(
      queue.saveCaptureProgress(
        task.id,
        'old',
        { state: 'committing', offset: 3 },
        1000 + queue.CLAIM_MS + 1,
      ),
    ).rejects.toThrow('claim');
    expect(
      (
        await queue.saveCaptureProgress(
          task.id,
          'new',
          { state: 'committing', offset: 3 },
          1000 + queue.CLAIM_MS + 1,
        )
      ).state,
    ).toBe('committing');
  });
  it('never retargets tasks; reconnecting the original account may claim work for subsequent server actor checks', async () => {
    await queue.enqueueCapture(file());
    for (const change of [
      { serverId: 'other' },
      { userId: '44444444-4444-4444-8444-444444444444' },
      { origin: 'https://frameleaf.example/otherpath' },
    ])
      expect(
        await queue.claimCapture({ ...binding, ...change }, 'wrong', 1000),
      ).toBeNull();
    expect(
      await queue.claimCapture(
        { ...binding, credentialId: '55555555-5555-4555-8555-555555555555' },
        'reconnected',
        1000,
      ),
    ).not.toBeNull();
  });
  it('only lets the current upload claim reset an acknowledged offset', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'owner');
    await queue.saveCaptureProgress(task.id, 'owner', {
      state: 'uploading',
      offset: 2,
    });
    await expect(
      queue.restartMissingUpload(task.id, 'other'),
    ).rejects.toMatchObject({ code: 'claim' });
    expect((await queue.restartMissingUpload(task.id, 'owner')).offset).toBe(0);
    await queue.saveCaptureProgress(task.id, 'owner', {
      state: 'committing',
      offset: 3,
    });
    await expect(
      queue.restartMissingUpload(task.id, 'owner'),
    ).rejects.toThrow();
    expect((await queue.listCaptures(binding))[0]).toMatchObject({
      phase: 'commit',
      offset: 3,
    });
  });
  it('keeps bytes across retry/attention, honors retryAt, and releases bytes only with a verified receipt or an unstarted cancellation', async () => {
    const task = await queue.enqueueCapture(file());
    await queue.claimCapture(binding, 'worker', 1000);
    await queue.deferCapture(
      task.id,
      'worker',
      { kind: 'retry', retryAt: 10000, message: 'Connection unavailable' },
      1001,
    );
    expect(await queue.claimCapture(binding, 'early', 9999)).toBeNull();
    await queue.claimCapture(binding, 'retry', 10000);
    await queue.deferCapture(
      task.id,
      'retry',
      { kind: 'attention', message: 'Reconnect' },
      10001,
    );
    expect(await queue.captureBlob(task.id)).not.toBeNull();
    expect(await queue.claimCapture(binding, 'automatic', 20000)).toBeNull();
    await queue.retryCapture(task.id, binding, 20001);
    await queue.claimCapture(binding, 'finish', 20002);
    await expect(
      queue.finishCapture(
        task.id,
        'finish',
        {
          captureId: 'wrong',
          status: 'created',
          kind: 'asset',
          itemId: albumId,
        },
        20003,
      ),
    ).rejects.toThrow();
    expect(await queue.captureBlob(task.id)).not.toBeNull();
    await expect(
      queue.finishCapture(
        task.id,
        'finish',
        {
          captureId: task.id,
          status: 'duplicate',
          kind: 'asset',
          itemId: albumId,
        },
        20003,
      ),
    ).rejects.toThrow();
    await queue.saveCaptureProgress(
      task.id,
      'finish',
      { state: 'committing', offset: 3 },
      20003,
    );
    await queue.finishCapture(
      task.id,
      'finish',
      {
        captureId: task.id,
        status: 'duplicate',
        kind: 'asset',
        itemId: albumId,
      },
      20004,
    );
    expect(await queue.captureBlob(task.id)).toBeNull();
    expect((await queue.listCaptures(binding))[0].state).toBe('duplicate');
    const unstarted = await queue.enqueueCapture(file());
    await queue.cancelQueuedCapture(unstarted.id, binding);
    expect(await queue.captureBlob(unstarted.id)).toBeNull();
  });
});
