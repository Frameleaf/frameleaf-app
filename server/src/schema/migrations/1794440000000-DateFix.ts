import { Kysely, sql } from 'kysely';

/** FL-930: the Date & Time Doctor's applied fixes, kept 30 days for undo. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "date_fix_batch" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "userId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "undoneAt" timestamp with time zone,
  "count" integer NOT NULL,
  "cause" text,
  "shiftMinutes" integer,
  "timeZone" text,
  CONSTRAINT "date_fix_batch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "date_fix_batch_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "date_fix_batch_userId_createdAt_idx" ON "date_fix_batch" ("userId", "createdAt");`.execute(db);
  await sql`CREATE TABLE "date_fix_item" (
  "batchId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "previousDate" timestamp with time zone,
  "previousZone" text,
  "previousTakenAt" timestamp with time zone NOT NULL,
  "previousLocalDateTime" timestamp with time zone NOT NULL,
  "previousLocked" boolean NOT NULL,
  "newDate" timestamp with time zone NOT NULL,
  "newZone" text,
  "newLocalDateTime" timestamp with time zone NOT NULL,
  CONSTRAINT "date_fix_item_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "date_fix_batch" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "date_fix_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "date_fix_item_pkey" PRIMARY KEY ("batchId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "date_fix_item_assetId_idx" ON "date_fix_item" ("assetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "date_fix_item";`.execute(db);
  await sql`DROP TABLE "date_fix_batch";`.execute(db);
}
