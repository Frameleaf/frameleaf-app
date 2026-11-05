import { schemaDiff, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getFrameleafBaselineSchema } from 'src/schema/frameleaf-schema.js';
import { LEGACY_CHAIN, adoptLegacyLedger } from 'src/schema/legacy-ledger.js';
import { up } from 'src/schema/migrations/0000000000000-FrameleafBaseline.js';
import { getKyselyConfig } from 'src/utils/database.js';

// Issue 863: a 1.2.2 database (chain up to 2100000003047) must start on the consolidated baseline.
it('adopts a 1.2.2 ledger as the baseline and rejects older ones', async () => {
  const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  endpoint.pathname = '/postgres';
  const admin = postgres(endpoint.href, { max: 1, onnotice: () => {} });
  const name = `legacy_ledger_${randomUUID().replaceAll('-', '')}`;
  let db: Kysely<any> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    endpoint.pathname = `/${name}`;
    const connection = { connectionType: 'url' as const, url: endpoint.href };
    db = new Kysely(getKyselyConfig(connection));
    await up(db);
    // What 1.2.2 lacked: the two migrations merged after it.
    await sql`ALTER TABLE public.frameleaf_library_import DROP COLUMN activation, DROP COLUMN activation_sha256`.execute(
      db,
    );
    await sql`ALTER TABLE public."user" DROP COLUMN "importOperationId"`.execute(db);
    await sql`CREATE TABLE public.frameleaf_migrations (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)`.execute(
      db,
    );
    const record = (names: readonly string[]) =>
      sql`INSERT INTO public.frameleaf_migrations SELECT unnest(${names}::text[]), '2026-11-01T00:00:00.000Z'`.execute(
        db!,
      );

    await record(LEGACY_CHAIN.slice(0, 50));
    await expect(adoptLegacyLedger(db)).rejects.toThrow('Update to 1.2.2 first');

    await sql`TRUNCATE public.frameleaf_migrations`.execute(db);
    await record(LEGACY_CHAIN.slice(0, 77));
    expect(await adoptLegacyLedger(db)).toEqual([
      '2100000003048-LibraryImportActivation',
      '2100000003049-ImportedOwnerProvenance',
    ]);
    const { rows } = await sql<{ name: string }>`SELECT name FROM public.frameleaf_migrations`.execute(db);
    expect(rows.map(({ name }) => name)).toEqual([LEGACY_CHAIN[0]]);
    const target = await schemaFromDatabase({ connection, overrides: false, excludeMigrationTables: true });
    expect(target.warnings).toEqual([]);
    expect(
      schemaDiff(getFrameleafBaselineSchema(), target, {
        parameters: { ignoreExtra: true },
        extensions: { ignoreExtra: true },
      }).asSql(),
    ).toEqual([]);
    expect(await adoptLegacyLedger(db)).toEqual([]);
  } finally {
    await db?.destroy();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
