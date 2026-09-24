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
  // A database that ran the retry path before this index existed can already hold two unfinished
  // retries of one job, and the unique index cannot be built over them. Keep one per job — a live
  // claimed retry first, then a queued or paused one, and one already being cancelled last, then
  // the oldest — and cancel the rest. A cancelled duplicate's claim is dropped, so a worker still
  // running it can no longer write to it; one that was claimed is left unacknowledged, so the
  // remote cleanup pass still releases what it started.
  await sql`
    WITH "ranked" AS (
      SELECT
        "id",
        row_number() OVER (
          PARTITION BY "retryOfId"
          ORDER BY
            CASE
              WHEN "status" IN ('queued', 'paused') THEN 2
              WHEN "status" = 'cancelling' THEN 3
              ELSE 1
            END,
            "createdAt",
            "id"
        ) AS "rank"
      FROM "media_operation"
      WHERE "retryOfId" IS NOT NULL AND "status" NOT IN ('completed', 'cancelled', 'failed')
    )
    UPDATE "media_operation" AS "operation"
    SET
      "status" = 'cancelled',
      "cancelRequestedAt" = coalesce("operation"."cancelRequestedAt", now()),
      "cancelAcknowledgedAt" = CASE
        WHEN "operation"."status" IN ('queued', 'paused') THEN coalesce("operation"."cancelAcknowledgedAt", now())
        ELSE "operation"."cancelAcknowledgedAt"
      END,
      "finishedAt" = coalesce("operation"."finishedAt", now()),
      "claimToken" = NULL,
      "claimedBy" = NULL,
      "claimExpiresAt" = NULL,
      "pauseRequestedAt" = NULL,
      "error" = coalesce("operation"."error", 'Another retry of this job was already queued.')
    FROM "ranked"
    WHERE "operation"."id" = "ranked"."id" AND "ranked"."rank" > 1;
  `.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS "media_operation_retryOfId_active_uq"
  ON "media_operation" ("retryOfId")
  WHERE "retryOfId" IS NOT NULL AND "status" NOT IN ('completed', 'cancelled', 'failed');`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "media_operation_retryOfId_active_uq";`.execute(db);
  await sql`ALTER TABLE "media_operation_checkpoint" DROP COLUMN IF EXISTS "updateId";`.execute(db);
}
