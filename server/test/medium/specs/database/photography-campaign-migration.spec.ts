import { adoptMigrationRenames, createMigrationProvider } from '@frameleaf/sql-tools';
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

it.each(['pre-campaign', 'already-campaign'])(
  'upgrades %s history and preserves active contact backfill',
  async (history) => {
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    const name = `frameleaf_campaign_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(new URL('/postgres', url).href, { max: 1 });
    let db: Kysely<any> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`);
      db = new Kysely(getKyselyConfig({ connectionType: 'url', url: new URL(`/${name}`, url).href }));
      const folder = fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url));
      const loader = { import: (path: string) => import(pathToFileURL(path).href) };
      const provider = createMigrationProvider(folder, loader);
      const adopt = () => adoptMigrationRenames(db!, folder, loader);
      const migrations = await provider.getMigrations();
      const campaignName = Object.keys(migrations).find((name) => name.endsWith('-PhotographyCampaign'))!;
      const legacyName = '1794530000000-PhotographyCampaign';
      const beforeCampaign = Object.fromEntries(Object.entries(migrations).filter(([name]) => name !== campaignName));
      const migrate = (selected: typeof migrations) =>
        new Migrator({
          db: db!,
          migrationTableName: 'frameleaf_migrations',
          migrationLockTableName: 'frameleaf_migrations_lock',
          provider: { getMigrations: () => Promise.resolve(selected) },
        });
      const historical =
        history === 'pre-campaign' ? beforeCampaign : { ...beforeCampaign, [legacyName]: migrations[campaignName] };
      expect((await migrate(beforeCampaign).migrateTo('1794520000000-DevelopStyleProfile')).error).toBeUndefined();
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
      expect((await migrate(historical).migrateToLatest()).error).toBeUndefined();
      if (history === 'already-campaign') {
        await sql`UPDATE photography_contact SET "unsubscribedAt" = now() WHERE email = 'active@example.test'`.execute(
          db,
        );
      }
      if (history === 'already-campaign') {
        await sql`INSERT INTO frameleaf_migrations (name, timestamp) VALUES ('9999999999999-Unknown', now()::text)`.execute(
          db,
        );
        await expect(adopt()).rejects.toThrow('noncanonical');
        expect(
          (await sql`SELECT name FROM frameleaf_migrations WHERE name = ${legacyName}`.execute(db)).rows,
        ).toHaveLength(1);
        await sql`DELETE FROM frameleaf_migrations WHERE name = '9999999999999-Unknown'`.execute(db);
        await sql`INSERT INTO frameleaf_migrations (name, timestamp) VALUES (${campaignName}, now()::text)`.execute(db);
        await expect(adopt()).rejects.toThrow('noncanonical');
        expect(
          (await sql`SELECT name FROM frameleaf_migrations WHERE name = ${legacyName}`.execute(db)).rows,
        ).toHaveLength(1);
        await sql`DELETE FROM frameleaf_migrations WHERE name = ${campaignName}`.execute(db);
      }
      const migrator = new Migrator({
        db,
        migrationTableName: 'frameleaf_migrations',
        migrationLockTableName: 'frameleaf_migrations_lock',
        provider,
      });
      const start = async () => {
        await adopt();
        return migrator.migrateToLatest();
      };
      const starts = await Promise.all([start(), start()]);
      for (const outcome of starts) expect(outcome.error).toBeUndefined();
      expect((await migrator.migrateToLatest()).results).toEqual([]);
      const { rows: ledger } = await sql<{
        name: string;
      }>`SELECT name FROM frameleaf_migrations ORDER BY timestamp, name`.execute(db);
      expect(ledger.map(({ name }) => name)).toEqual(Object.keys(migrations));
      if (history === 'already-campaign') {
        expect(
          (
            await sql`SELECT id FROM photography_contact WHERE email = 'active@example.test' AND "unsubscribedAt" IS NOT NULL`.execute(
              db,
            )
          ).rows,
        ).toHaveLength(1);
      }
      const repository = new PhotographyCampaignRepository(db);
      const expected =
        history === 'already-campaign'
          ? ['lead@example.test', 'legacy@example.test']
          : ['active@example.test', 'lead@example.test', 'legacy@example.test'];
      expect((await repository.contacts(user.id, { source: 'all' })).map(({ email }) => email).sort()).toEqual(
        expected,
      );
      await repository.syncContacts(user.id);
      expect((await repository.contacts(user.id, { source: 'all' })).map(({ email }) => email).sort()).toEqual(
        expected,
      );
    } finally {
      await db?.destroy();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    }
  },
  30_000,
);
