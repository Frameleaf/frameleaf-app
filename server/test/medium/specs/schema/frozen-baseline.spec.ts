import { schemaDiff, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getFrameleafBaselineSchema, verifyFrameleafSchemaSources } from 'src/schema/frameleaf-schema.js';
import { up } from 'src/schema/migrations/0000000000000-FrameleafBaseline.js';
import { getKyselyConfig } from 'src/utils/database.js';

// Hosted PostgreSQL: replay the pinned SQL independently from all model/helper bootstrap code.
it('replays the frozen baseline without drift and repairs real missing and extra objects', async () => {
  await verifyFrameleafSchemaSources();
  const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  endpoint.pathname = '/postgres';
  const admin = postgres(endpoint.href, { max: 1, onnotice: () => {} });
  const name = `frozen_baseline_${randomUUID().replaceAll('-', '')}`;
  let db: Kysely<any> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    endpoint.pathname = `/${name}`;
    const connection = { connectionType: 'url' as const, url: endpoint.href };
    db = new Kysely(getKyselyConfig(connection));
    await up(db);
    const desired = getFrameleafBaselineSchema();
    const drift = async () => {
      const target = await schemaFromDatabase({ connection, overrides: false, excludeMigrationTables: true });
      expect(target.warnings).toEqual([]);
      return schemaDiff(desired, target, { parameters: { ignoreExtra: true }, extensions: { ignoreExtra: true } });
    };
    expect((await drift()).asSql()).toEqual([]);
    await expect(up(db)).rejects.toThrow('fresh destination');
    await sql`CREATE TABLE unexpected_application_table (id integer)`.execute(db);
    await sql`DROP INDEX public.job_manifest_pending`.execute(db);
    const repair = (await drift()).asSql();
    expect(repair.some((statement) => statement.includes('job_manifest_pending'))).toBe(true);
    expect(repair.some((statement) => statement.includes('unexpected_application_table'))).toBe(true);
    for (const statement of repair) await sql.raw(statement).execute(db);
    expect((await drift()).asSql()).toEqual([]);
  } finally {
    await db?.destroy();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
