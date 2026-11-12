import { Kysely, sql } from 'kysely';

/** Photos read per statement while filling the ledger, so a large library is never one long statement. */
const BACKFILL_BATCH = 50_000;

/**
 * FL-921: the nothing-lost ledger, one row for every original the server has accepted, and its rows for
 * the photos that are already here. How those arrived is not recorded anywhere, except a library's.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_ledger" (
  "assetId" uuid NOT NULL,
  "ownerId" uuid NOT NULL,
  "checksum" bytea NOT NULL,
  "originalFileName" text NOT NULL,
  "addedAt" timestamp with time zone NOT NULL,
  "addedVia" text NOT NULL,
  "state" text NOT NULL DEFAULT 'kept',
  "stateAt" timestamp with time zone NOT NULL DEFAULT now(),
  "stateBy" uuid,
  "reason" text,
  CONSTRAINT "asset_ledger_pkey" PRIMARY KEY ("assetId")
);`.execute(db);

  for (let after = '00000000-0000-0000-0000-000000000000'; ; ) {
    const edge = await sql<{ id: string }>`
      SELECT "id" FROM "asset" WHERE "id" > ${after}::uuid ORDER BY "id" OFFSET ${BACKFILL_BATCH - 1} LIMIT 1
    `.execute(db);
    const last = edge.rows[0]?.id;
    await sql`
      INSERT INTO "asset_ledger"
        ("assetId", "ownerId", "checksum", "originalFileName", "addedAt", "addedVia", "state", "stateAt")
      SELECT a."id", a."ownerId", a."checksum", a."originalFileName", a."createdAt",
        CASE WHEN a."libraryId" IS NULL THEN 'unknown' ELSE 'library-scan' END,
        CASE a."status" WHEN 'trashed' THEN 'trashed' WHEN 'deleted' THEN 'removed' ELSE 'kept' END,
        coalesce(a."deletedAt", a."createdAt")
      FROM "asset" a
      WHERE a."id" > ${after}::uuid ${last ? sql`AND a."id" <= ${last}::uuid` : sql``}
    `.execute(db);
    if (!last) {
      break;
    }
    after = last;
  }

  // after the rows, so the fill writes each index once
  await sql`CREATE INDEX "asset_ledger_owner_state_idx" ON "asset_ledger" ("ownerId", "state", "stateAt", "assetId");`.execute(
    db,
  );
  await sql`CREATE INDEX "asset_ledger_missing_idx" ON "asset_ledger" ("ownerId") WHERE state = 'missing';`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_ledger";`.execute(db);
}
