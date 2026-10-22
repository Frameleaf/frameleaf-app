import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { tryPromise } from 'src/utils/promise.js';
import type { DB } from 'src/schema/index.js';
import { AssetLockReason, AssetType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { mediumFactory } from 'test/medium.factory.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('Live Photo asset-edit transaction', () => {
  let db: Kysely<DB>;
  let sut: AssetRepository;
  let queries: { sql: string; parameters: readonly unknown[]; connection: number }[];
  let groups: string[][];
  let reads: number;
  let changed: boolean;
  let missing: boolean;
  let contended: boolean;
  let rolledBack: boolean;
  let committed: boolean;
  beforeEach(() => {
    queries = [];
    groups = [
      ['photo', 'old', 'sibling'],
      ['photo', 'old', 'sibling'],
    ];
    reads = 0;
    changed = missing = contended = rolledBack = committed = false;
    let connections = 0;
    class Driver extends DummyDriver {
      commitTransaction() {
        committed = true;
        return Promise.resolve();
      }
      rollbackTransaction() {
        rolledBack = true;
        return Promise.resolve();
      }
      acquireConnection() {
        const connection = ++connections;
        return Promise.resolve({
          executeQuery: (query: { sql: string; parameters: readonly unknown[] }) =>
            tryPromise(() => {
              queries.push({ ...query, connection });
              if (query.sql.includes('for update nowait') && contended)
                throw Object.assign(new Error('busy'), { code: '55P03' });
              if (query.sql.includes('with direct as'))
                return { rows: (groups.shift() ?? []).map((id) => ({ id })) } as never;
              if (query.sql.includes('from "asset"') && !query.sql.includes('for update')) {
                reads++;
                return {
                  rows: missing ? [] : [{ id: 'photo', livePhotoVideoId: changed && reads > 1 ? 'other' : 'old' }],
                } as never;
              }
              return { rows: [] } as never;
            }),
          async *streamQuery(): AsyncGenerator<never> {},
        });
      }
    }
    const dialect = new PostgresDialect({ pool: {} as never });
    dialect.createDriver = () => new Driver();
    db = new Kysely<DB>({ dialect });
    sut = new AssetRepository(db);
  });
  afterEach(() => db.destroy());

  it('locks all old/new parts and stack members in canonical order, then binds both repositories to the transaction', async () => {
    await sut.withLivePhotoUpdate('PHOTO', 'VIDEO', async (assets, access) => {
      expect(assets).toBeInstanceOf(AssetRepository);
      expect(access).toBeInstanceOf(AccessRepository);
      await assets.update({ id: 'photo', livePhotoVideoId: 'video' });
      await access.asset.checkOwnerAccess('owner', new Set(['photo']), false);
    });
    const metadata = queries.filter((q) => q.sql.includes('pg_advisory_xact_lock'));
    expect(metadata.map((q) => q.parameters)).toEqual([['old'], ['photo'], ['sibling'], ['video']]);
    const rowLock = queries.find((q) => q.sql.includes('for update nowait'))!;
    expect(rowLock.sql).toContain('order by "id" for update nowait');
    expect(rowLock.parameters).toEqual(['old', 'photo', 'sibling', 'video']);
    expect(queries.slice(2).every((q) => q.connection === rowLock.connection)).toBe(true);
    expect(queries.filter((q) => q.sql.includes('with direct as'))).toHaveLength(2);
    expect(committed).toBe(true);
    expect(rolledBack).toBe(false);
  });

  it.each(['relationship', 'group', 'row contention'])(
    'refuses a changed %s before invoking the writer',
    async (stage) => {
      changed = stage === 'relationship';
      if (stage === 'group') groups[1].push('new-member');
      contended = stage === 'row contention';
      const write = vi.fn();
      await expect(sut.withLivePhotoUpdate('photo', 'video', write)).rejects.toThrow('retry the update');
      expect(write).not.toHaveBeenCalled();
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    },
  );

  it.each([undefined, '40P01'])(
    'rolls back writer failure %s and translates a deadlock into a retryable conflict',
    async (code) => {
      const error = Object.assign(new Error('write failed'), { code });
      await expect(
        sut.withLivePhotoUpdate('photo', null, () =>
          tryPromise(() => {
            throw error;
          }),
        ),
      ).rejects.toThrow(code ? 'retry the update' : 'write failed');
      expect(rolledBack).toBe(true);
      expect(committed).toBe(false);
    },
  );

  it('refuses a missing photo before starting the transaction', async () => {
    missing = true;
    const write = vi.fn();
    await expect(sut.withLivePhotoUpdate('photo', null, write)).rejects.toThrow('Asset not found');
    expect(write).not.toHaveBeenCalled();
    expect(queries).toHaveLength(1);
    expect(committed).toBe(false);
  });
});

describe('Live Photo upload publication', () => {
  const fixture = (options: { fail?: string; locked?: boolean; hidden?: boolean; invalid?: string } = {}) => {
    const upload = mediumFactory.assetInsert({
      id: 'new',
      ownerId: 'owner',
      type: AssetType.Image,
      livePhotoVideoId: 'motion',
    });
    const motion = {
      id: 'motion',
      ownerId: options.invalid === 'owner' ? 'other' : 'owner',
      type: options.invalid === 'type' ? AssetType.Image : AssetType.Video,
      deletedAt: options.invalid === 'deleted' ? new Date() : null,
      isLocked: !!options.locked,
      visibility: options.hidden ? AssetVisibility.Hidden : AssetVisibility.Timeline,
    };
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('with direct as')) return { rows: [{ id: 'motion' }] };
      if (query.sql.startsWith('insert into "asset"')) {
        if (options.fail === 'insert') throw new Error('publication failed');
        return { rows: [upload] };
      }
      if (query.sql.startsWith('with "asset"')) {
        if (options.fail === 'hide') throw new Error('publication failed');
        return { rows: [] };
      }
      if (query.sql.includes('from "asset"') && !query.sql.includes('for update'))
        return { rows: options.invalid === 'missing' ? [] : [motion] };
      return { rows: [] };
    });
    return { db, queries, upload, sut: new AssetRepository(db) };
  };
  afterEach(() => vi.restoreAllMocks());

  it('locks both identities before insertion and hides the motion in the same transaction', async () => {
    const f = fixture();
    try {
      await expect(f.sut.createLivePhotoUpload(f.upload)).resolves.toEqual({
        asset: f.upload,
        hiddenId: 'motion',
        lockedIds: [],
      });
      const keys = f.queries.filter((query) => query.sql.includes('pg_advisory_xact_lock'));
      expect(keys.map((query) => query.parameters)).toEqual([['motion'], ['new']]);
      const insert = f.queries.findIndex((query) => query.sql.startsWith('insert into "asset"'));
      expect(f.queries.findIndex((query) => query.sql.includes('for update nowait'))).toBeLessThan(insert);
      expect(f.queries[insert + 1].sql).toContain('update "asset"');
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });

  it.each(['insert', 'hide'])('rolls back a failed %s without committing either part', async (fail) => {
    const f = fixture({ fail });
    try {
      await expect(f.sut.createLivePhotoUpload(f.upload)).rejects.toThrow('publication failed');
      expect(f.queries.at(-1)!.sql).toBe('rollback');
      expect(f.queries.some((query) => query.sql === 'commit')).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it.each(['missing', 'type', 'owner', 'deleted'])(
    'refuses a motion with invalid %s before inserting the still',
    async (invalid) => {
      const f = fixture({ invalid });
      try {
        await expect(f.sut.createLivePhotoUpload(f.upload)).rejects.toThrow();
        expect(f.queries.some((query) => query.sql.startsWith('insert'))).toBe(false);
        expect(f.queries.at(-1)!.sql).toBe('rollback');
      } finally {
        await f.db.destroy();
      }
    },
  );

  it('refuses an unlocked upload linked to a Locked motion', async () => {
    const f = fixture({ locked: true });
    try {
      await expect(f.sut.createLivePhotoUpload(f.upload)).rejects.toThrow('Live photo video not found');
      expect(f.queries.some((query) => query.sql.startsWith('insert'))).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it('allows a Locked upload without a session and locks the new group before commit', async () => {
    const f = fixture({ locked: true });
    const lock = { reason: AssetLockReason.Marked, lockedBy: 'owner' };
    const locked = vi.spyOn(AssetRepository.prototype, 'lock').mockResolvedValue(['new']);
    try {
      await expect(f.sut.createLivePhotoUpload(f.upload, lock)).resolves.toEqual({
        asset: f.upload,
        hiddenId: 'motion',
        lockedIds: ['new'],
      });
      expect(locked).toHaveBeenCalledWith(['new'], lock.reason, lock.lockedBy);
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });

  it('preserves an already-hidden motion without a duplicate hide event', async () => {
    const f = fixture({ hidden: true });
    try {
      await expect(f.sut.createLivePhotoUpload(f.upload)).resolves.toEqual({
        asset: f.upload,
        hiddenId: undefined,
        lockedIds: [],
      });
      expect(f.queries.some((query) => query.sql.startsWith('with "asset"'))).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });
});
