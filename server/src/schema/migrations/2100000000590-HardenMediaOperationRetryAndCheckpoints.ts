import { Kysely, sql } from 'kysely';

/**
 * One unfinished retry per job (FL-43).
 *
 * Retrying a failed or cancelled media operation creates a new row that points at the old one
 * through `retryOfId`. Asking twice — a double click, two tabs, a client resending a request it never
 * saw answered — must answer with the retry already queued rather than start a second pass over the
 * same work. The service looks for that retry first; this index is what makes the answer hold when
 * two requests arrive together: the second insert fails, and the service returns the first.
 *
 * Only unfinished retries are covered. Once a retry has completed, failed or been cancelled, the
 * original may be retried again, and the finished rows stay as lineage.
 *
 * It also gives `media_operation_checkpoint` the `updateId` column its `updated_at()` trigger writes.
 * The trigger was created with the table but the column never was, so every update of a chunk —
 * completing it, re-planning it, invalidating it — failed, and no render could record progress
 * through its checkpoints.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "media_operation_checkpoint" ADD COLUMN IF NOT EXISTS "updateId" uuid NOT NULL DEFAULT immich_uuid_v7();`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX "media_operation_retryOfId_active_uq"
  ON "media_operation" ("retryOfId")
  WHERE "retryOfId" IS NOT NULL AND "status" NOT IN ('completed', 'cancelled', 'failed');`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "media_operation_retryOfId_active_uq";`.execute(db);
  await sql`ALTER TABLE "media_operation_checkpoint" DROP COLUMN IF EXISTS "updateId";`.execute(db);
}
