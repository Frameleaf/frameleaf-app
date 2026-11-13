import { createMigrationProvider } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyCampaignRepository } from 'src/repositories/photography-campaign.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';

it('backfills active gallery recipients and inquiries without importing revoked gallery recipients', async () => {
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  const name = `frameleaf_campaign_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(new URL('/postgres', url).href, { max: 1 });
  let db: Kysely<any> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
    db = new Kysely(getKyselyConfig({ connectionType: 'url', url: new URL(`/${name}`, url).href }));
    const migrator = new Migrator({
      db,
      migrationTableName: 'frameleaf_migrations',
      migrationLockTableName: 'frameleaf_migrations_lock',
      provider: createMigrationProvider(fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url)), {
        import: (path) => import(pathToFileURL(path).href),
      }),
    });
    expect((await migrator.migrateTo('1794520000000-DevelopStyleProfile')).error).toBeUndefined();
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const recipients = [
      { email: 'active@example.test', name: 'Active', revoked: false },
      { email: 'legacy@example.test', name: 'Legacy' },
      { email: 'revoked@example.test', name: 'Revoked', revoked: true },
    ];
    await sql`INSERT INTO photography_workflow (id, "ownerId", "albumId", revision, value) VALUES (gen_random_uuid(), ${user.id}::uuid, ${album.id}::uuid, gen_random_uuid(), ${JSON.stringify({ recipients })}::text::jsonb)`.execute(
      db,
    );
    await sql`INSERT INTO photography_studio_site ("ownerId", revision, value) VALUES (${user.id}::uuid, gen_random_uuid(), ${JSON.stringify({ inquiries: [{ email: 'lead@example.test', name: 'Lead' }] })}::text::jsonb)`.execute(
      db,
    );
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    const repository = new PhotographyCampaignRepository(db);
    const expected = ['active@example.test', 'lead@example.test', 'legacy@example.test'];
    expect((await repository.contacts(user.id, { source: 'all' })).map(({ email }) => email).sort()).toEqual(expected);
    await repository.syncContacts(user.id);
    expect((await repository.contacts(user.id, { source: 'all' })).map(({ email }) => email).sort()).toEqual(expected);
  } finally {
    await db?.destroy();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  }
});
