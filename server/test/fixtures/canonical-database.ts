import { Insertable, Kysely, sql } from 'kysely';
import { expect } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';

/** Every medium clone comes from the real canonical baseline, never a reduced test schema. */
export const expectCanonicalTables = async (db: Kysely<DB>, tables: string[]): Promise<void> => {
  const ledger = await sql<{ name: string }>`SELECT name FROM public.frameleaf_migrations ORDER BY name`.execute(db);
  expect(ledger.rows.map(({ name }) => name)).toContain('0000000000000-FrameleafBaseline');
  const legacy = await sql<{ present: string | null }>`SELECT to_regnamespace('immich_fork')::text AS present`.execute(
    db,
  );
  expect(legacy.rows[0].present).toBeNull();
  for (const table of tables) {
    const catalog = await sql<{ columns: number; primaryKeys: number }>`
      SELECT (SELECT count(*)::int FROM pg_attribute WHERE attrelid = to_regclass(${'public.' + table})
        AND attnum > 0 AND NOT attisdropped) AS columns,
        (SELECT count(*)::int FROM pg_constraint WHERE conrelid = to_regclass(${'public.' + table})
        AND contype = 'p') AS "primaryKeys"
    `.execute(db);
    expect(catalog.rows[0].columns, `canonical public.${table}`).toBeGreaterThan(0);
    expect(catalog.rows[0].primaryKeys, `primary key public.${table}`).toBe(1);
  }
};

export const canonicalTestContext = (db: Kysely<DB>) =>
  newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;

/** Seed full rows and relationships; do not weaken production constraints to fit a fixture. */
export const seedCanonicalUser = async (db: Kysely<DB>, dto: Partial<Insertable<UserTable>> = {}) => {
  if (dto.id) {
    const existing = await db.selectFrom('user').select('id').where('id', '=', dto.id).executeTakeFirst();
    if (existing) return existing;
  }
  return (await canonicalTestContext(db).newUser(dto)).user;
};

export const seedCanonicalAsset = async (
  db: Kysely<DB>,
  dto: Partial<Insertable<AssetTable>> & { ownerId: string },
) => {
  await seedCanonicalUser(db, { id: dto.ownerId });
  if (dto.id) {
    const existing = await db.selectFrom('asset').select('id').where('id', '=', dto.id).executeTakeFirst();
    if (existing) return existing;
  }
  return (await canonicalTestContext(db).newAsset(dto)).asset;
};

export const seedCanonicalAlbum = async (
  db: Kysely<DB>,
  dto: Partial<Insertable<AlbumTable>> & { ownerId: string },
  assetIds?: string[],
) => {
  await seedCanonicalUser(db, { id: dto.ownerId });
  return (await canonicalTestContext(db).newAlbum(dto, assetIds)).album;
};

/** Retain credentials, query parameters and non-database URL components. */
export const canonicalDatabaseUrl = (url: string, database: string): string => {
  const target = new URL(url);
  target.pathname = '/' + database;
  return target.href;
};
