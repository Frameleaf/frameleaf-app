import { Kysely, sql } from 'kysely';
import { DateTime } from 'luxon';
import { v4 } from 'uuid';
import { AssetMetadataKey, UserMetadataKey } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseSync, SyncRepository } from 'src/repositories/sync.repository.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { DB } from 'src/schema/index.js';
import { SyncService } from 'src/services/sync.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SyncService, {
    database: db || defaultDatabase,
    real: [DatabaseRepository, SyncRepository],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterAll(async () => {
  await defaultDatabase?.destroy();
});

const deletedLongAgo = DateTime.now().minus({ days: 35 }).toISO();

const assertTableCount = async <T extends keyof DB>(db: Kysely<DB>, t: T, count: number) => {
  const { table } = db.dynamic;
  const results = await db.selectFrom(table(t).as(t)).selectAll().execute();
  expect(results).toHaveLength(count);
};

describe(SyncService.name, () => {
  describe('onAuditTableCleanup', () => {
    it('should work', async () => {
      const { sut } = setup();
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
    });

    it('should cleanup the album_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'album_audit';

      await ctx.database
        .insertInto(tableName)
        .values({ albumId: v4(), userId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the album_asset_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'album_asset_audit';
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.database
        .insertInto(tableName)
        .values({ albumId: album.id, assetId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the album_user_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'album_user_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ albumId: v4(), userId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the asset_audit table', async () => {
      const { sut, ctx } = setup();

      await ctx.database
        .insertInto('asset_audit')
        .values({ assetId: v4(), ownerId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, 'asset_audit', 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, 'asset_audit', 0);
    });

    it('should cleanup the asset_face_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'asset_face_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ assetFaceId: v4(), assetId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the asset_metadata_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'asset_metadata_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ assetId: v4(), key: AssetMetadataKey.MobileApp, deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the memory_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'memory_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ memoryId: v4(), userId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the memory_asset_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'memory_asset_audit';
      const { user } = await ctx.newUser();
      const { memory } = await ctx.newMemory({ ownerId: user.id });
      await ctx.database
        .insertInto(tableName)
        .values({ memoryId: memory.id, assetId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the partner_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'partner_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ sharedById: v4(), sharedWithId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the stack_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'stack_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ stackId: v4(), userId: v4(), deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the user_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'user_audit';
      await ctx.database.insertInto(tableName).values({ userId: v4(), deletedAt: deletedLongAgo }).execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should cleanup the user_metadata_audit table', async () => {
      const { sut, ctx } = setup();
      const tableName = 'user_metadata_audit';
      await ctx.database
        .insertInto(tableName)
        .values({ userId: v4(), key: UserMetadataKey.Onboarding, deletedAt: deletedLongAgo })
        .execute();

      await assertTableCount(ctx.database, tableName, 1);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      await assertTableCount(ctx.database, tableName, 0);
    });

    it('should skip recent records', async () => {
      const { sut, ctx } = setup();

      const keep = {
        id: v4(),
        assetId: v4(),
        ownerId: v4(),
        deletedAt: DateTime.now().minus({ days: 25 }).toISO(),
      };

      const remove = {
        id: v4(),
        assetId: v4(),
        ownerId: v4(),
        deletedAt: DateTime.now().minus({ days: 35 }).toISO(),
      };

      await ctx.database.insertInto('asset_audit').values([keep, remove]).execute();
      await assertTableCount(ctx.database, 'asset_audit', 2);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();

      const after = await ctx.database.selectFrom('asset_audit').select(['id']).execute();
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(keep.id);
    });

    const directAuditTables = [
      { table: 'tag_audit', columns: ['tagId', 'userId'] },
      { table: 'tag_asset_audit', columns: ['tagId', 'assetId', 'userId'] },
      { table: 'pet_audit', columns: ['petId', 'ownerId'] },
      { table: 'pet_observation_audit', columns: ['observationId', 'petId', 'assetId', 'ownerId'] },
    ] as const;

    it.each(directAuditTables)('prunes old $table tombstones and retains recent ones', async ({ table, columns }) => {
      const { sut, ctx } = setup();
      const recentId = v4();
      for (const [id, deletedAt] of [
        [v4(), deletedLongAgo],
        [recentId, DateTime.now().minus({ days: 1 }).toISO()],
      ]) {
        await sql`INSERT INTO ${sql.table(table)}
          (${sql.join(['id', ...columns, 'deletedAt'].map((column) => sql.ref(column)))})
          VALUES (${sql.join([id, ...columns.map(() => v4()), deletedAt])})`.execute(ctx.database);
      }

      await assertTableCount(ctx.database, table, 2);
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();
      const { rows } = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)}`.execute(ctx.database);
      expect(rows).toEqual([{ id: recentId }]);
    });

    it('should cleanup every table through its respective cleanup path', async () => {
      const { sut } = setup();

      // Render-worker actions and iCloud integrity results are operational history, not sync
      // tombstones. Neither has deletedAt, and sync must never prune either record.
      const notSyncTombstones = new Set(['render_worker_audit', 'icloud_identity_audit']);
      const auditTables = getFrameleafSchema()
        .tables.filter((table) => table.name.endsWith('_audit') && !notSyncTombstones.has(table.name))
        .map(({ name }) => name);

      // TagSync prunes these directly; the real-table retention cases above cover that path.
      const directTables = new Set<string>(directAuditTables.map(({ table }) => table));
      expect([...directTables].every((table) => auditTables.includes(table))).toBe(true);
      const baseAuditTables = auditTables.filter((table) => !directTables.has(table));

      const auditCleanupSpy = vi.spyOn(BaseSync.prototype as any, 'auditCleanup');
      await expect(sut.onAuditTableCleanup()).resolves.toBeUndefined();

      expect(auditCleanupSpy).toHaveBeenCalledTimes(baseAuditTables.length);
      for (const table of baseAuditTables) {
        expect(auditCleanupSpy, `Audit table ${table} was not cleaned up`).toHaveBeenCalledWith(table, 31);
      }
    });
  });
});
