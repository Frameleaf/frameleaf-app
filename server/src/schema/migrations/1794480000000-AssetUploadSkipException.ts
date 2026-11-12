import { Kysely, sql } from 'kysely';

/** FL-813: the "Allow again" list, and the lookup every upload makes into the owner's deletions. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_upload_skip_exception" (
  "ownerId" uuid NOT NULL,
  "checksum" bytea NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_upload_skip_exception_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_upload_skip_exception_pkey" PRIMARY KEY ("ownerId", "checksum")
);`.execute(db);
  await sql`CREATE INDEX "asset_backup_deletion_ownerId_checksum_idx" ON "asset_backup_deletion" ("ownerId", "checksum");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_backup_deletion_ownerId_checksum_idx";`.execute(db);
  await sql`DROP TABLE "asset_upload_skip_exception";`.execute(db);
}
