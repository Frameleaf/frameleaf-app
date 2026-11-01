import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE asset_exif ADD COLUMN "gpsAccuracyM" double precision`.execute(db);
  await sql`CREATE TABLE photo_location_scan (
    id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    status text NOT NULL, refresh boolean NOT NULL,
    total integer NOT NULL DEFAULT 0, processed integer NOT NULL DEFAULT 0,
    matched integer NOT NULL DEFAULT 0, unmatched integer NOT NULL DEFAULT 0,
    skipped integer NOT NULL DEFAULT 0, failed integer NOT NULL DEFAULT 0,
    error text, reason text, "cloudUrl" text NOT NULL, "instanceId" uuid NOT NULL, "linkedAt" text NOT NULL,
    state jsonb NOT NULL DEFAULT '{}', "leaseToken" uuid, "leaseUntil" timestamptz,
    "nextAttemptAt" timestamptz NOT NULL DEFAULT now(), "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX photo_location_scan_owner_created_idx ON photo_location_scan("ownerId", "createdAt")`.execute(db);
  await sql`CREATE INDEX photo_location_scan_ownerId_idx ON photo_location_scan("ownerId")`.execute(db);
  await sql`CREATE UNIQUE INDEX photo_location_scan_one_active_idx ON photo_location_scan("ownerId")
    WHERE status IN ('queued', 'preparing', 'uploading', 'running', 'paused')`.execute(db);
  await sql`CREATE TABLE photo_location_scan_item (
    "scanId" uuid NOT NULL REFERENCES photo_location_scan(id) ON DELETE CASCADE,
    "assetId" uuid NOT NULL REFERENCES asset(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "itemKey" text NOT NULL, latitude double precision NOT NULL, longitude double precision NOT NULL,
    "accuracyM" double precision, completed boolean NOT NULL DEFAULT false, PRIMARY KEY("scanId", "assetId")
  )`.execute(db);
  await sql`CREATE INDEX photo_location_scan_item_assetId_idx ON photo_location_scan_item("assetId")`.execute(db);
  await sql`CREATE INDEX photo_location_scan_item_scanId_idx ON photo_location_scan_item("scanId")`.execute(db);
  await sql`CREATE INDEX photo_location_scan_item_point_idx ON photo_location_scan_item("scanId", "itemKey")`.execute(db);
  await sql`CREATE TABLE asset_location_insight (
    "assetId" uuid PRIMARY KEY REFERENCES asset(id) ON UPDATE CASCADE ON DELETE CASCADE,
    latitude double precision NOT NULL, longitude double precision NOT NULL, insight jsonb,
    dismissed boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE FUNCTION photo_location_invalidate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.latitude IS DISTINCT FROM NEW.latitude OR OLD.longitude IS DISTINCT FROM NEW.longitude THEN
        DELETE FROM public.asset_location_insight WHERE "assetId" = NEW."assetId";
      ELSIF OLD."gpsAccuracyM" IS DISTINCT FROM NEW."gpsAccuracyM"
        OR COALESCE('latitude' = ANY(OLD."lockedProperties"), false) IS DISTINCT FROM COALESCE('latitude' = ANY(NEW."lockedProperties"), false) THEN
        DELETE FROM public.asset_location_insight WHERE "assetId" = NEW."assetId" AND NOT dismissed;
      ELSE RETURN NULL;
      END IF;
      DELETE FROM public.photo_location_scan_item WHERE "assetId" = NEW."assetId";
      RETURN NULL;
    END; $$`.execute(db);
  await sql`CREATE TRIGGER asset_exif_photo_location_invalidate AFTER UPDATE ON asset_exif FOR EACH ROW
    EXECUTE FUNCTION photo_location_invalidate()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER asset_exif_photo_location_invalidate ON asset_exif`.execute(db);
  await sql`DROP FUNCTION photo_location_invalidate()`.execute(db);
  await sql`DROP TABLE asset_location_insight, photo_location_scan_item, photo_location_scan`.execute(db);
  await sql`ALTER TABLE asset_exif DROP COLUMN "gpsAccuracyM"`.execute(db);
}
