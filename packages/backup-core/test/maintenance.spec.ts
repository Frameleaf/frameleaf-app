import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ChunkerParams,
  type Snapshot,
  type Source,
  type Store,
  Repository,
  backup,
  find,
  memoryStore,
  prune,
  readFile,
  retain,
  verify,
} from '../src/index.js';

const chunker: ChunkerParams = { min: 1024, avg: 4096, max: 16_384 };
const packTarget = 64 * 1024;
const rootKey = randomBytes(32);
const DAY = 86_400_000;
const everything = { policy: { keepLast: 1, keepDays: 0, keepMonthly: 0 }, minAgeDays: 0, packTarget };

function noise(length: number, seed: number) {
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

/** A flat folder made of buffers. */
const folder = (files: Record<string, Buffer>): Source => ({
  async list() {
    return Object.entries(files).map(([name, body]) => ({
      name,
      type: 'file' as const,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: 0,
      size: body.length,
      key: createHash('sha256').update(body).digest('hex'),
    }));
  },
  async *read(path) {
    yield files[path[0]!]!;
  },
});

const content = async (repository: Repository, snapshot: Snapshot, name: string) => {
  const parts: Buffer[] = [];
  for await (const chunk of readFile(repository, (await find(repository, snapshot, [name]))!)) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
};

const first = { 'a-small.bin': noise(10_000, 1), 'b-old.bin': noise(200_000, 2), 'c-keep.bin': noise(60_000, 3) };
const second = {
  'a-small.bin': first['a-small.bin'],
  'c-keep.bin': first['c-keep.bin'],
  'd-new.bin': noise(30_000, 4),
};

/** Two backups: the second no longer has the large file. */
async function twoBackups() {
  const store = memoryStore();
  const repository = await Repository.init(store, { rootKey, chunker });
  const a = await backup(repository, folder(first), { packTarget });
  const b = await backup(repository, folder(second), { packTarget });
  return { store, repository, a, b };
}

const size = (store: { objects: Map<string, Buffer> }) =>
  [...store.objects.values()].reduce((sum, body) => sum + body.length, 0);

const copy = (store: { objects: Map<string, Buffer> }) => {
  const clone = memoryStore();
  for (const [key, body] of store.objects) {
    clone.objects.set(key, Buffer.from(body));
  }
  return clone;
};

const whole = async (store: Store, snapshotKey: string) => {
  const repository = await Repository.open(store, { rootKey });
  const report = await verify(repository, { readPack: () => true });
  expect(report).toMatchObject({ missing: [], damagedPacks: [], damagedSnapshots: [] });
  const snapshot = await repository.readSnapshot(snapshotKey);
  for (const [name, body] of Object.entries(second)) {
    expect((await content(repository, snapshot, name)).equals(body)).toBe(true);
  }
  return report;
};

describe('retain', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const at = (time: string) => ({ key: time, time });
  it('keeps recent backups, then the newest of each month, and always the last few', () => {
    const snapshots = [
      at('2025-09-01T02:00:00Z'),
      at('2026-06-10T02:00:00Z'),
      at('2026-07-01T02:00:00Z'),
      at('2026-07-20T02:00:00Z'),
      at('2026-11-12T02:00:00Z'),
      at('2026-11-13T02:00:00Z'),
      at('2026-11-15T02:00:00Z'),
      at('2026-11-16T02:00:00Z'),
      at('2026-11-17T02:00:00Z'),
    ];
    expect([...retain(snapshots, { keepLast: 1, keepDays: 3, keepMonthly: 6 }, now)].sort()).toEqual([
      '2026-06-10T02:00:00Z',
      '2026-07-20T02:00:00Z',
      '2026-11-13T02:00:00Z',
      '2026-11-15T02:00:00Z',
      '2026-11-16T02:00:00Z',
      '2026-11-17T02:00:00Z',
    ]);
  });

  it('never empties a repository, even with a clock set years ahead', () => {
    const snapshots = [at('2026-11-15T02:00:00Z'), at('2026-11-16T02:00:00Z'), at('not a date')];
    const kept = retain(snapshots, { keepLast: 1, keepDays: 0, keepMonthly: 0 }, new Date('2040-01-01T00:00:00Z'));
    expect([...kept].sort()).toEqual(['not a date']);
    expect(
      retain(snapshots.slice(0, 2), { keepLast: 0, keepDays: 0, keepMonthly: 0 }, new Date('2040-01-01T00:00:00Z'))
        .size,
    ).toBe(1);
  });
});

describe('prune', () => {
  it('removes an old backup and the data only it needed; what is left restores exactly', async () => {
    const { store, repository, a, b } = await twoBackups();
    const before = size(store);
    const report = await prune(repository, { ...everything, now: new Date(Date.now() + DAY) });

    expect(report).toMatchObject({ keptSnapshots: 1, removedSnapshots: [a.key] });
    expect(report.deletedPacks).toBeGreaterThanOrEqual(3);
    expect(report.repackedPacks).toBeGreaterThanOrEqual(1);
    expect(before - size(store)).toBeGreaterThan(180_000);
    expect((await store.list('i/')).length).toBe(1);
    await whole(store, b.key);

    // The next backup of the same files sends nothing and still finds everything.
    const again = await backup(await Repository.open(store, { rootKey }), folder(second), { packTarget });
    expect(again.snapshot.stats.storedBytes).toBe(0);
    expect(again.unchanged).toBe(3);
  });

  it('leaves packs younger than the minimum age alone', async () => {
    const { store, repository, a, b } = await twoBackups();
    const packs = (await store.list('p/')).length;
    const report = await prune(repository, { policy: everything.policy, now: new Date(Date.now() + DAY) });
    expect(report).toMatchObject({ removedSnapshots: [a.key], deletedPacks: 0, repackedPacks: 0 });
    expect((await store.list('p/')).length).toBe(packs);
    await whole(store, b.key);
  });

  it('refuses to thin a repository in which a kept backup is missing a piece', async () => {
    const { store, repository, b } = await twoBackups();
    const snapshot = await repository.readSnapshot(b.key);
    const chunk = (await find(repository, snapshot, ['d-new.bin']))!.chunks![0]!;
    await store.delete(repository.index.get(chunk)!.pack);
    await expect(prune(repository, { ...everything, now: new Date(Date.now() + DAY) })).rejects.toThrow();
    expect((await repository.listSnapshots()).length).toBe(2);
  });

  it('is safe to stop at any step: every remaining backup stays whole, and a second run finishes the job', async () => {
    const { store, b } = await twoBackups();
    const now = new Date(Date.now() + DAY);
    let finished = false;
    for (let stopAt = 1; !finished; stopAt++) {
      expect(stopAt).toBeLessThan(200);
      const attempt = copy(store);
      let changes = 0;
      const dying: Store = {
        get: (key, range) => attempt.get(key, range),
        list: (prefix) => attempt.list(prefix),
        // From the chosen step on, nothing more reaches storage: the process is gone.
        put: (key, body) => (++changes >= stopAt ? Promise.reject(new Error('stopped')) : attempt.put(key, body)),
        delete: (key) => (++changes >= stopAt ? Promise.reject(new Error('stopped')) : attempt.delete(key)),
      };
      await prune(await Repository.open(dying, { rootKey }), { ...everything, now }).then(
        () => (finished = true),
        (error: Error) => expect(error.message).toBe('stopped'),
      );
      await whole(attempt, b.key);
      await prune(await Repository.open(attempt, { rootKey }), { ...everything, now });
      await whole(attempt, b.key);
      expect((await attempt.list('s/')).map((object) => object.key)).toEqual([b.key]);
    }
  });

  it('only says what it would remove when asked for a dry run', async () => {
    const { store, repository, a } = await twoBackups();
    const before = [...store.objects.keys()].toSorted();
    const now = new Date(Date.now() + DAY);
    const preview = await prune(repository, { ...everything, now, dryRun: true });

    expect([...store.objects.keys()].toSorted()).toEqual(before);
    expect(preview).toMatchObject({ keptSnapshots: 1, removedSnapshots: [a.key] });
    const done = await prune(await Repository.open(store, { rootKey }), { ...everything, now });
    expect(done).toMatchObject({
      removedSnapshots: preview.removedSnapshots,
      deletedPacks: preview.deletedPacks,
      repackedPacks: preview.repackedPacks,
    });
    // The estimate leaves out only the few bytes each new pack adds for itself.
    expect(preview.freedBytes).toBeGreaterThanOrEqual(done.freedBytes);
    expect(preview.freedBytes - done.freedBytes).toBeLessThan(4096);
  });

  it('keeps what the caller chooses, and the newest backup whatever it chooses', async () => {
    const { store, repository, a, b } = await twoBackups();
    const now = new Date(Date.now() + DAY);
    const seen: string[][] = [];
    const kept = await prune(repository, {
      minAgeDays: 0,
      packTarget,
      now,
      keep: (snapshots) => {
        seen.push(snapshots.map((snapshot) => snapshot.key));
        return [a.key, 's/000000000099-0000000000000000'];
      },
    });
    // The older one was asked for, the newest is kept anyway, and a name that is not a backup counts for nothing.
    expect(seen).toEqual([[a.key, b.key]]);
    expect(kept).toMatchObject({ keptSnapshots: 2, removedSnapshots: [] });

    const emptied = await prune(await Repository.open(store, { rootKey }), {
      minAgeDays: 0,
      packTarget,
      now,
      keep: () => [],
    });
    expect(emptied).toMatchObject({ keptSnapshots: 1, removedSnapshots: [a.key] });
    await whole(store, b.key);
  });
});

describe('verify', () => {
  it('passes a healthy repository and names what is missing or damaged', async () => {
    const { store, repository, a, b } = await twoBackups();
    expect(await verify(repository, { readPack: () => true })).toMatchObject({
      snapshots: 2,
      missing: [],
      damagedPacks: [],
      damagedSnapshots: [],
      packsRead: (await store.list('p/')).length,
    });

    // Remove a pack the newer backup needs, and change one byte in another pack.
    const newer = await repository.readSnapshot(b.key);
    const gone = repository.index.get((await find(repository, newer, ['d-new.bin']))!.chunks![0]!)!.pack;
    const hurt = (await store.list('p/')).map((object) => object.key).find((key) => key !== gone)!;
    await store.delete(gone);
    const damaged = store.objects.get(hurt)!;
    damaged[5] = damaged[5]! ^ 1;
    const sealed = store.objects.get(a.key)!;
    sealed[20] = sealed[20]! ^ 1;

    const report = await verify(repository, { readPack: () => true });
    expect(report.damagedPacks).toEqual([hurt]);
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.damagedSnapshots).toEqual([a.key]);
    expect(report.snapshots).toBe(1);
  });
});

describe('a backup that cannot go on', () => {
  it('ends when storage fails, instead of calling the file unreadable', async () => {
    const store = memoryStore();
    const failing: Store = {
      ...store,
      put: (key, body) => (key.startsWith('p/') ? Promise.reject(new Error('disk full')) : store.put(key, body)),
    };
    const repository = await Repository.open(await Repository.init(store, { rootKey, chunker }).then(() => failing), {
      rootKey,
    });
    await expect(backup(repository, folder(first), { packTarget })).rejects.toThrow('disk full');
    expect(await store.list('s/')).toEqual([]);
  });

  it('keeps what it stored when it is stopped, so the next run sends none of it again', async () => {
    const store = memoryStore();
    const repository = await Repository.init(store, { rootKey, chunker });
    const stop = new AbortController();
    const inner = folder(first);
    const source: Source = {
      list: (path) => inner.list(path),
      read: (path) => (path[0] === 'c-keep.bin' && stop.abort(), inner.read(path)),
    };
    const stopped = await backup(repository, source, { packTarget, signal: stop.signal }).catch(
      (error: Error) => error,
    );
    expect((stopped as Error).name).toBe('AbortError');
    expect(await store.list('s/')).toEqual([]);
    expect((await store.list('p/')).length).toBeGreaterThan(2);

    const reopened = await Repository.open(store, { rootKey });
    const resumed = await backup(reopened, folder(first), { packTarget });
    expect(resumed.snapshot.stats.storedBytes).toBeLessThan(80_000);
    expect((await content(reopened, resumed.snapshot, 'b-old.bin')).equals(first['b-old.bin'])).toBe(true);
  });
});
