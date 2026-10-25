import { randomUUID } from 'node:crypto';
import fs, { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCacheDiskIsAccounted } from 'src/utils/source-cache-disk.js';

let root: string;
const id = randomUUID();
const artifact = `${randomUUID()}.artifact`;
const entries = [{ id, bytes: 5 }];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'source-disk-budget-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const stage = async (bytes = Buffer.from('hello')) => {
  const folder = join(root, id);
  await mkdir(folder);
  await writeFile(join(folder, artifact), bytes);
  return folder;
};
it('allows a missing or empty private cache while retaining metadata reservations', async () => {
  expect(await sourceCacheDiskIsAccounted(join(root, 'not-created'), entries)).toBe(true);
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
});
it.each(['artifact', 'partial'] as const)('counts a known %s within its reserved byte ceiling', async (kind) => {
  await mkdir(join(root, id));
  await writeFile(join(root, id, artifact + (kind === 'partial' ? '.partial' : '')), Buffer.from('hello'));
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
});
it.each(['oversized', 'extra-bytes', 'unexpected-name', 'nested-directory', 'too-many-files'] as const)(
  'refuses %s without deleting source bytes',
  async (failure) => {
    const folder = await stage();
    switch (failure) {
      case 'oversized': {
        await writeFile(join(folder, artifact), Buffer.from('hello!'));
        break;
      }
      case 'extra-bytes': {
        await writeFile(join(folder, `${randomUUID()}.artifact`), 'x');
        break;
      }
      case 'unexpected-name': {
        await writeFile(join(folder, 'unaccounted'), '');
        break;
      }
      case 'nested-directory': {
        await mkdir(join(folder, `${randomUUID()}.artifact`));
        break;
      }
      case 'too-many-files': {
        await writeFile(join(folder, `${randomUUID()}.artifact`), '');
        await writeFile(join(folder, `${randomUUID()}.artifact`), '');
        break;
      }
    }
    expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(false);
    expect((await readFile(join(folder, artifact))).subarray(0, 5)).toEqual(Buffer.from('hello'));
  },
);
it.each(['root', 'object', 'file'] as const)('rejects a %s symlink and preserves its target', async (kind) => {
  const outside = await mkdtemp(join(tmpdir(), 'source-disk-target-'));
  try {
    const target = kind === 'root' ? join(outside, id) : outside;
    if (kind === 'root') await mkdir(target);
    await writeFile(join(target, artifact), 'hello');
    let inspected = root;
    if (kind === 'root') {
      inspected = join(root, 'linked');
      await symlink(outside, inspected);
    } else if (kind === 'object') await symlink(outside, join(root, id));
    else {
      await mkdir(join(root, id));
      await symlink(join(target, artifact), join(root, id, artifact));
    }
    expect(await sourceCacheDiskIsAccounted(inspected, [{ id, bytes: 1024 }])).toBe(false);
    expect(await readFile(join(target, artifact), 'utf8')).toBe('hello');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
it('refuses hardlinks rather than trusting an alias to another file', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'source-hardlink-target-'));
  try {
    const folder = await stage();
    await link(join(folder, artifact), join(outside, 'original'));
    expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(false);
    expect(await readFile(join(outside, 'original'), 'utf8')).toBe('hello');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

it('releases admission after a stalled probe without launching duplicate filesystem work or reusing another snapshot', async () => {
  vi.useFakeTimers();
  const stalled = Promise.withResolvers<never>();
  const probe = vi.spyOn(fs, 'lstat').mockImplementationOnce(() => stalled.promise);
  const attempts: Promise<boolean>[] = [];
  try {
    let finished = false;
    const first = sourceCacheDiskIsAccounted(root, entries).then((value) => {
      finished = true;
      return value;
    });
    attempts.push(first);
    await vi.advanceTimersByTimeAsync(5001);
    expect(finished).toBe(true);
    expect(await first).toBe(false);
    const second = sourceCacheDiskIsAccounted(root, entries);
    attempts.push(second);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await second).toBe(false);
    expect(await sourceCacheDiskIsAccounted(root, [{ id, bytes: 6 }])).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    stalled.reject(new Error('filesystem unavailable'));
    await vi.advanceTimersByTimeAsync(0);
    probe.mockRestore();
    expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
  } finally {
    stalled.reject(new Error('fixture cleanup'));
    await Promise.allSettled(attempts);
    vi.useRealTimers();
    probe.mockRestore();
  }
});

it('bounds ownership receipts separately while charging the entire original reservation', async () => {
  const folder = await stage();
  await writeFile(join(folder, 'closed.json'), 'x'.repeat(2048));
  await writeFile(join(folder, 'closed.json.partial'), '');
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
  await writeFile(join(folder, 'closed.json'), 'x'.repeat(2049));
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(false);
});
it('bounds reader metadata and refuses payload bytes hidden in a reader marker', async () => {
  const folder = await stage();
  const marker = join(folder, `reader-${randomUUID()}`);
  await writeFile(marker, '');
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
  await writeFile(marker, 'x');
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(false);
});

it.each(['root-stat', 'object-stat', 'payload-stat'] as const)(
  'starts no new filesystem probes after refusal while %s is pending',
  async (phase) => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const stalled = Promise.withResolvers<never>();
    const late: string[] = [];
    let expired = false;
    const directory = (names: string[]) => {
      const remaining = names.map((name) => ({ name }));
      const handle = {
        read: () => {
          if (expired) {
            late.push('read');
            return Promise.reject(new Error('late directory probe'));
          }
          return Promise.resolve(remaining.shift() ?? null);
        },
        close: () => Promise.resolve(),
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
      return handle;
    };
    const rootDirectory = directory([id]);
    const objectDirectory = directory([artifact, `${randomUUID()}.artifact`]);
    const stat = (path: unknown) =>
      path === root || path === join(root, id)
        ? { isDirectory: () => true }
        : { isFile: () => true, nlink: 1n, size: path === join(root, id, artifact) ? 5n : 0n, dev: 1n, ino: 1n };
    const paused = phase === 'root-stat' ? root : phase === 'object-stat' ? join(root, id) : join(root, id, artifact);
    const probe = vi.spyOn(fs, 'lstat').mockImplementation((path) => {
      if (path === paused && !expired) {
        entered.resolve();
        return stalled.promise;
      }
      if (expired) {
        late.push('stat');
        return Promise.reject(new Error('late stat probe'));
      }
      return Promise.resolve(stat(path) as never);
    });
    const directories = vi.spyOn(fs, 'opendir').mockImplementation((path) => {
      if (expired) {
        late.push('open');
        return Promise.reject(new Error('late open probe'));
      }
      return Promise.resolve((path === root ? rootDirectory : objectDirectory) as never);
    });
    const result = sourceCacheDiskIsAccounted(root, entries);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toBe(false);
      expired = true;
      stalled.resolve(stat(paused) as never);
      await vi.advanceTimersByTimeAsync(0);
      expect(late).toEqual([]);
      probe.mockRestore();
      directories.mockRestore();
      expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
    } finally {
      stalled.resolve(stat(paused) as never);
      await result;
      await vi.advanceTimersByTimeAsync(0);
      probe.mockRestore();
      directories.mockRestore();
      vi.useRealTimers();
    }
  },
);

it('retains root admission when an actual directory close remains unconfirmed', async () => {
  const actual = await fs.opendir(root);
  const originalClose = actual.close.bind(actual);
  const unknown = {
    read: actual.read.bind(actual),
    close: vi.fn(() => Promise.reject(new Error('directory close unconfirmed'))),
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const entry = await unknown.read();
          if (!entry) return;
          yield entry;
        }
      } finally {
        await unknown.close();
      }
    },
  };
  const opened = vi.spyOn(fs, 'opendir').mockResolvedValue(unknown as never);
  try {
    expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(false);
    expect(unknown.close).toHaveBeenCalledOnce();
    expect(await actual.read()).toBeNull();
    expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(false);
    expect(await sourceCacheDiskIsAccounted(root, [{ id, bytes: 6 }])).toBe(false);
    expect(opened).toHaveBeenCalledOnce();
  } finally {
    opened.mockRestore();
    await originalClose();
  }
});

it('does not admit a joined caller from a scan whose directory close outlived its deadline', async () => {
  vi.useFakeTimers();
  const closing = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const finish = () => {
    closing.resolve();
    return closed.promise;
  };
  const directory = {
    read: () => Promise.resolve(null),
    close: finish,
    [Symbol.asyncIterator]: () => ({
      next: () => finish().then(() => ({ done: true as const, value: undefined })),
    }),
  };
  const stat = vi.spyOn(fs, 'lstat').mockResolvedValue({ isDirectory: () => true } as never);
  const opened = vi.spyOn(fs, 'opendir').mockResolvedValue(directory as never);
  const first = sourceCacheDiskIsAccounted(root, entries);
  let second: Promise<boolean> | undefined;
  try {
    await closing.promise;
    await vi.advanceTimersByTimeAsync(4000);
    second = sourceCacheDiskIsAccounted(root, entries);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await first).toBe(false);
    closed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await second).toBe(false);
    expect(opened).toHaveBeenCalledOnce();
  } finally {
    closed.resolve();
    await Promise.allSettled([first, second]);
    stat.mockRestore();
    opened.mockRestore();
    vi.useRealTimers();
  }
  expect(await sourceCacheDiskIsAccounted(root, entries)).toBe(true);
});
