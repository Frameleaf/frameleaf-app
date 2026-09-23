import { Kysely, sql } from 'kysely';

/**
 * Duplicate review decisions (FL-61).
 *
 * One row per decided group: the complete group as the owner reviewed it, what was kept, trashed or
 * stacked, and the keepers' state before and after their group's metadata was merged into them. The
 * durable job that applies a decision writes its row before changing anything and completes it after,
 * which is what lets a replayed batch finish a half-applied group instead of applying it twice, and
 * lets an undo reverse it after the page that made it has gone.
 *
 * Additive only: nothing existing is read or rewritten. `down` drops the table; decisions already
 * applied stay applied (their photos remain kept, stacked or in the trash) and only become
 * irreversible from the review page.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "duplicate_decision" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "duplicateId" uuid NOT NULL,
  "operationId" uuid,
  "decision" character varying NOT NULL,
  "memberIds" jsonb NOT NULL,
  "keepAssetIds" jsonb NOT NULL,
  "trashAssetIds" jsonb NOT NULL,
  "stackId" uuid,
  "state" jsonb NOT NULL DEFAULT '{}',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "appliedAt" timestamp with time zone,
  "undoOperationId" uuid,
  "undoneAt" timestamp with time zone,
  CONSTRAINT "duplicate_decision_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "duplicate_decision_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "duplicate_decision_undoOperationId_fkey" FOREIGN KEY ("undoOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "duplicate_decision_operationId_duplicateId_uq" UNIQUE ("operationId", "duplicateId"),
  CONSTRAINT "duplicate_decision_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "duplicate_decision_ownerId_idx" ON "duplicate_decision" ("ownerId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "duplicate_decision_operationId_idx" ON "duplicate_decision" ("operationId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "duplicate_decision_undoOperationId_idx" ON "duplicate_decision" ("undoOperationId");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "duplicate_decision_ownerId_createdAt_idx" ON "duplicate_decision" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "duplicate_decision_ownerId_duplicateId_idx" ON "duplicate_decision" ("ownerId", "duplicateId");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "duplicate_decision";`.execute(db);
}
