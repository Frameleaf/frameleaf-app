import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { tryPromise } from 'src/utils/promise.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('Metadata fill transaction', () => {
  it('pins the parent and EXIF rows before binding the writer and commits its work', async () => {
    const { db, queries } = scriptedKysely((query) =>
      query.sql.includes('from "asset"') ? { rows: [{ id: 'asset' }] } : {},
    );
    try {
      const sut = new AssetRepository(db);
      await sut.withMetadataUpdate('ASSET', async (assets, access) => {
        expect(assets).toBeInstanceOf(AssetRepository);
        expect(access).toBeInstanceOf(AccessRepository);
        expect(queries.map(({ sql }) => sql)).toEqual([
          'begin',
          expect.stringContaining('pg_advisory_xact_lock'),
          expect.stringContaining('from "asset"'),
          expect.stringContaining('from "asset_exif"'),
        ]);
        expect(queries.slice(2).every(({ sql }) => sql.endsWith('for update nowait'))).toBe(true);
        expect(queries[1].parameters).toEqual(['asset']);
        await assets.upsertExif({
          lockedPropertiesBehavior: 'override',
          exif: { assetId: 'asset', description: 'From Google' },
        });
      });
      expect(queries.at(-1)?.sql).toBe('commit');
    } finally {
      await db.destroy();
    }
  });

  it.each(['asset', 'asset_exif'])('refuses %s row contention before calling the writer', async (table) => {
    const write = vi.fn();
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes(`from "${table}"`)) throw Object.assign(new Error('busy'), { code: '55P03' });
      return { rows: [{ id: 'asset' }] };
    });
    try {
      await expect(new AssetRepository(db).withMetadataUpdate('asset', write)).rejects.toThrow('retry the update');
      expect(write).not.toHaveBeenCalled();
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });

  it.each([undefined, '40P01'])('rolls back writer failure %s, translating deadlocks to a conflict', async (code) => {
    const { db, queries } = scriptedKysely(() => ({ rows: [{ id: 'asset' }] }));
    try {
      await expect(
        new AssetRepository(db).withMetadataUpdate('asset', () =>
          tryPromise(() => {
            throw Object.assign(new Error('write failed'), { code });
          }),
        ),
      ).rejects.toThrow(code ? 'retry the update' : 'write failed');
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });

  it('refuses a missing parent before calling the writer', async () => {
    const { db, queries } = scriptedKysely();
    const write = vi.fn();
    try {
      await expect(new AssetRepository(db).withMetadataUpdate('asset', write)).rejects.toThrow('Asset not found');
      expect(write).not.toHaveBeenCalled();
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });
});
