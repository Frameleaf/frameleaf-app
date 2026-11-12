import { Kysely, sql } from 'kysely';

/**
 * FL-1459: a run records what brought its photos in, for Activity's "By what came in": whose they are (`ownerId`),
 * the source (`origin`: phone, computer, client, link, library or import), its name (`label`: the phone or app) and
 * how many photos came (`itemCount`). Runs from before stay without one. `job_run_origin` finds a device's open
 * upload run.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "job_run" ADD COLUMN IF NOT EXISTS "ownerId" uuid, ADD COLUMN IF NOT EXISTS "origin" text,
    ADD COLUMN IF NOT EXISTS "label" text, ADD COLUMN IF NOT EXISTS "itemCount" integer`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "job_run_origin" ON "job_run" ("ownerId", "createdAt") WHERE "origin" IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "job_run_origin"`.execute(db);
  await sql`ALTER TABLE "job_run" DROP COLUMN IF EXISTS "itemCount", DROP COLUMN IF EXISTS "label",
    DROP COLUMN IF EXISTS "origin", DROP COLUMN IF EXISTS "ownerId"`.execute(db);
}
