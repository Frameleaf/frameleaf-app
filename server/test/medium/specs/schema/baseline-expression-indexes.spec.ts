import { schemaDiffToSql } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { getFrameleafBaselineSchema } from 'src/schema/frameleaf-schema.js';
import { getKyselyConfig } from 'src/utils/database.js';

// Independent of baseline boot: the production model's expressions must be executable PostgreSQL.
it('creates compound, multi-column and ordered indexes from the canonical model', async () => {
  const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  endpoint.pathname = '/postgres';
  const admin = postgres(endpoint.href, { max: 1, onnotice: () => {} });
  const name = `baseline_indexes_${randomUUID().replaceAll('-', '')}`;
  let db: Kysely<any> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    endpoint.pathname = `/${name}`;
    db = new Kysely(getKyselyConfig({ connectionType: 'url', url: endpoint.href }));
    await sql
      .raw(
        `
      CREATE TABLE asset ("localDateTime" timestamptz);
      CREATE TABLE media_operation ("ownerId" uuid, snapshot jsonb, kind text);
      CREATE TABLE ml_workload_accounting ("jobId" text, "jobName" text, "startedAt" timestamptz);
    `,
      )
      .execute(db);
    const names = [
      'asset_localDateTime_idx',
      'asset_localDateTime_month_idx',
      'media_operation_enrichment_plan_requestKey_uq',
      'ml_workload_accounting_jobId_jobName_startedAt_idx',
    ];
    const indexes = getFrameleafBaselineSchema().tables.flatMap((table) => table.indexes);
    for (const name of names) {
      const index = indexes.find((index) => index.name === name);
      expect(index, name).toBeDefined();
      for (const statement of schemaDiffToSql([
        { type: 'IndexCreate', object: index!, reason: 'baseline regression' },
      ])) {
        await sql.raw(statement).execute(db);
      }
    }
    const installed = await sql<{ name: string }>`
      SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public'
    `.execute(db);
    expect(installed.rows.map(({ name }) => name).toSorted()).toEqual(names.toSorted());
    // Evaluate the indexed expressions on a real row crossing the UTC date/month boundary.
    await sql`INSERT INTO asset VALUES ('2026-10-01 01:00:00+02')`.execute(db);
    const values = await sql<{ day: string; month: string }>`
      SELECT (("localDateTime" AT TIME ZONE 'UTC')::date)::text AS day,
        to_char(date_trunc('MONTH', "localDateTime" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month FROM asset
    `.execute(db);
    expect(values.rows).toEqual([{ day: '2026-09-30', month: '2026-09-01' }]);
  } finally {
    await db?.destroy();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
