// Cases found in review: each one lost data, stopped a run for the wrong reason, or let one go on when it
// should have stopped.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile as readDisk, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChunkerParams,
  type Snapshot,
  type Source,
  type SourceEntry,
  ObjectExistsError,
  Repository,
  backup,
  chunkStream,
  dirStore,
  find,
  gearTable,
  listFolder,
  memoryStore,
  prune,
  readFile,
  restore,
  verify,
} from '../src/index.js';

const chunker: ChunkerParams = { min: 1024, avg: 4096, max: 16_384 };
const packTarget = 64 * 1024;
const rootKey = randomBytes(32);
const everything = { policy: { keepLast: 1, keepDays: 0, keepMonthly: 0 }, minAgeDays: 0, packTarget };

type Tree = { [name: string]: Buffer | Tree };
type Meta = Record<string, Partial<SourceEntry>>;

/** A source made of nested objects: a Buffer is a file, an object is a folder. `meta` overrides by path. */
function made(tree: Tree, meta: Meta = {}): Source {
  const at = (path: string[]) => path.reduce<Buffer | Tree>((node, name) => (node as Tree)[name]!, tree);
  return {
    async list(path) {
      return Object.entries(at(path) as Tree).map(([name, node]) => {
        const file = Buffer.isBuffer(node);
        return {
          name,
          type: file ? ('file' as const) : ('dir' as const),
          mode: file ? 0o644 : 0o755,
          uid: process.getuid?.() ?? 0,
          gid: process.getgid?.() ?? 0,
          mtime: 1_700_000_000_000,
          size: file ? node.length : 0,
          ...(file ? { key: createHash('sha256').update(node).digest('hex') } : {}),
          ...meta[[...path, name].join('/')],
        };
      });
    },
    async *read(path) {
      yield at(path) as Buffer;
    },
  };
}

const content = async (repository: Repository, snapshot: Snapshot, path: string[]) => {
  const parts: Buffer[] = [];
  for await (const chunk of readFile(repository, (await find(repository, snapshot, path))!)) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
};
const fresh = async () => {
  const store = memoryStore();
  return { store, repository: await Repository.init(store, { rootKey, chunker }) };
};

let work: string;
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'backup-core-hardening-'));
});
afterEach(() => rm(work, { recursive: true, force: true }));

describe('backup', () => {
  it('skips a file whose source fails the moment it is opened, and finishes', async () => {
    const inner = made({ 'good.bin': randomBytes(5000), 'locked.bin': randomBytes(10) });
    const source: Source = {
      list: (path) => inner.list(path),
      read(path) {
        if (path[0] === 'locked.bin') {
          throw new Error('permission denied');
        }
        return inner.read(path);
      },
    };
    const { repository } = await fresh();
    const result = await backup(repository, source, { packTarget });
    expect(result.problems).toEqual([{ path: ['locked.bin'], message: 'permission denied' }]);
    expect(result.snapshot.stats.files).toBe(1);
  });

  it('writes no snapshot once it has been told to stop, even with nothing left to read', async () => {
    const { repository } = await fresh();
    const source = made({ 'a.bin': randomBytes(5000), 'b.bin': randomBytes(5000) });
    await backup(repository, source, { packTarget });

    // Every file is unchanged, so no file is read: the stop must be noticed anyway.
    const stopped = new AbortController();
    stopped.abort();
    await expect(backup(repository, source, { packTarget, signal: stopped.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    // A stop that arrives after the last file: the folder listed last is empty, and the stop comes with it.
    const late = new AbortController();
    const inner = made({ 'a.bin': randomBytes(5000), 'c.bin': randomBytes(5000), 'zz-empty': {} });
    const stopping: Source = {
      list: (path) => (path[0] === 'zz-empty' ? (late.abort(), Promise.resolve([])) : inner.list(path)),
      read: (path) => inner.read(path),
    };
    await expect(backup(repository, stopping, { packTarget, signal: late.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect((await repository.listSnapshots()).length).toBe(1);
  });

  it('keeps what a folder held last time when it cannot be listed today', async () => {
    const tree = {
      docs: { 'a.txt': Buffer.from('alpha'), 'b.txt': Buffer.from('beta') },
      'top.txt': Buffer.from('top'),
    };
    const { repository } = await fresh();
    await backup(repository, made(tree), { packTarget });
    const inner = made(tree);
    const failing: Source = {
      list: (path) => (path[0] === 'docs' ? Promise.reject(new Error('drive went away')) : inner.list(path)),
      read: (path) => inner.read(path),
    };
    const second = await backup(repository, failing, { packTarget });
    expect(second.problems).toEqual([{ path: ['docs'], message: 'drive went away' }]);
    expect((await listFolder(repository, second.snapshot, ['docs'])).map((entry) => entry.name)).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect((await content(repository, second.snapshot, ['docs', 'b.txt'])).toString()).toBe('beta');
  });

  it('leaves out a name that would not restore inside its folder, and says so', async () => {
    const inner = made({ 'fine.txt': Buffer.from('fine'), victim: Buffer.from('evil') });
    const source: Source = {
      list: async (path) =>
        (await inner.list(path)).map((entry) => (entry.name === 'victim' ? { ...entry, name: '../victim' } : entry)),
      read: (path) => inner.read(path.map((name) => name.replace('../', ''))),
    };
    const { repository } = await fresh();
    const result = await backup(repository, source, { packTarget });
    expect(result.problems.map((problem) => problem.path)).toEqual([['../victim']]);
    expect((await listFolder(repository, result.snapshot, [])).map((entry) => entry.name)).toEqual(['fine.txt']);
  });
});

describe('chunker', () => {
  it('is not fooled by a source that hands over the same buffer with new bytes each time', async () => {
    const whole = randomBytes(40_000);
    async function* reusing() {
      const shared = Buffer.alloc(4096);
      for (let at = 0; at < whole.length; at += shared.length) {
        const length = whole.copy(shared, 0, at, at + shared.length);
        yield shared.subarray(0, length);
      }
    }
    const parts: Buffer[] = [];
    for await (const chunk of chunkStream(reusing(), chunker, gearTable(Buffer.alloc(32, 3)))) {
      parts.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(parts).equals(whole)).toBe(true);
  });
});

describe('prune and verify', () => {
  it('still protects a folder when a file somewhere has the very bytes of that folder’s listing', async () => {
    const { store, repository } = await fresh();
    const docs = { 'big.bin': randomBytes(30_000) };
    const first = await backup(repository, made({ docs }), { packTarget });
    // A file whose content is exactly the stored listing of `docs` gets the same id as that listing.
    const listing = await repository.readBlob((await find(repository, first.snapshot, ['docs']))!.tree!);
    const second = await backup(repository, made({ 'a-copy': listing, docs }), { packTarget });
    expect((await find(repository, second.snapshot, ['a-copy']))!.chunks).toEqual([
      (await find(repository, second.snapshot, ['docs']))!.tree,
    ]);

    await prune(repository, { ...everything, now: new Date(Date.now() + 86_400_000) });
    const reopened = await Repository.open(store, { rootKey });
    expect(await verify(reopened, { readPack: () => true })).toMatchObject({
      snapshots: 1,
      missing: [],
      damagedPacks: [],
    });
    expect((await content(reopened, second.snapshot, ['docs', 'big.bin'])).equals(docs['big.bin'])).toBe(true);
  });

  it('works around an index object that can no longer be opened, reports it, and replaces it', async () => {
    const { store, repository } = await fresh();
    const tree = { 'a.bin': randomBytes(20_000), 'b.bin': randomBytes(20_000) };
    const first = await backup(repository, made(tree), { packTarget });
    const [index] = await store.list('i/');
    const bytes = store.objects.get(index!.key)!;
    bytes[bytes.length - 1] = bytes.at(-1)! ^ 1;

    const reopened = await Repository.open(store, { rootKey });
    const again = await backup(reopened, made(tree), { packTarget });
    expect(again.unchanged).toBe(2);
    expect((await verify(reopened)).damagedIndexes).toEqual([index!.key]);
    expect((await content(reopened, first.snapshot, ['a.bin'])).equals(tree['a.bin'])).toBe(true);

    await prune(reopened, { ...everything, now: new Date(Date.now() + 86_400_000) });
    expect((await store.list('i/')).map((object) => object.key)).not.toContain(index!.key);
    expect(await verify(await Repository.open(store, { rootKey }), { readPack: () => true })).toMatchObject({
      missing: [],
      damagedIndexes: [],
      damagedPacks: [],
    });
  });
});

describe('restore', () => {
  it('keeps a date before 1970, a read-only folder’s mode and a file’s exact mode', async () => {
    const tree = { old: { 'letter.txt': Buffer.from('dear all') } };
    const meta: Meta = { old: { mode: 0o555 }, 'old/letter.txt': { mode: 0o664, mtime: -86_400_000 } };
    const { repository } = await fresh();
    const { snapshot } = await backup(repository, made(tree, meta), { packTarget });
    const target = join(work, 'out');
    await restore(repository, snapshot, [], target);
    try {
      const file = await lstat(join(target, 'old', 'letter.txt'));
      expect(Math.floor(file.mtimeMs)).toBe(-86_400_000);
      expect(file.mode & 0o777).toBe(0o664);
      expect((await lstat(join(target, 'old'))).mode & 0o777).toBe(0o555);
      expect((await readDisk(join(target, 'old', 'letter.txt'))).toString()).toBe('dear all');
    } finally {
      await chmod(join(target, 'old'), 0o755);
    }
  });

  it('never moves something aside onto something moved aside before', async () => {
    const { repository } = await fresh();
    const { snapshot } = await backup(repository, made({ 'notes.txt': Buffer.from('from the backup') }), {
      packTarget,
    });
    const target = join(work, 'out');
    await mkdir(target);
    await writeFile(join(target, 'notes.txt'), 'mine, first');
    const aside = (path: string) => `${path}.kept`;

    await restore(repository, snapshot, [], target, { aside });
    await writeFile(join(target, 'notes.txt'), 'mine, second');
    const second = await restore(repository, snapshot, [], target, { aside });

    expect(second.movedAside).toEqual([{ from: join(target, 'notes.txt'), to: join(target, 'notes.txt.kept-2') }]);
    expect((await readDisk(join(target, 'notes.txt.kept'))).toString()).toBe('mine, first');
    expect((await readDisk(join(target, 'notes.txt.kept-2'))).toString()).toBe('mine, second');
    expect((await readDisk(join(target, 'notes.txt'))).toString()).toBe('from the backup');
  });
});

describe('storage', () => {
  it('never replaces an object, and leaves no half-written file behind', async () => {
    const store = dirStore(join(work, 'storage'));
    await store.put('p/aa', Buffer.from('first'));
    await expect(store.put('p/aa', Buffer.from('second'))).rejects.toBeInstanceOf(ObjectExistsError);
    expect((await store.get('p/aa')).toString()).toBe('first');
    expect(await readdir(join(work, 'storage', 'p'))).toEqual(['aa']);

    const memory = memoryStore();
    await memory.put('config', Buffer.from('first'));
    await expect(memory.put('config', Buffer.from('second'))).rejects.toBeInstanceOf(ObjectExistsError);
  });

  it('does not mistake storage it cannot read for storage that is empty', async () => {
    const store = dirStore(join(work, 'storage'));
    const repository = await Repository.init(store, { rootKey, chunker });
    await backup(repository, made({ 'a.bin': randomBytes(3000) }), { packTarget });
    const config = await readDisk(join(work, 'storage', 'config'));

    // Not there yet is empty; there but not a folder is a failure, not "nothing stored".
    expect(await dirStore(join(work, 'nowhere')).list('')).toEqual([]);
    await writeFile(join(work, 'a-file'), 'x');
    await expect(dirStore(join(work, 'a-file')).list('')).rejects.toMatchObject({ code: 'ENOTDIR' });

    // And starting a repository where one exists is refused, with the old one untouched.
    await expect(Repository.init(store, { rootKey: randomBytes(32), chunker })).rejects.toThrow(
      'already holds a repository',
    );
    expect((await readDisk(join(work, 'storage', 'config'))).equals(config)).toBe(true);
  });
});
