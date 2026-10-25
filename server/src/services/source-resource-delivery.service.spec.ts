import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { StorageCore } from 'src/cores/storage.core.js';
import { SourceResourceDeliveryService } from 'src/services/source-resource-delivery.service.js';
import { beginCloudNativeWork } from 'src/utils/cloud-native-work.js';
import { receiveRenderArtifact } from 'src/utils/render-artifact.js';

vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...fs, open: vi.fn(fs.open) };
});

vi.mock('src/utils/render-artifact.js', async () => {
  const original = await vi.importActual<typeof import('src/utils/render-artifact.js')>('src/utils/render-artifact.js');
  return { ...original, receiveRenderArtifact: vi.fn(original.receiveRenderArtifact) };
});

const bytes = Buffer.from('hello');
const id = randomUUID();
const descriptor = {
  requestId: id,
  claimFence: 1,
  claimToken: 'a'.repeat(64),
  resourceKey: 'b'.repeat(64),
  version: 'c'.repeat(64),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
};
const payload = JSON.stringify(descriptor);
const header = Buffer.from(payload).toString('base64');
const grant = { sourceId: randomUUID() };
const original = {
  ...descriptor,
  id,
  sourceId: grant.sourceId,
  leaseUntil: new Date(Date.now() + 120_000),
  deadline: new Date(Date.now() + 600_000),
};
const entry = { id: randomUUID() };
const auth = { authenticate: vi.fn() };
const grants = { withGrant: vi.fn() };
const reads = { beginDelivery: vi.fn(), heartbeat: vi.fn(), completeDelivery: vi.fn() };
const cache = {
  inspectDisk: vi.fn(),
  removalCandidates: vi.fn(),
  reserve: vi.fn(),
  publishVerified: vi.fn(),
  finishWriter: vi.fn(),
  claimRemoval: vi.fn(),
  confirmRemoved: vi.fn(),
};
const logger = { setContext: vi.fn(), warn: vi.fn() };
let folder: string;
let service: SourceResourceDeliveryService;
beforeEach(async () => {
  vi.resetAllMocks();
  vi.mocked(open).mockImplementation(
    (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open,
  );
  vi.mocked(receiveRenderArtifact).mockImplementation(
    (await vi.importActual<typeof import('src/utils/render-artifact.js')>('src/utils/render-artifact.js'))
      .receiveRenderArtifact,
  );
  folder = await mkdtemp(join(tmpdir(), 'source-delivery-'));
  vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(folder);
  auth.authenticate.mockResolvedValue(grant);
  grants.withGrant.mockImplementation((_grant, action) => action('tx'));
  reads.beginDelivery.mockResolvedValue(original);
  reads.heartbeat.mockResolvedValue(original);
  reads.completeDelivery.mockImplementation((_grant, _id, _fence, _token, _expected, publish) => publish('tx'));
  cache.inspectDisk.mockResolvedValue([]);
  cache.removalCandidates.mockResolvedValue([]);
  cache.reserve.mockResolvedValue(entry);
  cache.publishVerified.mockResolvedValue(true);
  cache.finishWriter.mockResolvedValue(true);
  cache.claimRemoval.mockResolvedValue({ ...entry, state: 'deleting' });
  cache.confirmRemoved.mockResolvedValue(true);
  service = new SourceResourceDeliveryService(
    auth as never,
    grants as never,
    reads as never,
    cache as never,
    logger as never,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});
const staged = () => join(folder, 'source-original-cache', entry.id);
it('retains writer ownership when a verification descriptor cannot confirm closure', async () => {
  vi.mocked(receiveRenderArtifact).mockRejectedValueOnce(new Error('artifact_close_unconfirmed'));
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
    'artifact_close_unconfirmed',
  );
  expect(cache.finishWriter).not.toHaveBeenCalled();
  expect(cache.claimRemoval).not.toHaveBeenCalled();
  expect(cache.confirmRemoved).not.toHaveBeenCalled();
});
it('authenticates exact signed metadata, verifies actual bytes and publishes without disclosing a storage path', async () => {
  await expect(service.deliver('source bearer', 'proof', header, Readable.from([bytes]))).resolves.toEqual({
    accepted: true,
  });
  expect(auth.authenticate).toHaveBeenCalledWith('source bearer', 'proof', 'deliver', payload);
  expect(reads.beginDelivery).toHaveBeenCalledWith(
    grant,
    id,
    1,
    createHash('sha256').update(descriptor.claimToken).digest(),
  );
  expect(cache.publishVerified).toHaveBeenCalledWith(
    'tx',
    entry.id,
    expect.objectContaining({ id: expect.any(String), ownerId: expect.any(String) }),
    expect.objectContaining({ bytes: 5, sha256: Buffer.from(descriptor.sha256, 'hex') }),
  );
  const files = await readdir(staged());
  expect(files).toHaveLength(2);
  expect(files).toContain('closed.json');
  expect(
    await readFile(
      join(
        staged(),
        files.find((name) => name.endsWith('.artifact'))!,
      ),
    ),
  ).toEqual(bytes);
  expect(cache.finishWriter).not.toHaveBeenCalled();
});
it.each([
  undefined,
  'not base64',
  Buffer.from('{}').toString('base64'),
  header + '=',
  'a'.repeat(4097),
  ...[
    { ...descriptor, path: '/private' },
    { ...descriptor, bytes: 0 },
    { ...descriptor, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...descriptor, claimFence: 0 },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString('base64')),
])('refuses malformed control metadata before consuming bytes', async (value) => {
  const read = vi.fn();
  const input = Readable.from(
    (function* () {
      read();
      yield bytes;
    })(),
  );
  await expect(service.deliver('bearer', 'proof', value, input)).rejects.toThrow('source_read_payload_invalid');
  expect(read).not.toHaveBeenCalled();
  expect(auth.authenticate).not.toHaveBeenCalled();
  input.destroy();
});
it.each(['unauthorized', 'capacity', 'version'] as const)(
  'refuses %s before reading the original body',
  async (failure) => {
    switch (failure) {
      case 'unauthorized': {
        auth.authenticate.mockRejectedValue(new Error('unauthorized'));
        break;
      }
      case 'capacity': {
        cache.reserve.mockResolvedValue(undefined);
        break;
      }
      case 'version': {
        reads.beginDelivery.mockResolvedValue({ ...original, version: 'e'.repeat(64) });
        break;
      }
      // No default
    }
    const read = vi.fn();
    const input = Readable.from(
      (function* () {
        read();
        yield bytes;
      })(),
    );
    await expect(service.deliver('bearer', 'proof', header, input)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(cache.publishVerified).not.toHaveBeenCalled();
    input.destroy();
  },
);
it.each(['short', 'long', 'checksum', 'revoked'] as const)(
  'never publishes a %s upload and releases only after the receiver stops',
  async (failure) => {
    if (failure === 'revoked') reads.heartbeat.mockResolvedValue(undefined);
    const input =
      failure === 'short'
        ? bytes.subarray(1)
        : failure === 'long'
          ? Buffer.concat([bytes, bytes])
          : failure === 'checksum'
            ? Buffer.alloc(5)
            : bytes;
    await expect(service.deliver('bearer', 'proof', header, Readable.from([input]))).rejects.toThrow();
    expect(cache.publishVerified).not.toHaveBeenCalled();
    expect(cache.finishWriter).toHaveBeenCalledWith(
      entry.id,
      expect.objectContaining({ id: expect.any(String), ownerId: expect.any(String) }),
    );
    expect(cache.confirmRemoved).toHaveBeenCalledWith(entry.id);
    await expect(readdir(staged())).rejects.toMatchObject({ code: 'ENOENT' });
  },
);
it('retains a possibly published file when database acknowledgement is lost', async () => {
  reads.completeDelivery.mockRejectedValue(new Error('commit acknowledgement lost'));
  cache.finishWriter.mockResolvedValue(false);
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
    'commit acknowledgement lost',
  );
  expect(await readdir(staged())).toHaveLength(2);
  expect(cache.claimRemoval).not.toHaveBeenCalled();
  expect(cache.confirmRemoved).not.toHaveBeenCalled();
});
it('keeps ownership when removal is not admitted', async () => {
  reads.completeDelivery.mockResolvedValue(undefined);
  cache.claimRemoval.mockResolvedValue(undefined);
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).resolves.toEqual({
    accepted: false,
  });
  expect(cache.confirmRemoved).not.toHaveBeenCalled();
});

it('aborts a stalled body at the request deadline and cleans only after it stops', async () => {
  reads.beginDelivery.mockResolvedValue({ ...original, deadline: new Date(Date.now() + 100) });
  const input = new Readable({ read() {} });
  await expect(service.deliver('bearer', 'proof', header, input)).rejects.toMatchObject({ name: 'AbortError' });
  expect(input.destroyed).toBe(true);
  expect(cache.finishWriter).toHaveBeenCalled();
  expect(cache.confirmRemoved).toHaveBeenCalledWith(entry.id);
});
it('does not reserve capacity when storage configuration cannot be resolved', async () => {
  vi.mocked(StorageCore.getMediaLocation).mockImplementationOnce(() => {
    throw new Error('storage configuration unavailable');
  });
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
    'storage configuration unavailable',
  );
  expect(cache.reserve).not.toHaveBeenCalled();
});

it('recovers only admitted retired directories, including interrupted deletion and symlink objects', async () => {
  const retired = randomUUID(),
    retained = randomUUID(),
    link = randomUUID();
  const root = join(folder, 'source-original-cache');
  await mkdir(join(root, retired), { recursive: true });
  await mkdir(join(root, retained), { recursive: true });
  await writeFile(join(root, retired, 'private-original'), bytes);
  await writeFile(join(root, retained, 'private-original'), bytes);
  const outside = join(folder, 'retained-library');
  await mkdir(outside);
  await writeFile(join(outside, 'original'), bytes);
  await symlink(outside, join(root, link));
  cache.removalCandidates.mockResolvedValue([{ id: retired }, { id: retained }, { id: link }]);
  cache.claimRemoval.mockImplementation((id) => Promise.resolve(id === retained ? undefined : { id }));
  expect(await service.cleanup()).toBe(2);
  await expect(readdir(join(root, retired))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readdir(join(root, link))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(root, retained, 'private-original'))).toEqual(bytes);
  expect(await readFile(join(outside, 'original'))).toEqual(bytes);
  expect(cache.confirmRemoved).not.toHaveBeenCalledWith(retained);
});
it('reclaims expired capacity before retrying a delivery reservation', async () => {
  const retired = randomUUID(),
    path = join(folder, 'source-original-cache', retired);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'original'), bytes);
  cache.reserve.mockResolvedValueOnce(undefined).mockResolvedValueOnce(entry);
  cache.removalCandidates.mockResolvedValue([{ id: retired }]);
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).resolves.toEqual({ accepted: true });
  await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
  const files = await readdir(staged());
  expect(
    await readFile(
      join(
        staged(),
        files.find((name) => name.endsWith('.artifact'))!,
      ),
    ),
  ).toEqual(bytes);
});
it('does not free capacity when cleanup acknowledgement is lost and continues other candidates', async () => {
  const first = randomUUID(),
    second = randomUUID();
  cache.removalCandidates.mockResolvedValue([{ id: first }, { id: second }]);
  cache.confirmRemoved.mockRejectedValueOnce(new Error('acknowledgement lost')).mockResolvedValueOnce(true);
  expect(await service.cleanup()).toBe(1);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(cache.confirmRemoved).toHaveBeenCalledWith(first);
  expect(cache.confirmRemoved).toHaveBeenCalledWith(second);
});
it('rechecks the provider lease after cleanup before retrying capacity', async () => {
  const retired = randomUUID();
  cache.reserve.mockResolvedValueOnce(undefined);
  cache.removalCandidates.mockResolvedValue([{ id: retired }]);
  reads.heartbeat.mockResolvedValue(undefined);
  const read = vi.fn();
  const input = Readable.from(
    (function* () {
      read();
      yield bytes;
    })(),
  );
  await expect(service.deliver('bearer', 'proof', header, input)).rejects.toThrow('source_read_lease_invalid');
  expect(cache.reserve).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  input.destroy();
});

it('recovers on the next startup after a database failure without stopping server startup', async () => {
  const retired = randomUUID(),
    path = join(folder, 'source-original-cache', retired);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'original'), bytes);
  cache.removalCandidates
    .mockRejectedValueOnce(new Error('database unavailable'))
    .mockResolvedValueOnce([{ id: retired }]);
  await expect(service.onBootstrap()).resolves.toBeUndefined();
  expect(await readFile(join(path, 'original'))).toEqual(bytes);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  await service.onBootstrap();
  await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('shares an overlapping cleanup pass and permits a fresh pass after it finishes', async () => {
  const retired = randomUUID(),
    path = join(folder, 'source-original-cache', retired);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'original'), bytes);
  const candidates = Promise.withResolvers<{ id: string }[]>();
  cache.removalCandidates.mockReturnValueOnce(candidates.promise).mockResolvedValueOnce([]);
  const first = service.cleanup(),
    second = service.cleanup();
  candidates.resolve([{ id: retired }]);
  expect(await Promise.all([first, second])).toEqual([1, 1]);
  expect(cache.confirmRemoved).toHaveBeenCalledTimes(1);
  await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await service.cleanup()).toBe(0);
});

it('refuses a failed disk preflight before entering allocation or consuming bytes', async () => {
  cache.inspectDisk.mockResolvedValue(undefined);
  const read = vi.fn();
  const input = Readable.from(
    (function* () {
      read();
      yield bytes;
    })(),
  );
  await expect(service.deliver('bearer', 'proof', header, input)).rejects.toThrow('source_cache_capacity_unavailable');
  expect(read).not.toHaveBeenCalled();
  expect(cache.reserve).not.toHaveBeenCalled();
  input.destroy();
});
it('refreshes a changed disk snapshot outside the grant transaction before transferring once', async () => {
  let insideGrant = false;
  grants.withGrant.mockImplementation(async (_grant, action) => {
    insideGrant = true;
    try {
      return await action('tx');
    } finally {
      insideGrant = false;
    }
  });
  cache.inspectDisk.mockImplementation(() => {
    expect(insideGrant).toBe(false);
    return Promise.resolve([]);
  });
  cache.reserve.mockResolvedValueOnce('snapshot-changed').mockResolvedValueOnce(entry);
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).resolves.toEqual({ accepted: true });
  expect(cache.reserve).toHaveBeenCalledTimes(2);
  expect(cache.publishVerified).toHaveBeenCalledTimes(1);
  const files = await readdir(staged());
  expect(
    await readFile(
      join(
        staged(),
        files.find((name) => name.endsWith('.artifact'))!,
      ),
    ),
  ).toEqual(bytes);
});
it('bounds snapshot retries and never starts a body after repeated metadata changes', async () => {
  cache.reserve.mockResolvedValue('snapshot-changed');
  const read = vi.fn();
  const input = Readable.from(
    (function* () {
      read();
      yield bytes;
    })(),
  );
  await expect(service.deliver('bearer', 'proof', header, input)).rejects.toThrow('source_cache_capacity_unavailable');
  expect(cache.reserve).toHaveBeenCalledTimes(3);
  expect(read).not.toHaveBeenCalled();
  expect(cache.publishVerified).not.toHaveBeenCalled();
  input.destroy();
});

it('persists positive writer closure before entering database publication', async () => {
  reads.completeDelivery.mockImplementation(async (_grant, _id, _fence, _token, _expected, publish) => {
    const receipt = JSON.parse(await readFile(join(staged(), 'closed.json'), 'utf8'));
    expect(receipt).toMatchObject({ format: 1, id: entry.id, bytes: bytes.length, sha256: descriptor.sha256 });
    return publish('tx');
  });
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).resolves.toEqual({ accepted: true });
  expect(cache.publishVerified).toHaveBeenCalledOnce();
});

it.each(['artifact-directory', 'receipt-file', 'receipt-directory'] as const)(
  'retains bytes and the writer reservation when actual %s closure is unconfirmed',
  async (kind) => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let retained: Awaited<ReturnType<typeof real.open>> | undefined;
    let directories = 0;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await real.open(...args);
      if (args[0] === staged()) directories++;
      const fail =
        kind === 'receipt-file'
          ? args[0] === join(staged(), 'closed.json.partial')
          : args[0] === staged() && directories === (kind === 'artifact-directory' ? 1 : 2);
      if (!fail) return file;
      retained = file;
      return new Proxy(file, {
        get(target, key) {
          if (key === 'close') return () => Promise.reject(new Error('synthetic descriptor close failure'));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
        'artifact_close_unconfirmed',
      );
      expect(retained).toBeDefined();
      expect(cache.finishWriter).not.toHaveBeenCalled();
      expect(cache.claimRemoval).not.toHaveBeenCalled();
      expect(cache.confirmRemoved).not.toHaveBeenCalled();
      expect(cache.publishVerified).not.toHaveBeenCalled();
      expect(reads.completeDelivery).not.toHaveBeenCalled();
      const files = await readdir(staged());
      const artifact = files.find((file) => file.endsWith('.artifact'))!;
      expect(artifact).toBeDefined();
      expect(await readFile(join(staged(), artifact))).toEqual(bytes);
      if (kind === 'receipt-file') {
        expect(files).toContain('closed.json.partial');
        expect(files).not.toContain('closed.json');
        expect((await retained!.stat()).size).toBeGreaterThan(0);
      } else expect((await retained!.stat()).isDirectory()).toBe(true);
    } finally {
      await retained?.close();
      vi.mocked(open).mockRestore();
    }
  },
);

it('refuses a retained filesystem admission owner before reserving or reading input', async () => {
  const admission = join(folder, 'source-original-cache-admission');
  await mkdir(admission);
  const release = await beginCloudNativeWork(admission);
  const read = vi.fn();
  const input = Readable.from(
    (function* () {
      read();
      yield bytes;
    })(),
  );
  try {
    await expect(service.deliver('bearer', 'proof', header, input)).rejects.toThrow(
      'source_cache_capacity_unavailable',
    );
    expect(cache.inspectDisk).not.toHaveBeenCalled();
    expect(cache.reserve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(await release.owns()).toBe(true);
  } finally {
    input.destroy();
    await release();
  }
});

it('excludes another admission while a reservation is pending, then releases before payload streaming', async () => {
  const entered = Promise.withResolvers<void>();
  const reserved = Promise.withResolvers<typeof entry>();
  cache.reserve.mockImplementationOnce(() => {
    entered.resolve();
    return reserved.promise;
  });
  const first = service.deliver('bearer', 'proof', header, Readable.from([bytes]));
  const second = new SourceResourceDeliveryService(
    auth as never,
    grants as never,
    reads as never,
    cache as never,
    logger as never,
  );
  const input = Readable.from([bytes]);
  let streamingOwner: (() => Promise<void>) | undefined;
  try {
    await entered.promise;
    await expect(second.deliver('bearer', 'proof', header, input)).rejects.toThrow('source_cache_capacity_unavailable');
    expect(cache.reserve).toHaveBeenCalledOnce();
    vi.mocked(receiveRenderArtifact).mockImplementationOnce(async () => {
      expect(await readdir(staged())).toEqual([]);
      streamingOwner = await beginCloudNativeWork(join(folder, 'source-original-cache-admission'));
      return true;
    });
    reserved.resolve(entry);
    expect(await first).toEqual({ accepted: true });
    expect(streamingOwner).toBeDefined();
  } finally {
    reserved.resolve(entry);
    await first.catch(() => {});
    input.destroy();
    await streamingOwner?.();
  }
});

it('retains admission and reserved capacity when directory publication cannot confirm closure', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let retained: Awaited<ReturnType<typeof real.open>> | undefined;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await real.open(...args);
    if (args[0] !== join(folder, 'source-original-cache')) return file;
    retained = file;
    return new Proxy(file, {
      get(target, key) {
        if (key === 'close') return () => Promise.reject(new Error('synthetic close failure'));
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  try {
    await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
      'buddy_file_close_unconfirmed',
    );
    expect(cache.finishWriter).not.toHaveBeenCalled();
    expect(cache.claimRemoval).not.toHaveBeenCalled();
    expect(receiveRenderArtifact).not.toHaveBeenCalled();
    expect((await retained!.stat()).isDirectory()).toBe(true);
    await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
      'source_cache_capacity_unavailable',
    );
    expect(cache.reserve).toHaveBeenCalledOnce();
  } finally {
    await retained?.close();
    vi.mocked(open).mockRestore();
  }
});

it('refuses admission retained by a previous process even after that process exits', async () => {
  const admission = join(folder, 'source-original-cache-admission');
  await mkdir(admission);
  const child = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { beginCloudNativeWork } from ${JSON.stringify(new URL('../utils/cloud-native-work.ts', import.meta.url).href)};
     await beginCloudNativeWork(process.argv[1]);
     console.log('owned');`,
      admission,
    ],
    { timeout: 10_000, maxBuffer: 4096 },
  );
  expect(child.stdout.trim()).toBe('owned');
  expect(await readdir(admission)).toEqual(['.frameleaf-native-owner']);
  await expect(service.deliver('bearer', 'proof', header, Readable.from([bytes]))).rejects.toThrow(
    'source_cache_capacity_unavailable',
  );
  expect(cache.inspectDisk).not.toHaveBeenCalled();
  expect(cache.reserve).not.toHaveBeenCalled();
  expect(await readdir(admission)).toEqual(['.frameleaf-native-owner']);
});
