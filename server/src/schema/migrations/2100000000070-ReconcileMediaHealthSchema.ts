import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // The existing function body is equivalent; record its canonical SQL-tools metadata without replacing it.
  await sql`CREATE INDEX "asset_health_run_ownerId_idx" ON "asset_health_run" ("ownerId");`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_media_health_updated_at', '{"type":"function","name":"media_health_updated_at","sql":"CREATE OR REPLACE FUNCTION media_health_updated_at()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      new.\\"updatedAt\\" = clock_timestamp();\\n      return new;\\n    END;\\n  $$;"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_health_run_ownerId_idx";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_media_health_updated_at';`.execute(db);
}
