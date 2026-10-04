import { createQueueSchema } from 'src/queue/schema.js';
import { IMMICH_IMPORT_SCHEMA_SQL } from 'src/immich-import/state.js';
import { createSharedServicesSchema } from 'src/schema/shared-services-schema.js';
import { schemaDiff } from '@frameleaf/sql-tools';
import type { DatabaseSchema } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { getFrameleafBaselineSchema } from './model.js';
import { FRAMELEAF_FEATURE_SCHEMA_SQL } from 'src/schema/frameleaf-feature-schema.js';

/** Fresh Frameleaf installations only. Immich enters through the one-way data importer. */
export async function bootstrapCandidate(db: Kysely<any>): Promise<void> {
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
  const runStage = async (context: string, execute: () => Promise<unknown>) => {
    try {
      await execute();
    } catch (error) {
      throw new Error(`Frameleaf baseline failed during ${context}`, { cause: error });
    }
  };
  for (const [phase, statements] of [
    ['model', schemaDiff(schema, empty).asSql()],
    ['features', FRAMELEAF_FEATURE_SCHEMA_SQL],
  ] as const) {
    for (const [index, statement] of statements.entries()) {
      // Report only the DDL command and object identifier, never a function body or data literal.
      const object = statement.match(
        /^\s*((?:CREATE(?: OR REPLACE)?|ALTER|DROP)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|FUNCTION|TRIGGER|TYPE|EXTENSION|SEQUENCE)\s+(?:"(?:[^"]|"")*"|[\w.]+))/i,
      )?.[1];
      await runStage(`${phase} statement ${index + 1}${object ? ` (${object})` : ''}`, () =>
        sql.raw(statement).execute(db),
      );
    }
  }
  await runStage('queue schema', () => createQueueSchema(db));
  await runStage('shared services schema', () => createSharedServicesSchema(db));
  await runStage('import state schema', () => sql.raw(IMMICH_IMPORT_SCHEMA_SQL).execute(db));
}
