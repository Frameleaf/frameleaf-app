import { Kysely, sql } from 'kysely';

/**
 * Automatic retry for media operations (FL-104, owner decision September 22, 2026).
 *
 * `autoRetries` counts the automatic retries a job has used; a failure with none left is reported.
 * `retryAt` holds a requeued job back until the retry delay has passed.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "media_operation" ADD COLUMN "autoRetries" integer NOT NULL DEFAULT 0`.execute(db);
  await sql`ALTER TABLE "media_operation" ADD COLUMN "retryAt" timestamp with time zone`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "media_operation" DROP COLUMN "retryAt"`.execute(db);
  await sql`ALTER TABLE "media_operation" DROP COLUMN "autoRetries"`.execute(db);
}
