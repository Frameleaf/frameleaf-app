import { Kysely, sql } from 'kysely';

/**
 * FL-1676: Cloud Backup stores through the backup engine. The per-file object index, its verification proofs
 * and the running manifest's file list belonged to the old format, which is removed rather than migrated (no
 * backups in it exist). The records of backups in the old format go with it: nothing can read them now.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "cloud_backup_object_verification"`.execute(db);
  await sql`DROP TABLE "cloud_backup_object"`.execute(db);
  await sql`DROP TABLE "cloud_backup_manifest_entry"`.execute(db);
  await sql`DELETE FROM "cloud_backup_manifest" WHERE "key" NOT LIKE 'r/v1/%'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "cloud_backup_manifest_entry" (
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
  )`.execute(db);
  await sql`CREATE TABLE "cloud_backup_object" (
    "bucket" text NOT NULL,
    "sha256" text NOT NULL,
    "size" bigint NOT NULL,
    "etag" text,
    "uploadedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "lastSeenAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "cloud_backup_object_pkey" PRIMARY KEY ("bucket", "sha256")
  )`.execute(db);
  await sql`CREATE TABLE "cloud_backup_object_verification" (
    "bucket" text NOT NULL,
    "sha256" text NOT NULL,
    "operationId" uuid NOT NULL,
    "method" text NOT NULL,
    "result" text NOT NULL,
    "checkedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "cloud_backup_object_verification_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "cloud_backup_object_verification_pkey" PRIMARY KEY ("bucket", "sha256", "operationId")
  )`.execute(db);
  await sql`CREATE INDEX "cloud_backup_object_verification_operationId_idx" ON "cloud_backup_object_verification" ("operationId")`.execute(
    db,
  );
}
