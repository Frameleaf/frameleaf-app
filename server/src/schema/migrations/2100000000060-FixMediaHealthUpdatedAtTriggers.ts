import { Kysely, sql } from 'kysely';

/** Repairs health-table timestamp triggers without adding updateId columns or rewriting rows. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION public.media_health_updated_at()
    RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
    BEGIN
      new."updatedAt" = clock_timestamp();
      return new;
    END;$$;`.execute(db);
  for (const table of ['asset_health', 'asset_health_candidate']) {
    await sql`CREATE OR REPLACE TRIGGER ${sql.id(`${table}_updatedAt`)}
      BEFORE UPDATE ON ${sql.id('public', table)}
      FOR EACH ROW EXECUTE FUNCTION public.media_health_updated_at();`.execute(db);
    await sql`UPDATE public.migration_overrides
      SET value = jsonb_set(value, '{sql}', to_jsonb(replace(value->>'sql', 'FUNCTION updated_at()', 'FUNCTION media_health_updated_at()')))
      WHERE name = ${`trigger_${table}_updatedAt`};`.execute(db);
  }
}

/** Restores the previous shared triggers and overrides, then removes the health-only function. */
export async function down(db: Kysely<any>): Promise<void> {
  for (const table of ['asset_health', 'asset_health_candidate']) {
    await sql`CREATE OR REPLACE TRIGGER ${sql.id(`${table}_updatedAt`)}
      BEFORE UPDATE ON ${sql.id('public', table)}
      FOR EACH ROW EXECUTE FUNCTION public.updated_at();`.execute(db);
    await sql`UPDATE public.migration_overrides
      SET value = jsonb_set(value, '{sql}', to_jsonb(replace(value->>'sql', 'FUNCTION media_health_updated_at()', 'FUNCTION updated_at()')))
      WHERE name = ${`trigger_${table}_updatedAt`};`.execute(db);
  }
  await sql`DROP FUNCTION public.media_health_updated_at();`.execute(db);
}
