import { Kysely, sql } from 'kysely';

/** FL-226 prerequisite facts only. Existing rows have no inferred historical proof. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_integrity_verification" (
    "assetId" uuid NOT NULL REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "originalPath" text NOT NULL,
    "expectedChecksum" bytea NOT NULL,
    "checksumAlgorithm" text,
    "actualSha256" text,
    "result" text NOT NULL,
    "checkedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("assetId")
  );`.execute(db);
  await sql`CREATE TABLE "cloud_backup_manifest_original" (
    "manifestId" uuid NOT NULL REFERENCES "cloud_backup_manifest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "assetId" uuid NOT NULL,
    "sha256" text NOT NULL,
    PRIMARY KEY ("manifestId", "assetId")
  );`.execute(db);
  await sql`CREATE TABLE "cloud_backup_object_verification" (
    "bucket" text NOT NULL,
    "sha256" text NOT NULL,
    "operationId" uuid NOT NULL REFERENCES "media_operation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "method" text NOT NULL,
    "result" text NOT NULL,
    "checkedAt" timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("bucket", "sha256", "operationId")
  );`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "cloud_backup_object_verification";`.execute(db);
  await sql`DROP TABLE "cloud_backup_manifest_original";`.execute(db);
  await sql`DROP TABLE "asset_integrity_verification";`.execute(db);
}
