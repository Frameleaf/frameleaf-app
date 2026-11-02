import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE photo_location_scan
    ADD COLUMN "estimateId" uuid,
    ADD COLUMN "eligiblePhotos" integer NOT NULL DEFAULT 0,
    ADD COLUMN "selectedPhotos" integer NOT NULL DEFAULT 0,
    ADD COLUMN "estimatedMicros" double precision NOT NULL DEFAULT 0,
    ADD COLUMN billing jsonb`.execute(db);
  await sql`CREATE UNIQUE INDEX photo_location_scan_estimate_idx ON photo_location_scan("estimateId")`.execute(db);
  await sql`CREATE TABLE photo_location_estimate (
    id uuid PRIMARY KEY DEFAULT immich_uuid_v7(),
    "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    record jsonb NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX "photo_location_estimate_ownerId_idx" ON photo_location_estimate("ownerId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE photo_location_estimate`.execute(db);
  await sql`DROP INDEX photo_location_scan_estimate_idx`.execute(db);
  await sql`ALTER TABLE photo_location_scan DROP COLUMN "estimateId", DROP COLUMN "eligiblePhotos",
    DROP COLUMN "selectedPhotos", DROP COLUMN "estimatedMicros", DROP COLUMN billing`.execute(db);
}
