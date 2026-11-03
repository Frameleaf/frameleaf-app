import { Kysely, sql } from 'kysely';
import { readPinnedArtifact } from 'src/schema/catalog-artifacts.js';
import { splitPostgresStatements } from 'src/schema/postgres-statements.js';

/** Immutable initial DDL. Subsequent changes belong in new ORDER-listed migrations. */
export async function up(db: Kysely<any>): Promise<void> {
  if (!db.isTransaction) return db.transaction().execute(up);
  const { rows } = await sql<{ name: string }>`select tablename as name from pg_tables where schemaname = 'public'
    and tablename not in ('frameleaf_migrations', 'frameleaf_migrations_lock')`.execute(db);
  if (rows.length > 0) throw new Error('Frameleaf baseline requires a fresh destination database.');
  const statements = splitPostgresStatements(readPinnedArtifact('baseline.sql'));
  for (const [index, statement] of statements.entries()) {
    try {
      await sql.raw(statement).execute(db);
    } catch (error) {
      // An ordinal identifies exact pinned DDL without leaking function bodies or data literals.
      throw new Error(`Frameleaf immutable baseline failed at statement ${index + 1}`, { cause: error });
    }
  }
  // A schema-only dump carries no rows; these are the defaults the consolidated chain seeded on a fresh database.
  await sql`INSERT INTO public.desktop_clip_index VALUES ('unadmitted', uuid_generate_v4(), NULL)`.execute(db);
  await sql`INSERT INTO public.desktop_clip_producer (key) VALUES ('legacy')`.execute(db);
  await sql`INSERT INTO public.ml_processing_order (scope, sources) VALUES ('default', '["local","desktops","cloud"]'::jsonb)`.execute(
    db,
  );
}

export function down(): Promise<never> {
  return Promise.reject(
    new Error('Frameleaf baseline cannot be reversed. Restore a Frameleaf backup into a fresh database.'),
  );
}
