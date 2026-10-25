import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, opendir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  beginSourceCacheReader,
  removeSourceCacheReaderMarker,
  sourceCacheClosedMatches,
  writeSourceCacheClosed,
} from 'src/utils/source-cache-closed.js';

vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...fs, lstat: vi.fn(fs.lstat), open: vi.fn(fs.open), opendir: vi.fn(fs.opendir) };
});

let root: string;
const row = {
  id: randomUUID(),
  writerId: randomUUID(),
  writerOwnerId: randomUUID(),
  bytes: 5,
  sha256: randomBytes(32),
  fileName: `${randomUUID()}.artifact`,
};
const folder = () => join(root, row.id);
const receipt = () => join(folder(), 'closed.json');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-cache-closed-'));
  await mkdir(folder());
  await writeFile(join(folder(), row.fileName), 'hello');
});
afterEach(async () => rm(root, { recursive: true, force: true }));
it('keeps writer proof while a unique active reader marker blocks reclamation', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  expect(await sourceCacheClosedMatches(root, row)).toBe(true);
  const close = await beginSourceCacheReader(root, row.id, randomUUID());
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
  await close();
  expect(await sourceCacheClosedMatches(root, row)).toBe(true);
  expect(await readFile(join(folder(), row.fileName), 'utf8')).toBe('hello');
});
it.each(['id', 'writerId', 'writerOwnerId', 'bytes', 'sha256', 'fileName'] as const)(
  'refuses a changed %s identity',
  async (key) => {
    expect(await writeSourceCacheClosed(root, row)).toBe(true);
    const value = key === 'bytes' ? 6 : key === 'sha256' ? randomBytes(32) : randomUUID();
    expect(await sourceCacheClosedMatches(root, { ...row, [key]: value })).toBe(false);
  },
);
it('refuses a replaced inode and never removes either file', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  await rename(join(folder(), row.fileName), join(folder(), 'retained'));
  await writeFile(join(folder(), row.fileName), 'hello');
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
  expect(await readFile(join(folder(), 'retained'), 'utf8')).toBe('hello');
});
it.each(['missing', 'oversized', 'malformed', 'symlink'] as const)('refuses a %s receipt', async (kind) => {
  switch (kind) {
    case 'oversized': {
      await writeFile(receipt(), 'x'.repeat(2049));
      break;
    }
    case 'malformed': {
      await writeFile(receipt(), '{');
      break;
    }
    case 'symlink': {
      await symlink(join(folder(), row.fileName), receipt());
      break;
    }
    // No default
  }
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
});

it('refuses a delayed old writer receipt while a newer reader marker is active', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  const old = await readFile(receipt());
  const close = await beginSourceCacheReader(root, row.id, randomUUID());
  await writeFile(receipt(), old);
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
  await close();
  expect(await sourceCacheClosedMatches(root, row)).toBe(true);
});

it('keeps other readers protected when one owner closes its marker twice', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  const first = await beginSourceCacheReader(root, row.id, randomUUID());
  const second = await beginSourceCacheReader(root, row.id, randomUUID());
  await first();
  await first();
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
  await second();
  expect(await sourceCacheClosedMatches(root, row)).toBe(true);
});
it('refuses an additional artifact that the writer receipt never owned', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  await writeFile(join(folder(), `${randomUUID()}.artifact`), 'other');
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
});
it('bounds durable reader admission without deleting existing owner markers', async () => {
  for (let index = 0; index < 64; index++) await writeFile(join(folder(), `reader-${randomUUID()}`), '');
  await expect(beginSourceCacheReader(root, row.id, randomUUID())).rejects.toThrow('source_cache_readers_unavailable');
  expect(await sourceCacheClosedMatches(root, row)).toBe(false);
});

it('bounds a stalled proof check without duplicating reads or accepting its late result', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const stalled = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const probe = vi
    .mocked(lstat)
    .mockClear()
    .mockImplementationOnce(async (...args) => {
      started.resolve();
      await stalled.promise;
      return real.lstat(...args);
    });
  const attempts: Promise<boolean>[] = [];
  vi.useFakeTimers();
  try {
    let result: boolean | undefined;
    attempts.push(
      sourceCacheClosedMatches(root, row).then((value) => {
        result = value;
        return value;
      }),
    );
    await started.promise;
    attempts.push(sourceCacheClosedMatches(root, row));
    await vi.advanceTimersByTimeAsync(5000);
    expect(result).toBe(false);
    expect(await Promise.all(attempts)).toEqual([false, false]);
    expect(await sourceCacheClosedMatches(root, { ...row, bytes: 6 })).toBe(false);
    expect(await sourceCacheClosedMatches(root, { ...row, id: randomUUID() })).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    stalled.resolve();
    expect(await sourceCacheClosedMatches(root, row)).toBe(false);
    vi.useRealTimers();
    await expect.poll(() => sourceCacheClosedMatches(root, row)).toBe(true);
    expect(result).toBe(false);
    expect(await readFile(join(folder(), row.fileName), 'utf8')).toBe('hello');
  } finally {
    stalled.resolve();
    vi.useRealTimers();
    await Promise.allSettled(attempts);
    await sourceCacheClosedMatches(root, row);
    probe.mockRestore();
  }
});

it.each(['legacy', 'payload', 'symlink'] as const)(
  'never retires a %s marker as a known stopped lease',
  async (kind) => {
    expect(await writeSourceCacheClosed(root, row)).toBe(true);
    const leaseId = randomUUID();
    const marker = join(folder(), kind === 'legacy' ? `reader-${leaseId}` : `reader-lease-${leaseId}`);
    if (kind === 'symlink') await symlink(join(folder(), row.fileName), marker);
    else await writeFile(marker, kind === 'payload' ? 'unowned marker contents' : '');
    if (kind === 'legacy') await removeSourceCacheReaderMarker(root, row.id, leaseId);
    else
      await expect(removeSourceCacheReaderMarker(root, row.id, leaseId)).rejects.toThrow(
        'source_cache_ownership_unavailable',
      );
    expect(await sourceCacheClosedMatches(root, row)).toBe(false);
    expect(await readFile(join(folder(), row.fileName), 'utf8')).toBe('hello');
    if (kind === 'payload') expect(await readFile(marker, 'utf8')).toBe('unowned marker contents');
  },
);

it.each(['marker', 'directory'] as const)('retains a reader marker when its actual %s close fails', async (kind) => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const leaseId = randomUUID();
  const marker = join(folder(), `reader-lease-${leaseId}`);
  let retained: Awaited<ReturnType<typeof real.open>> | undefined;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await real.open(...args);
    if (args[0] !== (kind === 'marker' ? marker : folder())) return file;
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
    await expect(beginSourceCacheReader(root, row.id, leaseId)).rejects.toThrow('artifact_close_unconfirmed');
    expect(await readFile(marker, 'utf8')).toBe('');
    expect(retained).toBeDefined();
    const stat = await retained!.stat();
    expect(kind === 'marker' ? stat.isFile() : stat.isDirectory()).toBe(true);
  } finally {
    await retained?.close();
    vi.mocked(open).mockRestore();
  }
});

it('starts no further proof IO after a root stat outlives its deadline', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const stat = await real.lstat(root);
  const entered = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<typeof stat>();
  const probe = vi
    .mocked(lstat)
    .mockClear()
    .mockImplementationOnce(() => {
      entered.resolve();
      return paused.promise as never;
    });
  vi.mocked(open).mockClear();
  vi.mocked(opendir).mockClear();
  vi.useFakeTimers();
  const result = sourceCacheClosedMatches(root, row);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await result).toBe(false);
    paused.resolve(stat);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(opendir).not.toHaveBeenCalled();
  } finally {
    paused.resolve(stat);
    await result;
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    probe.mockRestore();
  }
});

it.each(['receipt', 'directory'] as const)('retains proof admission when actual %s close fails', async (kind) => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let close: (() => Promise<void>) | undefined;
  let live: (() => Promise<unknown>) | undefined;
  const opened = kind === 'receipt' ? vi.mocked(open) : vi.mocked(opendir);
  if (kind === 'receipt')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await real.open(...args);
      close = file.close.bind(file);
      live = file.stat.bind(file);
      return new Proxy(file, {
        get(target, key) {
          if (key === 'close') return () => Promise.reject(new Error('synthetic close failure'));
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  else
    vi.mocked(opendir).mockImplementationOnce(async (...args) => {
      const directory = await real.opendir(...args);
      close = directory.close.bind(directory);
      live = directory.read.bind(directory);
      const handle = {
        read: directory.read.bind(directory),
        close: () => Promise.reject(new Error('synthetic close failure')),
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const entry = await handle.read();
              if (!entry) return;
              yield entry;
            }
          } finally {
            await handle.close();
          }
        },
      };
      return handle as never;
    });
  opened.mockClear();
  try {
    expect(await sourceCacheClosedMatches(root, row)).toBe(false);
    expect(close).toBeDefined();
    await expect(live!()).resolves.not.toBeUndefined();
    expect(await sourceCacheClosedMatches(root, row)).toBe(false);
    expect(await sourceCacheClosedMatches(root, { ...row, bytes: 6 })).toBe(false);
    expect(opened).toHaveBeenCalledOnce();
  } finally {
    await close?.();
    vi.mocked(open).mockRestore();
    vi.mocked(opendir).mockRestore();
  }
});

it('refuses a joined caller after another caller expires during actual receipt closure', async () => {
  expect(await writeSourceCacheClosed(root, row)).toBe(true);
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed: Promise<void> | undefined;
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await real.open(...args);
    return new Proxy(file, {
      get(target, key) {
        if (key === 'close')
          return () => {
            closing.resolve();
            closed = release.promise.then(() => file.close());
            return closed;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  vi.useFakeTimers();
  const first = sourceCacheClosedMatches(root, row);
  let second: Promise<boolean> | undefined;
  try {
    await closing.promise;
    await vi.advanceTimersByTimeAsync(4000);
    second = sourceCacheClosedMatches(root, row);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await first).toBe(false);
    release.resolve();
    await closed;
    expect(await second).toBe(false);
  } finally {
    release.resolve();
    await closed;
    await Promise.allSettled([first, second]);
    vi.useRealTimers();
    vi.mocked(open).mockRestore();
  }
  expect(await sourceCacheClosedMatches(root, row)).toBe(true);
});
