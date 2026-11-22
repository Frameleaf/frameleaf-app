import { Kysely, sql } from 'kysely';

/** FL-925: a person's imported location history files and the places in them. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "location_history_source" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "kind" text,
  "fileName" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "importedAt" timestamp with time zone,
  "pointCount" integer NOT NULL DEFAULT 0,
  "firstAt" timestamp with time zone,
  "lastAt" timestamp with time zone,
  "error" text,
  CONSTRAINT "location_history_source_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "location_history_source_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "location_history_source_ownerId_createdAt_idx" ON "location_history_source" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE TABLE "location_point" (
  "ownerId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "recordedAt" timestamp with time zone NOT NULL,
  "latitude" double precision NOT NULL,
  "longitude" double precision NOT NULL,
  "accuracyM" real,
  CONSTRAINT "location_point_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "location_point_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "location_history_source" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);`.execute(db);
  await sql`CREATE INDEX "location_point_ownerId_recordedAt_idx" ON "location_point" ("ownerId", "recordedAt");`.execute(db);
  await sql`CREATE INDEX "location_point_sourceId_idx" ON "location_point" ("sourceId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "location_point";`.execute(db);
  await sql`DROP TABLE "location_history_source";`.execute(db);
}
