import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TYPE library_scope_enum AS ENUM ('personal', 'design', 'both')`.execute(db);
  await sql`ALTER TABLE asset ADD COLUMN "libraryScope" library_scope_enum NOT NULL DEFAULT 'personal'`.execute(db);
  await sql`ALTER TABLE album ADD COLUMN "libraryScope" library_scope_enum NOT NULL DEFAULT 'personal'`.execute(db);
  await sql`CREATE INDEX asset_owner_scope_idx ON asset ("ownerId", "libraryScope")`.execute(db);
  await sql`CREATE FUNCTION asset_library_scope_refresh() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF OLD."libraryScope" = 'design' AND NEW."libraryScope" <> 'design' THEN
    UPDATE asset_exif SET "updatedAt" = clock_timestamp() WHERE "assetId" = NEW.id;
    UPDATE asset_edit SET "updatedAt" = clock_timestamp() WHERE "assetId" = NEW.id;
    UPDATE asset_face SET "updatedAt" = clock_timestamp() WHERE "assetId" = NEW.id;
    UPDATE asset_metadata SET "updatedAt" = clock_timestamp() WHERE "assetId" = NEW.id;
    UPDATE asset_ocr SET "updatedAt" = clock_timestamp() WHERE "assetId" = NEW.id;
  END IF;
  RETURN NEW;
END
$body$`.execute(db);
  await sql`CREATE TRIGGER asset_library_scope_refresh_trigger AFTER UPDATE ON asset
    FOR EACH ROW EXECUTE FUNCTION asset_library_scope_refresh()`.execute(db);
  await sql`CREATE FUNCTION album_library_scope_refresh() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF OLD."libraryScope" = 'design' AND NEW."libraryScope" <> 'design' THEN
    UPDATE album_asset SET "updatedAt" = clock_timestamp() WHERE "albumId" = NEW.id;
    UPDATE album_user SET "updatedAt" = clock_timestamp() WHERE "albumId" = NEW.id;
  END IF;
  RETURN NEW;
END
$body$`.execute(db);
  await sql`CREATE TRIGGER album_library_scope_refresh_trigger AFTER UPDATE ON album
    FOR EACH ROW EXECUTE FUNCTION album_library_scope_refresh()`.execute(db);

}

export function down(): Promise<void> {
  return Promise.reject(new Error('Library scope contains user organization; restore a backup rather than discarding scope metadata'));
}
