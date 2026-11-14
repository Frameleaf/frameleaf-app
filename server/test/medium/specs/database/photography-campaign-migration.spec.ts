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

it.each(['pre-campaign', 'already-campaign', 'partial-campaign'])(
  'upgrades %s history and preserves active contact backfill',
  async (history) => {
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    const name = `frameleaf_campaign_${randomUUID().replaceAll('-', '')}`;
    const admin = postgres(new URL('/postgres', url).href, { max: 1 });
    let db: Kysely<any> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE frameleaf`);
      db = new Kysely(getKyselyConfig({ connectionType: 'url', url: new URL(`/${name}`, url).href }));
      const folder = fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url));
      const loader = { import: (path: string) => import(pathToFileURL(path).href) };
      const provider = createMigrationProvider(folder, loader);
      const adopt = () => adoptMigrationRenames(db!, folder, loader);
      const readLedger = async () =>
        (
          await sql<{
            name: string;
            timestamp: string;
          }>`SELECT name, timestamp FROM frameleaf_migrations ORDER BY name`.execute(db!)
        ).rows;
      const migrations = await provider.getMigrations();
      const campaignName = Object.keys(migrations).find((name) => name.endsWith('-PhotographyCampaign'))!;
      const legacyName = '1794530000000-PhotographyCampaign';
      // A pre-campaign server never ran anything named after the campaign migration.
      const beforeCampaign = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < campaignName));
      const migrate = (selected: typeof migrations) =>
        new Migrator({
          db: db!,
          migrationTableName: 'frameleaf_migrations',
          migrationLockTableName: 'frameleaf_migrations_lock',
          provider: { getMigrations: () => Promise.resolve(selected) },
        });
      const historical =
        history === 'pre-campaign'
          ? beforeCampaign
          : {
              ...Object.fromEntries(
                Object.entries(beforeCampaign).filter(
                  ([name]) => history !== 'partial-campaign' || !name.endsWith('-FoundFile'),
                ),
              ),
              [legacyName]: migrations[campaignName],
            };
      expect((await migrate(migrations).migrateTo('1794520000000-DevelopStyleProfile')).error).toBeUndefined();
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
      const campaignId = randomUUID();
      let campaignRows: unknown[] = [],
        deliveryRows: unknown[] = [],
        contactRows: unknown[] = [];
      if (history !== 'pre-campaign') {
        await sql`INSERT INTO photography_campaign (id, "ownerId", name, "templateKey", subject, body, audience) VALUES (${campaignId}::uuid, ${user.id}::uuid, 'Synthetic retained campaign', 'review-request', 'Fixture', 'Retained fixture body', '{"source":"all"}'::jsonb)`.execute(
          db,
        );
        await sql`INSERT INTO photography_campaign_delivery ("campaignId", "contactId", status) SELECT ${campaignId}::uuid, id, 'uncertain' FROM photography_contact WHERE email = 'active@example.test'`.execute(
          db,
        );
        campaignRows = (await sql`SELECT * FROM photography_campaign WHERE id = ${campaignId}::uuid`.execute(db)).rows;
        deliveryRows = (
          await sql`SELECT * FROM photography_campaign_delivery WHERE "campaignId" = ${campaignId}::uuid`.execute(db)
        ).rows;
        await sql`UPDATE photography_contact SET "unsubscribedAt" = now() WHERE email = 'active@example.test'`.execute(
          db,
        );
        contactRows = (await sql`SELECT * FROM photography_contact WHERE email = 'active@example.test'`.execute(db))
          .rows;
      }
      if (history !== 'pre-campaign') {
        await sql`INSERT INTO frameleaf_migrations (name, timestamp) VALUES ('9999999999999-Unknown', now()::text)`.execute(
          db,
        );
        const before = await readLedger();
        await expect(adopt()).rejects.toThrow('noncanonical');
        expect(await readLedger()).toEqual(before);
        expect(
          (await sql`SELECT name FROM frameleaf_migrations WHERE name = ${legacyName}`.execute(db)).rows,
        ).toHaveLength(1);
        await sql`DELETE FROM frameleaf_migrations WHERE name = '9999999999999-Unknown'`.execute(db);
        await sql`INSERT INTO frameleaf_migrations (name, timestamp) VALUES (${campaignName}, now()::text)`.execute(db);
        const duplicated = await readLedger();
        await expect(adopt()).rejects.toThrow('noncanonical');
        expect(await readLedger()).toEqual(duplicated);
        await sql`DELETE FROM frameleaf_migrations WHERE name = ${campaignName}`.execute(db);
        const originalTimestamp = (await readLedger()).find(({ name }) => name === legacyName)!.timestamp;
        for (const timestamp of ['1900-01-01T00:00:00.000Z', 'invalid-timestamp']) {
          await sql`UPDATE frameleaf_migrations SET timestamp = ${timestamp} WHERE name = ${legacyName}`.execute(db);
          const invalid = await readLedger();
          await expect(adopt()).rejects.toThrow(/noncanonical|invalid migration timestamp/);
          expect(await readLedger()).toEqual(invalid);
        }
        await sql`UPDATE frameleaf_migrations SET timestamp = ${originalTimestamp} WHERE name = ${legacyName}`.execute(
          db,
        );
      }
      if (history === 'partial-campaign') {
        await sql`CREATE TABLE alias_failure_probe (id integer)`.execute(db);
        await sql`CREATE INDEX found_file_outcome_idx ON alias_failure_probe (id)`.execute(db);
        const beforeFailure = await readLedger();
        await expect(adopt()).rejects.toThrow('already exists');
        expect(await readLedger()).toEqual(beforeFailure);
        expect(
          (await sql<{ table: string | null }>`SELECT to_regclass('public.found_file')::text AS table`.execute(db))
            .rows[0].table,
        ).toBeNull();
        await sql`DROP TABLE alias_failure_probe CASCADE`.execute(db);
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
      if (history !== 'pre-campaign') {
        expect(
          (
            await sql`SELECT id FROM photography_contact WHERE email = 'active@example.test' AND "unsubscribedAt" IS NOT NULL`.execute(
              db,
            )
          ).rows,
        ).toHaveLength(1);
      }
      if (history !== 'pre-campaign') {
        expect(
          (await sql`SELECT * FROM photography_contact WHERE email = 'active@example.test'`.execute(db)).rows,
        ).toEqual(contactRows);
        expect((await sql`SELECT * FROM photography_campaign WHERE id = ${campaignId}::uuid`.execute(db)).rows).toEqual(
          campaignRows,
        );
        expect(
          (await sql`SELECT * FROM photography_campaign_delivery WHERE "campaignId" = ${campaignId}::uuid`.execute(db))
            .rows,
        ).toEqual(deliveryRows);
      }
      const repository = new PhotographyCampaignRepository(db);
      const expected =
        history !== 'pre-campaign'
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
