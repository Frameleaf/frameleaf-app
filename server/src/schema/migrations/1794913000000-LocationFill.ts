import { Kysely, sql } from 'kysely';

/** FL-964: runs that propose locations for photos from location history, and their proposals. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "location_fill_run" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "status" text NOT NULL DEFAULT 'proposing',
  "maxGapMinutes" integer NOT NULL,
  "takenAfter" timestamp with time zone,
  "takenBefore" timestamp with time zone,
  "candidateCount" integer NOT NULL DEFAULT 0,
  "proposalCount" integer NOT NULL DEFAULT 0,
  "appliedCount" integer NOT NULL DEFAULT 0,
  "appliedAt" timestamp with time zone,
  "undoneAt" timestamp with time zone,
  "error" text,
  CONSTRAINT "location_fill_run_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "location_fill_run_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "location_fill_run_ownerId_createdAt_idx" ON "location_fill_run" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE TABLE "location_fill_proposal" (
  "runId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "latitude" double precision NOT NULL,
  "longitude" double precision NOT NULL,
  "method" text NOT NULL,
  "gapSeconds" integer NOT NULL,
  "requestedAt" timestamp with time zone,
  "appliedAt" timestamp with time zone,
  "undoneAt" timestamp with time zone,
  CONSTRAINT "location_fill_proposal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "location_fill_run" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "location_fill_proposal_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "location_fill_proposal_pkey" PRIMARY KEY ("runId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "location_fill_proposal_assetId_idx" ON "location_fill_proposal" ("assetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "location_fill_proposal";`.execute(db);
  await sql`DROP TABLE "location_fill_run";`.execute(db);
}
