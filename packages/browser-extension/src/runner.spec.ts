import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { CaptureTask } from './queue';
import type { CaptureUploadStateDto } from '@frameleaf/sdk';
import { createCaptureTransport, DeliveryFailure } from './capture-transport';
vi.mock('./capture-transport', async (original) => ({
  ...(await original<typeof import('./capture-transport')>()),
  createCaptureTransport: vi.fn(),
}));
let queue: typeof import('./queue');
let runner: typeof import('./runner');
const binding = {
  serverId: 'one',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example/path',
};
const albumId = '33333333-3333-4333-8333-333333333333';
const source = {
  pageUrl: 'https://example.com/',
  title: 'Reference',
  capturedAt: '2026-10-28T12:00:00.000Z',
};
let remote: Map<string, number>;
const state = (task: CaptureTask): CaptureUploadStateDto => ({
  id: task.id,
  offset: remote.get(task.id) ?? 0,
  ready: remote.get(task.id) === task.file?.size,
  expiresAt: '2030-01-01T00:00:00Z',
});
let transport: ReturnType<typeof fakeTransport>;
function fakeTransport() {
  return {
    getUpload: vi.fn(
      async (task: CaptureTask): Promise<CaptureUploadStateDto> => {
        if (!remote.has(task.id)) throw new DeliveryFailure('missing', 404);
        return state(task);
      },
    ),
    createUpload: vi.fn(
      async (task: CaptureTask): Promise<CaptureUploadStateDto> => {
        remote.set(task.id, 0);
        return state(task);
      },
    ),
    appendUpload: vi.fn(
      async (
        task: CaptureTask,
        _blob: Blob,
        _offset: number,
      ): Promise<CaptureUploadStateDto> => {
        remote.set(task.id, task.file!.size);
        return state(task);
      },
    ),
    commit: vi.fn(async (task: CaptureTask) => ({
      captureId: task.id,
      status: 'created' as const,
      kind: task.file ? ('asset' as const) : ('bookmark' as const),
      itemId: albumId,
    })),
    cancelUpload: vi.fn(async (_task: CaptureTask) => {}),
  };
}
const enqueue = () =>
  queue.enqueueCapture({
    binding,
    albumId,
    source,
    file: {
      filename: 'reference.png',
      blob: new Blob(['abc'], { type: 'image/png' }),
    },
  });
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', {
    storage: { estimate: vi.fn().mockResolvedValue({ quota: 1e9, usage: 0 }) },
  });
  queue = await import('./queue');
  runner = await import('./runner');
  remote = new Map();
  transport = fakeTransport();
  vi.mocked(createCaptureTransport).mockReturnValue(transport);
});
describe('durable capture delivery', () => {
  it('persists commit phase before the network call and releases bytes only after the receipt', async () => {
    const task = await enqueue();
    transport.commit.mockImplementationOnce(async (current) => {
      expect((await queue.listCaptures(binding))[0]).toMatchObject({
        phase: 'commit',
        state: 'committing',
        offset: 3,
      });
      expect(await queue.captureBlob(current.id)).not.toBeNull();
      return {
        captureId: current.id,
        status: 'created',
        kind: 'asset',
        itemId: albumId,
      };
    });
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].state).toBe('saved');
    expect(await queue.captureBlob(task.id)).toBeNull();
    expect(transport.createUpload).toHaveBeenCalledTimes(1);
    expect(transport.appendUpload).toHaveBeenCalledTimes(1);
  });
  it.each(['create', 'append', 'create409', 'append409'])(
    'recovers %s response loss/conflict through GET with the original capture ID',
    async (fault) => {
      const task = await enqueue();
      if (fault.startsWith('create'))
        transport.createUpload.mockImplementationOnce(async (current) => {
          remote.set(current.id, 0);
          throw new DeliveryFailure(
            fault.endsWith('409') ? 'attention' : 'retry',
            fault.endsWith('409') ? 409 : 0,
          );
        });
      else
        transport.appendUpload.mockImplementationOnce(async (current) => {
          remote.set(current.id, 3);
          throw new DeliveryFailure(
            fault.endsWith('409') ? 'attention' : 'retry',
            fault.endsWith('409') ? 409 : 0,
          );
        });
      await runner.resumeQueue(binding, 'private-key');
      expect((await queue.listCaptures(binding))[0]).toMatchObject({
        id: task.id,
        state: 'saved',
      });
      expect(transport.createUpload).toHaveBeenCalledOnce();
      expect(transport.appendUpload).toHaveBeenCalledOnce();
    },
  );
  it('replays a lost commit response with the same DTO without uploading again', async () => {
    const task = await enqueue();
    transport.commit.mockRejectedValueOnce(new DeliveryFailure('retry'));
    await runner.resumeQueue(binding, 'private-key');
    const pending = (await queue.listCaptures(binding))[0];
    expect(pending.phase).toBe('commit');
    expect(pending.retryAt).toBeGreaterThanOrEqual(Date.now() + 4000);
    expect(await queue.captureBlob(task.id)).not.toBeNull();
    await queue.retryCapture(task.id, binding);
    await runner.resumeQueue(binding, 'private-key');
    expect(transport.createUpload).toHaveBeenCalledOnce();
    expect(transport.appendUpload).toHaveBeenCalledOnce();
    expect(transport.commit).toHaveBeenCalledTimes(2);
    expect(
      transport.commit.mock.calls.map(([task]) => ({
        id: task.id,
        source: task.source,
        file: task.file,
      }))[0],
    ).toEqual(
      transport.commit.mock.calls.map(([task]) => ({
        id: task.id,
        source: task.source,
        file: task.file,
      }))[1],
    );
    expect(await queue.captureBlob(task.id)).toBeNull();
  });
  it('can confirm an already uploaded capture even after its local Blob is lost', async () => {
    const task = await enqueue();
    await queue.claimCapture(binding, 'old');
    await queue.saveCaptureProgress(task.id, 'old', {
      state: 'committing',
      offset: 3,
    });
    await queue.deferCapture(task.id, 'old', {
      kind: 'attention',
      message: 'Receipt missing',
    });
    const [{ name }] = await indexedDB.databases();
    const database = await new Promise<IDBDatabase>((resolve) => {
      const opening = indexedDB.open(name!);
      opening.onsuccess = () => resolve(opening.result);
    });
    const tx = database.transaction('blobs', 'readwrite');
    const done = new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });
    tx.objectStore('blobs').delete(task.id);
    await done;
    database.close();
    await queue.retryCapture(task.id, binding);
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].state).toBe('saved');
    expect(transport.commit).toHaveBeenCalledOnce();
    expect(transport.getUpload).not.toHaveBeenCalled();
    expect(transport.appendUpload).not.toHaveBeenCalled();
  });
  it('honors Retry-After and does not hot-loop a transient failure', async () => {
    await enqueue();
    const retryAt = Date.now() + 60000;
    transport.getUpload.mockRejectedValue(
      new DeliveryFailure('retry', 503, retryAt),
    );
    await runner.resumeQueue(binding, 'private-key');
    expect(
      (await queue.listCaptures(binding))[0].retryAt,
    ).toBeGreaterThanOrEqual(retryAt);
    const calls = transport.getUpload.mock.calls.length;
    await runner.resumeQueue(binding, 'private-key');
    expect(transport.getUpload).toHaveBeenCalledTimes(calls);
  });
  it('pauses authorization failures and stops other workers before they can publish', async () => {
    await Promise.all([enqueue(), enqueue()]);
    transport.getUpload.mockRejectedValue(
      new DeliveryFailure('authorization', 401),
    );
    await expect(
      runner.resumeQueue(binding, 'private-key'),
    ).rejects.toMatchObject({ kind: 'authorization' });
    expect(transport.commit).not.toHaveBeenCalled();
    expect(transport.appendUpload).not.toHaveBeenCalled();
    expect(
      (await queue.listCaptures(binding)).every(
        (task) => task.state === 'needs-attention',
      ),
    ).toBe(true);
  });
  it('preserves bytes on permanent failures and on destination/actor ambiguity without a fallback', async () => {
    const task = await enqueue();
    transport.createUpload.mockRejectedValue(
      new DeliveryFailure('attention', 409),
    );
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].state).toBe(
      'needs-attention',
    );
    expect(transport.createUpload).toHaveBeenCalledOnce();
    expect(await queue.captureBlob(task.id)).not.toBeNull();
    await queue.retryCapture(task.id, binding);
    transport.getUpload.mockRejectedValue(
      new DeliveryFailure('permanent', 415),
    );
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].state).toBe('failed');
    expect(await queue.captureBlob(task.id)).not.toBeNull();
  });
  it('resumes a legitimately missing upload from zero only after creating the same resource UUID', async () => {
    const task = await enqueue();
    await queue.claimCapture(binding, 'previous');
    await queue.saveCaptureProgress(task.id, 'previous', {
      state: 'uploading',
      offset: 2,
    });
    await queue.deferCapture(task.id, 'previous', {
      kind: 'attention',
      message: 'Offline',
    });
    await queue.retryCapture(task.id, binding);
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].state).toBe('saved');
    expect(transport.appendUpload.mock.calls[0][2]).toBe(0);
    expect(transport.createUpload.mock.calls[0][0].id).toBe(task.id);
  });
  it('refuses a regressed existing offset and an old worker cannot finish a stolen claim', async () => {
    const task = await enqueue();
    await queue.claimCapture(binding, 'previous');
    await queue.saveCaptureProgress(task.id, 'previous', {
      state: 'uploading',
      offset: 2,
    });
    await queue.deferCapture(task.id, 'previous', {
      kind: 'attention',
      message: 'Offline',
    });
    await queue.retryCapture(task.id, binding);
    remote.set(task.id, 0);
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].state).toBe(
      'needs-attention',
    );
    expect(transport.appendUpload).not.toHaveBeenCalled();
    await queue.retryCapture(task.id, binding);
    remote.set(task.id, 2);
    transport.appendUpload.mockImplementationOnce(async (current) => {
      remote.set(current.id, 3);
      await queue.claimCapture(
        binding,
        'replacement',
        Date.now() + queue.CLAIM_MS + 1,
      );
      return state(current);
    });
    await runner.resumeQueue(binding, 'private-key');
    expect(transport.commit).not.toHaveBeenCalled();
    expect(await queue.captureBlob(task.id)).not.toBeNull();
    expect((await queue.listCaptures(binding))[0].claim?.owner).toBe(
      'replacement',
    );
  });
  it('commits bookmarks without file operations and ignores captures for another destination', async () => {
    await queue.enqueueCapture({
      binding,
      albumId,
      source,
      bookmark: {
        url: 'https://example.com/watch?v=123',
        title: 'Watch later',
      },
    });
    await runner.resumeQueue(
      { ...binding, origin: 'https://elsewhere.example' },
      'wrong-key',
    );
    expect(transport.commit).not.toHaveBeenCalled();
    await runner.resumeQueue(binding, 'private-key');
    expect(transport.commit).toHaveBeenCalledOnce();
    expect(transport.getUpload).not.toHaveBeenCalled();
    expect((await queue.listCaptures(binding))[0].state).toBe('saved');
  });
  it('bounds retry delay and treats a non-progressing verification response as retryable', async () => {
    expect(runner.nextRetryAt(1, undefined, 0)).toBe(5000);
    expect(runner.nextRetryAt(99, undefined, 0)).toBe(300000);
    expect(runner.nextRetryAt(1, 60000, 0)).toBe(60000);
    await enqueue();
    transport.appendUpload.mockImplementationOnce(async (current) =>
      state(current),
    );
    await runner.resumeQueue(binding, 'private-key');
    expect((await queue.listCaptures(binding))[0].retryAt).toBeGreaterThan(
      Date.now(),
    );
    expect(transport.appendUpload).toHaveBeenCalledOnce();
    expect(transport.commit).not.toHaveBeenCalled();
  });
});
