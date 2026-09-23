import { Kysely, sql } from 'kysely';

/**
 * Studio project lifecycle and portable bundle uploads (FL-91, `STU-204`).
 *
 * Additive only. `studio_project` gains the trash (`deletedAt`, `purgeAfter`), the archive
 * (`archivedAt`), the recents pointer (`lastOpenedAt`) and four lineage columns; every one is
 * nullable, so a row written before this migration is a live, unarchived project exactly as it
 * was. `studio_bundle_upload` registers an uploaded bundle file before the import job reads it.
 *
 * Nothing here touches an asset row. A project references library media and never owns it, so
 * trashing or purging a project deletes references only.
 *
 * Constraint and index names follow the generator's conventions (`{table}_{column}_fkey`,
 * `{table}_pkey`, and a `{table}_{column}_idx` index for every foreign-key column) so
 * `migrations:generate` produces no drift against the table classes.
 *
 * `importOperationId` is unique so a bundle import retried after a lost worker finds the project
 * the first attempt created instead of creating a second one.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "studio_project" ADD "deletedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "purgeAfter" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "archivedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "lastOpenedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "thumbnailAssetId" uuid;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "duplicatedFromId" uuid;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "importedFromDigest" character varying;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD "importOperationId" uuid;`.execute(db);
  await sql`ALTER TABLE "studio_project" ADD CONSTRAINT "studio_project_importOperationId_uq" UNIQUE ("importOperationId");`.execute(
    db,
  );

  await sql`ALTER TABLE "studio_project" ADD CONSTRAINT "studio_project_thumbnailAssetId_fkey" FOREIGN KEY ("thumbnailAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );
  await sql`ALTER TABLE "studio_project" ADD CONSTRAINT "studio_project_duplicatedFromId_fkey" FOREIGN KEY ("duplicatedFromId") REFERENCES "studio_project" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );

  await sql`CREATE INDEX "studio_project_thumbnailAssetId_idx" ON "studio_project" ("thumbnailAssetId");`.execute(db);
  await sql`CREATE INDEX "studio_project_duplicatedFromId_idx" ON "studio_project" ("duplicatedFromId");`.execute(db);
  await sql`CREATE INDEX "studio_project_purgeAfter_idx" ON "studio_project" ("purgeAfter");`.execute(db);

  await sql`CREATE TABLE "studio_bundle_upload" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "path" character varying NOT NULL,
  "sizeBytes" bigint NOT NULL,
  "digest" character varying NOT NULL,
  "originalFileName" character varying NOT NULL,
  "manifest" jsonb NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "consumedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "studio_bundle_upload_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_bundle_upload_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "studio_bundle_upload_ownerId_idx" ON "studio_bundle_upload" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "studio_bundle_upload_ownerId_expiresAt_idx" ON "studio_bundle_upload" ("ownerId", "expiresAt");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "studio_bundle_upload";`.execute(db);

  await sql`DROP INDEX "studio_project_purgeAfter_idx";`.execute(db);
  await sql`DROP INDEX "studio_project_duplicatedFromId_idx";`.execute(db);
  await sql`DROP INDEX "studio_project_thumbnailAssetId_idx";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP CONSTRAINT "studio_project_duplicatedFromId_fkey";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP CONSTRAINT "studio_project_thumbnailAssetId_fkey";`.execute(db);

  await sql`ALTER TABLE "studio_project" DROP CONSTRAINT "studio_project_importOperationId_uq";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "importOperationId";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "importedFromDigest";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "duplicatedFromId";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "thumbnailAssetId";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "lastOpenedAt";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "archivedAt";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "purgeAfter";`.execute(db);
  await sql`ALTER TABLE "studio_project" DROP COLUMN "deletedAt";`.execute(db);
}
