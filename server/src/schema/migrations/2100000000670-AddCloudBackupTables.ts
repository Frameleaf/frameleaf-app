import { Kysely, sql } from 'kysely';

/**
 * Cloud backup (FL-160): the index of files already in the claimed bucket, one row per SHA-256
 * (`cloud_backup_object`), each run's manifest (`cloud_backup_manifest`) and the files a running
 * manifest has recorded so far (`cloud_backup_manifest_entry`), so a run resumed after a restart
 * finishes the same manifest. Nothing existing changes shape. `down` drops the three tables; the
 * bucket keeps everything already uploaded, and the next run rebuilds the index from its listing.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "cloud_backup_object" (
  "bucket" text NOT NULL,
  "sha256" text NOT NULL,
  "size" bigint NOT NULL,
  "etag" text,
  "uploadedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "lastSeenAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "cloud_backup_object_pkey" PRIMARY KEY ("bucket", "sha256")
);`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS "cloud_backup_manifest" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "bucket" text NOT NULL,
  "key" text NOT NULL,
  "databaseKey" text,
  "operationId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "finishedAt" timestamp with time zone,
  "assetCount" integer NOT NULL DEFAULT 0,
  "fileCount" integer NOT NULL DEFAULT 0,
  "bytes" bigint NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'running',
  CONSTRAINT "cloud_backup_manifest_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS "cloud_backup_manifest_entry" (
  "manifestId" uuid NOT NULL,
  "fileKey" text NOT NULL,
  "assetId" uuid,
  "ownerId" uuid,
  "role" text NOT NULL,
  "path" text NOT NULL,
  "sha256" text NOT NULL,
  "size" bigint NOT NULL,
  "mtime" timestamp with time zone,
  CONSTRAINT "cloud_backup_manifest_entry_pkey" PRIMARY KEY ("manifestId", "fileKey")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "cloud_backup_manifest_entry";`.execute(db);
  await sql`DROP TABLE IF EXISTS "cloud_backup_manifest";`.execute(db);
  await sql`DROP TABLE IF EXISTS "cloud_backup_object";`.execute(db);
}
