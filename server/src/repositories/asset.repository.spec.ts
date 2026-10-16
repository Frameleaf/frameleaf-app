import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import type { DB } from 'src/schema/index.js';

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
          executeQuery: async (query: { sql: string; parameters: readonly unknown[] }) => {
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
          },
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
      await access.asset.checkOwnerAccess('owner', new Set(['photo']));
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
        sut.withLivePhotoUpdate('photo', null, async () => {
          throw error;
        }),
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
