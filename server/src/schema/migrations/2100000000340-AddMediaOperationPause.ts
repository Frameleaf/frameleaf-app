import { Kysely, sql } from 'kysely';

/**
 * Pause and resume for media operations (FL-104, owner request September 23, 2026).
 *
 * `pauseRequestedAt` records the owner's request. A queued job becomes `paused` straight away; a
 * claimed one keeps it set until its worker reaches a checkpoint and hands the claim back. The
 * `status` column is already free text, so the new `paused` value needs no change of its own.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "media_operation" ADD COLUMN "pauseRequestedAt" timestamp with time zone`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // A paused job has no meaning without the column; hand it back to the queue first.
  await sql`UPDATE "media_operation" SET "status" = 'queued' WHERE "status" = 'paused'`.execute(db);
  await sql`ALTER TABLE "media_operation" DROP COLUMN "pauseRequestedAt"`.execute(db);
}
