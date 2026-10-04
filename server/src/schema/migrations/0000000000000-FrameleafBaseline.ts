import { createQueueSchema } from 'src/queue/schema.js';
import { IMMICH_IMPORT_SCHEMA_SQL } from 'src/immich-import/state.js';
import { createSharedServicesSchema } from 'src/schema/shared-services-schema.js';
import { schemaDiff } from '@frameleaf/sql-tools';
import type { DatabaseSchema } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { getFrameleafBaselineSchema } from 'src/schema/frameleaf-schema.js';
import { FRAMELEAF_FEATURE_SCHEMA_SQL } from 'src/schema/frameleaf-feature-schema.js';

/** Fresh Frameleaf installations only. Immich enters through the one-way data importer. */
export async function up(db: Kysely<any>): Promise<void> {
  const existing = await sql<{ present: boolean }>`SELECT to_regclass('public.asset') IS NOT NULL AS present`.execute(
    db,
  );
  if (existing.rows[0]?.present) throw new Error('Frameleaf baseline requires a fresh destination database.');
  const empty: DatabaseSchema = {
    databaseName: 'frameleaf',
    schemaName: 'public',
    functions: [],
    enums: [],
    tables: [],
    extensions: [],
    parameters: [],
    overrides: [],
    warnings: [],
  };
  const schema = getFrameleafBaselineSchema();
  for (const statement of schemaDiff(schema, empty).asSql()) await sql.raw(statement).execute(db);
  for (const statement of FRAMELEAF_FEATURE_SCHEMA_SQL) await sql.raw(statement).execute(db);
  await createQueueSchema(db);
  await createSharedServicesSchema(db);
  await sql.raw(IMMICH_IMPORT_SCHEMA_SQL).execute(db);
}

export async function down(): Promise<never> {
  throw new Error('Frameleaf baseline cannot be reversed. Restore a Frameleaf backup into a fresh database.');
}
