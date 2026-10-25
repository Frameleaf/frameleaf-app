import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { queueExecution } from 'src/queue/context.js';
import { SourceOriginalService } from 'src/services/source-original.service.js';
import * as artifacts from 'src/utils/render-artifact.js';

let root: string;
const bytes = Buffer.from('private original');
const assetId = randomUUID();
const request = { id: randomUUID(), deadline: new Date(Date.now() + 60_000) };
const pinned = {
  resourceId: randomUUID(),
  version: 'e'.repeat(64),
  cacheId: randomUUID(),
  leaseId: randomUUID(),
  fileName: `${randomUUID()}.artifact`,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
const reads = {
  enqueue: vi.fn(),
  renewConsumer: vi.fn(),
  releaseConsumer: vi.fn(),
  pinReady: vi.fn(),
  checkPinned: vi.fn(),
};
const cache = { release: vi.fn(), claimRemoval: vi.fn(), confirmRemoved: vi.fn() };
const authorize = vi.fn();
let service: SourceOriginalService;
const execution = (): QueueExecution => ({
  claim: { id: randomUUID(), token: randomUUID() } as QueueExecution['claim'],
  signal: new AbortController().signal,
  progress: vi.fn(),
  progressUnits: 0,
  followups: [],
  adoptions: [],
  buffering: false,
});
const folder = () => join(root, 'source-original-cache', pinned.cacheId);
const file = () => join(folder(), pinned.fileName);
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'source-original-'));
  vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(root);
  await mkdir(folder(), { recursive: true });
  await writeFile(file(), bytes);
  reads.enqueue.mockResolvedValue(request);
  reads.renewConsumer.mockResolvedValue(true);
  reads.pinReady.mockResolvedValue(pinned);
  reads.checkPinned.mockResolvedValue(true);
  cache.release.mockImplementation(async (_id, _reader, stopped) => {
    await stopped?.();
    return true;
  });
  cache.claimRemoval.mockResolvedValue({ id: pinned.cacheId });
  cache.confirmRemoved.mockResolvedValue(true);
  authorize.mockResolvedValue(undefined);
  service = new SourceOriginalService(reads as never, cache as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
it('holds the pin through verified streaming and releases only after descriptor closure', async () => {
  const result = await service.open(assetId, reader, authorize);
  expect(cache.release).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    byteLength: bytes.length,
    verifiedSha256: pinned.sha256,
    resourceId: pinned.resourceId,
    resourceVersion: pinned.version,
  });
  expect(Buffer.concat(await Array.fromAsync(result.stream))).toEqual(bytes);
  await result.settled;
  expect(cache.release).not.toHaveBeenCalled();
  expect(await readFile(file())).toEqual(bytes);
  await result.release();
  expect(cache.release).toHaveBeenCalledExactlyOnceWith(pinned.leaseId, reader, expect.any(Function));
  await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
  expect(cache.confirmRemoved).toHaveBeenCalledExactlyOnceWith(pinned.cacheId);
  await result.release();
  expect(cache.release).toHaveBeenCalledTimes(1);
});

it('can release a consumed job input early without double-releasing after settlement', async () => {
  const context = execution();
  const result = await queueExecution.run(context, () => service.openForJobEntry(assetId, authorize));
  await result.release();
  for (const cleanup of context.afterSettled ?? []) await cleanup();
  expect(cache.release).toHaveBeenCalledTimes(1);
  await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps a job input pinned through deferred adoption, then releases after settlement', async () => {
  const context = execution();
  const result = await queueExecution.run(context, () => service.openForJob(assetId, authorize));
  expect(result).not.toHaveProperty('release');
  expect(reads.pinReady).toHaveBeenCalledWith(
    assetId,
    request.id,
    expect.objectContaining({
      kind: 'job',
      jobId: context.claim.id,
      attemptToken: context.claim.token,
    }),
  );
  expect(Buffer.concat(await Array.fromAsync(result.stream))).toEqual(bytes);
  await result.settled;
  expect(cache.release).not.toHaveBeenCalled();
  await result.check();
  for (const cleanup of context.afterSettled ?? []) await cleanup();
  expect(cache.release).toHaveBeenCalledTimes(1);
  await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains a job input when its tool shutdown cannot be confirmed', async () => {
  const context = execution();
  const result = await queueExecution.run(context, () => service.openForJob(assetId, authorize));
  result.retainOnUnconfirmedStop();
  expect(context.executorStopUnconfirmed).toBe(true);
  for (const cleanup of context.afterSettled ?? []) await cleanup();
  expect(cache.release).not.toHaveBeenCalled();
  expect(await readFile(file())).toEqual(bytes);
  // This fixture has no actual external tool; close its descriptor without freeing its pin.
  result.stream.destroy();
  await result.settled;
});

it('joins a cancelled job descriptor but keeps its pin until executor settlement', async () => {
  const context = execution();
  const abort = new AbortController();
  context.signal = abort.signal;
  const result = await queueExecution.run(context, () => service.openForJob(assetId, authorize));
  abort.abort();
  await result.settled;
  expect(cache.release).not.toHaveBeenCalled();
  for (const cleanup of context.afterSettled ?? []) await cleanup();
  expect(cache.release).toHaveBeenCalledTimes(1);
  await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses a job input before enqueueing when no owned queue claim exists', async () => {
  await expect(service.openForJob(assetId, authorize)).rejects.toThrow('source_job_claim_required');
  expect(reads.enqueue).not.toHaveBeenCalled();
});
it('keeps the verified local path leased through an owned tool and exposes the same authority check', async () => {
  const result = await service.open(assetId, reader, authorize);
  expect(await readFile(result.localPath)).toEqual(bytes);
  await result.check();
  expect(cache.release).not.toHaveBeenCalled();
  reads.checkPinned.mockResolvedValue(false);
  await expect(result.check()).rejects.toThrow('source_original_unavailable');
  expect(await readFile(result.localPath)).toEqual(bytes);
  await result.release();
  reads.checkPinned.mockResolvedValue(true);
  await expect(result.check()).rejects.toThrow('source_original_unavailable');
  await expect(readFile(result.localPath)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('cancels before the first stream read and joins closure before freeing the pin', async () => {
  const abort = new AbortController();
  const result = await service.open(assetId, reader, authorize, abort.signal);
  abort.abort();
  await result.settled;
  expect(cache.release).not.toHaveBeenCalled();
  await result.release();
  expect(cache.release).toHaveBeenCalledTimes(1);
});
it('aborts a pending companion request without creating or releasing a cache pin', async () => {
  reads.pinReady.mockResolvedValue(undefined);
  const abort = new AbortController();
  reads.pinReady.mockImplementationOnce(() => {
    abort.abort();
    return Promise.resolve(undefined);
  });
  await expect(service.open(assetId, reader, authorize, abort.signal)).rejects.toThrow();
  expect(cache.release).not.toHaveBeenCalled();
});
it.each(['corrupt', 'symlink', 'permission'] as const)('refuses %s before returning private bytes', async (failure) => {
  if (failure === 'corrupt') await writeFile(file(), Buffer.alloc(bytes.length));
  else if (failure === 'symlink') {
    await rm(file());
    await symlink('/unapproved-source', file());
  } else reads.checkPinned.mockResolvedValue(false);
  await expect(service.open(assetId, reader, authorize)).rejects.toThrow();
  expect(cache.release).toHaveBeenCalledTimes(1);
});
it.each(['caller', 'source'] as const)(
  'rechecks %s authority before releasing each private chunk',
  async (authority) => {
    const result = await service.open(assetId, reader, authorize);
    if (authority === 'source') reads.checkPinned.mockResolvedValue(false);
    else authorize.mockRejectedValue(new Error('source_original_unavailable'));
    await expect(Array.fromAsync(result.stream)).rejects.toThrow('source_original_unavailable');
    await result.settled;
    await result.release();
    expect(cache.release).toHaveBeenCalledTimes(1);
  },
);
it('resolves storage configuration before reserving companion or reader work', async () => {
  vi.mocked(StorageCore.getMediaLocation).mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  await expect(service.open(assetId, reader, authorize)).rejects.toThrow('storage unavailable');
  expect(reads.enqueue).not.toHaveBeenCalled();
  expect(reads.pinReady).not.toHaveBeenCalled();
});
it('does not claim removal or free cache capacity when release acknowledgement is unknown', async () => {
  cache.release.mockRejectedValue(new Error('database unavailable'));
  const result = await service.open(assetId, reader, authorize);
  await Array.fromAsync(result.stream);
  await expect(result.release()).rejects.toThrow('database unavailable');
  expect(cache.claimRemoval).not.toHaveBeenCalled();
  expect(cache.confirmRemoved).not.toHaveBeenCalled();
  expect(await readFile(file())).toEqual(bytes);
});
it('checks asset access before enqueueing any companion work', async () => {
  authorize.mockRejectedValue(new Error('denied'));
  await expect(service.open(assetId, reader, authorize)).rejects.toThrow('denied');
  expect(reads.enqueue).not.toHaveBeenCalled();
});

it('forwards a consumer byte ceiling before enqueueing provider work', async () => {
  reads.enqueue.mockResolvedValue(undefined);
  await expect(service.open(assetId, reader, authorize, undefined, 512_000)).rejects.toThrow(
    'source_original_unavailable',
  );
  expect(reads.enqueue).toHaveBeenCalledWith(assetId, 512_000, reader);
  expect(reads.pinReady).not.toHaveBeenCalled();
});

it('joins cancellation while enqueue was in flight and cleans an unused completed delivery', async () => {
  const abort = new AbortController();
  reads.enqueue.mockImplementation(() => {
    abort.abort();
    return Promise.resolve(request);
  });
  reads.releaseConsumer.mockResolvedValue(pinned.cacheId);
  await expect(service.open(assetId, reader, authorize, abort.signal)).rejects.toThrow();
  expect(reads.pinReady).not.toHaveBeenCalled();
  expect(reads.releaseConsumer).toHaveBeenCalledExactlyOnceWith(request.id, reader);
  expect(cache.release).not.toHaveBeenCalled();
  expect(cache.confirmRemoved).toHaveBeenCalledExactlyOnceWith(pinned.cacheId);
  await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
});
it('relinquishes queued interest when authorization is withdrawn before pinning', async () => {
  authorize.mockResolvedValueOnce(undefined).mockRejectedValue(new Error('denied'));
  await expect(service.open(assetId, reader, authorize)).rejects.toThrow('denied');
  expect(reads.releaseConsumer).toHaveBeenCalledExactlyOnceWith(request.id, reader);
  expect(cache.claimRemoval).not.toHaveBeenCalled();
});

it('does not open a cache file after its waiting interest expires', async () => {
  reads.renewConsumer.mockResolvedValue(false);
  let input: Awaited<ReturnType<SourceOriginalService['open']>> | undefined;
  const attempt = service.open(assetId, reader, authorize).then((value) => {
    input = value;
    return value;
  });
  try {
    await expect(attempt).rejects.toThrow('source_original_unavailable');
    expect(reads.pinReady).not.toHaveBeenCalled();
    expect(reads.releaseConsumer).toHaveBeenCalledExactlyOnceWith(request.id, reader);
  } finally {
    await input?.release();
  }
});

it('renews a waiting caller again before expiry but stops renewing after a file is pinned', async () => {
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  reads.pinReady.mockImplementationOnce(() => {
    clock += 31_000;
    return Promise.resolve(undefined);
  });
  const input = await service.open(assetId, reader, authorize);
  try {
    expect(reads.renewConsumer).toHaveBeenCalledTimes(2);
    await input.check();
    expect(reads.renewConsumer).toHaveBeenCalledTimes(2);
  } finally {
    await input.release();
  }
});

it.each(['release', 'claimRemoval', 'confirmRemoved'] as const)(
  'retries a transient %s failure after descriptor closure without losing idempotence',
  async (stage) => {
    cache.release.mockResolvedValue(false);
    if (stage !== 'release') cache.release.mockResolvedValueOnce(true);
    cache[stage].mockRejectedValueOnce(new Error('cleanup acknowledgement lost'));
    const input = await service.open(assetId, reader, authorize);
    await expect(input.release()).rejects.toThrow('cleanup acknowledgement lost');
    await expect(input.settled).resolves.toBeUndefined();
    if (stage !== 'confirmRemoved') expect(await readFile(file())).toEqual(bytes);
    await Promise.all([input.release(), input.release()]);
    await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(cache.release).toHaveBeenCalledTimes(2);
    await input.release();
    expect(cache.release).toHaveBeenCalledTimes(2);
  },
);
it('retries a consumed job entry release during settlement after its first database acknowledgement failed', async () => {
  const context = execution();
  const input = await queueExecution.run(context, () => service.openForJobEntry(assetId, authorize));
  cache.release.mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(false);
  await expect(input.release()).rejects.toThrow('database unavailable');
  for (const settle of context.afterSettled ?? []) await settle();
  await expect(readFile(file())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains a borrowed job path when the queue reports an unconfirmed executor without a per-input marker', async () => {
  const context = execution();
  const input = await queueExecution.run(context, () => service.openForJob(assetId, authorize));
  context.executorStopUnconfirmed = true;
  try {
    for (const settle of context.afterSettled ?? []) await settle();
    expect(await readFile(file())).toEqual(bytes);
    expect(cache.release).not.toHaveBeenCalled();
  } finally {
    input.stream.destroy();
    await input.settled;
  }
});

it.each(['explicit-retain', 'queue-marker'] as const)(
  'does not record a stopped reader on explicit release after %s',
  async (uncertain) => {
    const context = execution();
    const input = await queueExecution.run(context, () => service.openForJobEntry(assetId, authorize));
    if (uncertain === 'explicit-retain') input.retainOnUnconfirmedStop();
    const releasing = input.release();
    if (uncertain === 'queue-marker') context.executorStopUnconfirmed = true;
    try {
      await expect(releasing).rejects.toThrow('source_reader_stop_unconfirmed');
      expect(await readFile(file())).toEqual(bytes);
      expect(cache.release).not.toHaveBeenCalled();
      expect((await readdir(folder())).some((name) => name.startsWith('reader-'))).toBe(true);
    } finally {
      input.stream.destroy();
      await input.settled;
    }
  },
);

it('persists its reader marker before verifying or lending the original', async () => {
  await writeFile(join(folder(), 'closed.json'), 'writer closure receipt');
  reads.checkPinned.mockImplementation(async () => {
    expect((await readdir(folder())).filter((name) => name.startsWith('reader-'))).toHaveLength(1);
    expect(await readFile(join(folder(), 'closed.json'), 'utf8')).toBe('writer closure receipt');
    return true;
  });
  const input = await service.open(assetId, reader, authorize);
  expect(reads.checkPinned).toHaveBeenCalled();
  await input.release();
});

it('retains its on-disk reader marker when opening cannot confirm descriptor closure', async () => {
  vi.spyOn(artifacts, 'openRenderArtifact').mockRejectedValueOnce(new Error('artifact_close_unconfirmed'));
  await expect(service.open(assetId, reader, authorize)).rejects.toThrow('artifact_close_unconfirmed');
  expect(cache.release).not.toHaveBeenCalled();
  expect((await readdir(folder())).filter((name) => name.startsWith('reader-'))).toHaveLength(1);
  expect(await readFile(file())).toEqual(bytes);
});
