import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile as readDisk,
  readdir,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChunkerParams,
  type Source,
  type SourceEntry,
  Repository,
  UnsealError,
  backup,
  blobId,
  chunkStream,
  deriveKeys,
  dirStore,
  find,
  fsSource,
  gearTable,
  listFolder,
  memoryStore,
  readFile,
  restore,
} from '../src/index.js';

// Small chunks keep the tests quick; the logic is the same at any size.
const chunker: ChunkerParams = { min: 1024, avg: 4096, max: 16_384 };
const packTarget = 64 * 1024;

/** The same bytes every run, so chunk boundaries can be pinned. */
function noise(length: number, seed = 1) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return out;
}

async function* once(data: Buffer, step = 7000) {
  for (let at = 0; at < data.length; at += step) {
    yield data.subarray(at, at + step);
  }
}

const cuts = async (data: Buffer, key: Buffer, step?: number) => {
  const sizes: number[] = [];
  for await (const chunk of chunkStream(once(data, step), chunker, gearTable(key))) {
    sizes.push(chunk.length);
  }
  return sizes;
};

/** Every file under a folder, with a hash of its content. */
async function manifest(root: string, at = ''): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of (await readdir(join(root, at))).sort()) {
    const path = join(at, name);
    const info = await lstat(join(root, path));
    if (info.isDirectory()) {
      Object.assign(found, { [`${path}/`]: 'folder' }, await manifest(root, path));
    } else if (info.isSymbolicLink()) {
      found[path] = `link:${await readlink(join(root, path))}`;
    } else {
      found[path] = createHash('sha256')
        .update(await readDisk(join(root, path)))
        .digest('hex');
    }
  }
  return found;
}

let work: string;
let library: string;
const rootKey = randomBytes(32);

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'backup-core-'));
  library = join(work, 'library');
  await mkdir(join(library, 'Documents', 'Tax'), { recursive: true });
  await mkdir(join(library, 'empty'));
  await writeFile(join(library, 'Documents', 'Tax', 'Return 2025.xlsx'), noise(50_000, 2));
  await writeFile(join(library, 'Documents', 'notes.txt'), 'remember the milk\n'.repeat(400));
  await writeFile(join(library, 'big.bin'), noise(300_000, 3));
  await writeFile(join(library, 'nothing'), '');
  await symlink('Documents/notes.txt', join(library, 'link'));
});
afterEach(() => rm(work, { recursive: true, force: true }));

describe('chunker', () => {
  it('cuts the same bytes the same way however they arrive, and differently under another key', async () => {
    const data = noise(200_000);
    const key = Buffer.alloc(32, 7);
    const sizes = await cuts(data, key);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(data.length);
    expect(sizes.slice(0, -1).every((size) => size > chunker.min && size <= chunker.max)).toBe(true);
    expect(await cuts(data, key, 333)).toEqual(sizes);
    expect(await cuts(data, key, 1_000_000)).toEqual(sizes);
    expect(await cuts(data, Buffer.alloc(32, 8))).not.toEqual(sizes);
  });

  it('finds the old boundaries again after bytes are inserted near the start', async () => {
    const data = noise(200_000);
    const key = Buffer.alloc(32, 7);
    const hashes = async (input: Buffer) => {
      const seen = new Set<string>();
      for await (const chunk of chunkStream(once(input), chunker, gearTable(key))) {
        seen.add(createHash('sha256').update(chunk).digest('hex'));
      }
      return seen;
    };
    const before = await hashes(data);
    const after = await hashes(
      Buffer.concat([data.subarray(0, 500), Buffer.from('a few new bytes'), data.subarray(500)]),
    );
    const kept = [...after].filter((hash) => before.has(hash)).length;
    expect(kept).toBeGreaterThan(after.size * 0.8);
  });

  // Golden values: another implementation of this format must produce exactly these.
  it('matches the pinned vectors', async () => {
    const keys = deriveKeys(Buffer.alloc(32, 1), '00000000-0000-4000-8000-000000000000');
    expect(keys.id.toString('hex')).toBe('2dea066050be60054b2d154c58e6a55ad8c19b60767f25e8dea028f772292897');
    expect(keys.cut.toString('hex')).toBe('023c077490b2650e26f330a1bbc7227baf29922afde58c3df983ee917c7bccdf');
    expect([...gearTable(keys.cut).subarray(0, 4)]).toEqual([
      1_285_107_895, 1_290_597_550, 3_046_091_720, 4_054_664_066,
    ]);
    expect(blobId(keys, Buffer.from('frameleaf')).toString('hex')).toBe(
      '7a846dc5b149eaf4ade5871532800c13423818c647f94bebbddd42d7b9e6430f',
    );
    expect(await cuts(noise(100_000, 42), keys.cut)).toEqual([
      2513, 4710, 5595, 7257, 4552, 4568, 6708, 4478, 2803, 5209, 1073, 5284, 6510, 4440, 4717, 4238, 4905, 3219, 7723,
      4148, 4220, 1130,
    ]);
  });
});

describe('repository', () => {
  const fresh = async () => {
    const store = dirStore(join(work, 'storage'));
    return { store, repository: await Repository.init(store, { rootKey, chunker }) };
  };

  it('brings back everything exactly, then one folder, then one file', async () => {
    const { store, repository } = await fresh();
    const first = await backup(repository, fsSource(library), { packTarget });
    expect(first.problems).toEqual([]);
    expect(first.snapshot.stats).toMatchObject({ files: 4, folders: 3, bytes: 50_000 + 7200 + 300_000 });

    // A second process with only the storage and the key.
    const reopened = await Repository.open(store, { rootKey });
    await reopened.loadIndex();
    const snapshot = await reopened.readSnapshot(first.key);

    const all = await restore(reopened, snapshot, [], join(work, 'all'));
    expect(await manifest(join(work, 'all'))).toEqual(await manifest(library));
    expect(all).toMatchObject({ files: 4, movedAside: [] });
    const restored = await lstat(join(work, 'all', 'Documents', 'notes.txt'));
    expect(Math.floor(restored.mtimeMs)).toBe(
      Math.floor((await lstat(join(library, 'Documents', 'notes.txt'))).mtimeMs),
    );

    await restore(reopened, snapshot, ['Documents', 'Tax'], join(work, 'folder'));
    expect(await manifest(join(work, 'folder'))).toEqual({
      'Tax/': 'folder',
      'Tax/Return 2025.xlsx': (await manifest(library))['Documents/Tax/Return 2025.xlsx'],
    });

    await restore(reopened, snapshot, ['big.bin'], join(work, 'file'));
    expect(await readDisk(join(work, 'file', 'big.bin'))).toEqual(noise(300_000, 3));

    expect((await listFolder(reopened, snapshot, ['Documents'])).map((entry) => entry.name)).toEqual([
      'Tax',
      'notes.txt',
    ]);
    expect(await find(reopened, snapshot, ['Documents', 'missing'])).toBeNull();
  });

  it('sends nothing new and reads no unchanged file on a second run', async () => {
    const { store, repository } = await fresh();
    await backup(repository, fsSource(library), { packTarget });
    const before = (await store.list('p/')).length;

    const reads: string[] = [];
    const inner = fsSource(library);
    const watched: Source = {
      list: (path) => inner.list(path),
      read: (path) => (reads.push(path.join('/')), inner.read(path)),
    };
    const second = await backup(repository, watched, { packTarget });

    expect(reads).toEqual([]);
    expect(second.unchanged).toBe(4);
    expect(second.snapshot.stats.storedBytes).toBe(0);
    expect((await store.list('p/')).length).toBe(before);
    expect(second.snapshot).toMatchObject({ seq: 2, parent: (await repository.listSnapshots())[0]!.key });
  });

  it('stores only the changed part of an edited file, and keeps the earlier version', async () => {
    const { repository } = await fresh();
    const first = await backup(repository, fsSource(library), { packTarget });
    const edited = Buffer.concat([
      noise(300_000, 3).subarray(0, 1000),
      Buffer.from('inserted'),
      noise(300_000, 3).subarray(1000),
    ]);
    await writeFile(join(library, 'big.bin'), edited);
    await utimes(join(library, 'big.bin'), new Date(), new Date(Date.now() + 5000));
    const second = await backup(repository, fsSource(library), { packTarget });

    expect(second.unchanged).toBe(3);
    expect(second.snapshot.stats.storedBytes).toBeLessThan(60_000);
    const read = async (key: string) => {
      const snapshot = await repository.readSnapshot(key);
      const parts: Buffer[] = [];
      for await (const chunk of readFile(repository, (await find(repository, snapshot, ['big.bin']))!)) {
        parts.push(chunk);
      }
      return Buffer.concat(parts);
    };
    expect(await read(second.key)).toEqual(edited);
    expect(await read(first.key)).toEqual(noise(300_000, 3));
  });

  it('moves aside what is in the way and deletes nothing', async () => {
    const { repository } = await fresh();
    const { snapshot } = await backup(repository, fsSource(library), { packTarget });
    const target = join(work, 'target');
    await mkdir(join(target, 'Documents'), { recursive: true });
    await writeFile(join(target, 'Documents', 'notes.txt'), 'newer words');
    await writeFile(join(target, 'Documents', 'mine.txt'), 'untouched');

    const result = await restore(repository, snapshot, [], target, { aside: (path) => `${path}.kept` });
    expect(result.movedAside).toEqual([
      { from: join(target, 'Documents', 'notes.txt'), to: join(target, 'Documents', 'notes.txt.kept') },
    ]);
    expect((await readDisk(join(target, 'Documents', 'notes.txt.kept'))).toString()).toBe('newer words');
    expect((await readDisk(join(target, 'Documents', 'mine.txt'))).toString()).toBe('untouched');
    expect((await readDisk(join(target, 'Documents', 'notes.txt'))).toString()).toBe('remember the milk\n'.repeat(400));
  });

  it('refuses the wrong key and notices changed bytes', async () => {
    const { store, repository } = await fresh();
    const { key } = await backup(repository, fsSource(library), { packTarget });
    await expect(Repository.open(store, { rootKey: randomBytes(32) })).rejects.toBeInstanceOf(UnsealError);

    const sealed = await store.get(key);
    sealed[20] = sealed[20]! ^ 1;
    await store.put(key, sealed);
    await expect(repository.readSnapshot(key)).rejects.toBeInstanceOf(UnsealError);
  });

  it('keeps names and content out of storage', async () => {
    const store = memoryStore();
    const repository = await Repository.init(store, { rootKey, chunker });
    await backup(repository, fsSource(library), { packTarget });

    expect(
      [...store.objects.keys()].every((key) =>
        /^(config|p\/[0-9a-f]{32}|i\/[0-9a-f]{32}|s\/\d{12}-[0-9a-f]{16})$/.test(key),
      ),
    ).toBe(true);
    const everything = Buffer.concat([...store.objects.values()]);
    for (const secret of ['Return 2025', 'notes.txt', 'Documents', 'remember the milk']) {
      expect(everything.includes(secret)).toBe(false);
    }
    expect(everything.includes(noise(300_000, 3).subarray(0, 64))).toBe(false);
  });

  it('loses nothing when a run stops before its index or snapshot is written', async () => {
    const { store, repository } = await fresh();
    const first = await backup(repository, fsSource(library), { packTarget });

    // Stop the next run at its index: its packs are stored, nothing points at them.
    await writeFile(join(library, 'new.bin'), noise(120_000, 9));
    const failing = {
      ...store,
      put: (key: string, body: Buffer) =>
        key.startsWith('i/') ? Promise.reject(new Error('connection lost')) : store.put(key, body),
    };
    const interrupted = await Repository.open(failing, { rootKey });
    await expect(backup(interrupted, fsSource(library), { packTarget })).rejects.toThrow('connection lost');
    expect((await repository.listSnapshots()).map((item) => item.key)).toEqual([first.key]);

    // The next run adopts those packs from their trailers and sends the new file's content no second time.
    const resumed = await Repository.open(store, { rootKey });
    const second = await backup(resumed, fsSource(library), { packTarget });
    expect(second.snapshot.stats.storedBytes).toBeLessThan(20_000);
    await restore(resumed, second.snapshot, [], join(work, 'after'));
    expect(await manifest(join(work, 'after'))).toEqual(await manifest(library));
  });

  it('ignores an index that points at a pack which is gone, and reads the file again', async () => {
    const { store, repository } = await fresh();
    await backup(repository, fsSource(library), { packTarget });
    for (const pack of await store.list('p/')) {
      await store.delete(pack.key);
    }
    const second = await backup(repository, fsSource(library), { packTarget });
    expect(second.unchanged).toBe(0);
    await restore(repository, second.snapshot, [], join(work, 'again'));
    expect(await manifest(join(work, 'again'))).toEqual(await manifest(library));
  });

  it('backs up a tree the caller makes up, skipping files whose key is unchanged', async () => {
    const files: Record<string, { body: Buffer; key: string }> = {
      'catalog.json': { body: Buffer.from('{"albums":3}'), key: 'v1' },
      'originals/a.jpg': { body: noise(40_000, 5), key: 'sha-a' },
    };
    const reads: string[] = [];
    const entry = (name: string, type: SourceEntry['type'], size = 0, key?: string): SourceEntry => ({
      name,
      type,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: 0,
      size,
      ...(key ? { key } : {}),
    });
    const source: Source = {
      async list(path) {
        return path.length === 0
          ? [
              entry('catalog.json', 'file', files['catalog.json']!.body.length, files['catalog.json']!.key),
              entry('originals', 'dir'),
            ]
          : [entry('a.jpg', 'file', files['originals/a.jpg']!.body.length, files['originals/a.jpg']!.key)];
      },
      read(path) {
        reads.push(path.join('/'));
        return once(files[path.join('/')]!.body);
      },
    };
    const repository = await Repository.init(memoryStore(), { rootKey, chunker });
    await backup(repository, source, { packTarget });
    files['catalog.json'] = { body: Buffer.from('{"albums":4}'), key: 'v2' };
    reads.length = 0;
    const second = await backup(repository, source, { packTarget });
    expect(reads).toEqual(['catalog.json']);
    expect(second.unchanged).toBe(1);
  });

  it('numbers a snapshot as asked and passes on the version storage gave it', async () => {
    const inner = memoryStore();
    const versioned = {
      ...inner,
      put: async (key: string, body: Buffer) => (await inner.put(key, body), { versionId: `v-${key}` }),
    };
    const repository = await Repository.init(versioned, { rootKey, chunker });
    const first = await backup(repository, fsSource(library), { packTarget, sequence: 7 });
    expect(first.snapshot.seq).toBe(7);
    expect(first.key).toMatch(/^s\/000000000007-[0-9a-f]{16}$/);
    expect(first.versionId).toBe(`v-${first.key}`);
    // The same number again, as after a run whose record was never made: both are kept, the later name wins ties.
    const again = await backup(repository, fsSource(library), { packTarget, sequence: 7 });
    expect((await repository.listSnapshots()).map((item) => item.seq)).toEqual([7, 7]);
    expect(again.unchanged).toBe(4);
    await expect(backup(repository, fsSource(library), { packTarget, sequence: 0 })).rejects.toThrow(RangeError);
  });

  it('reports a file it cannot read and still finishes', async () => {
    const inner = fsSource(library);
    const source: Source = {
      list: (path) => inner.list(path),
      read: (path) =>
        path.at(-1) === 'nothing'
          ? (async function* () {
              throw new Error('permission denied');
            })()
          : inner.read(path),
    };
    const { repository } = await fresh();
    const result = await backup(repository, source, { packTarget });
    expect(result.problems).toEqual([{ path: ['nothing'], message: 'permission denied' }]);
    expect(result.snapshot.stats.files).toBe(3);
  });
});
