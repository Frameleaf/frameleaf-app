import { Kysely, sql } from 'kysely';

/**
 * FL-967: the back of a print, kept with its front.
 *
 * The restore is a trigger on the pair because a front can leave through many delete paths, including cascades.
 * It runs after the row is gone, so a statement deleting both front and back never updates a row it is about to
 * delete. The asset's own lock row may already be gone by then, so a BEFORE DELETE trigger on the asset notes it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE "asset_print_back" (
      "frontAssetId" uuid NOT NULL,
      "backAssetId" uuid NOT NULL,
      "backPreviousVisibility" asset_visibility_enum NOT NULL,
      "searchText" text NOT NULL DEFAULT '',
      "frontLockReason" text,
      "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "asset_print_back_pkey" PRIMARY KEY ("frontAssetId"),
      CONSTRAINT "asset_print_back_backAssetId_uq" UNIQUE ("backAssetId"),
      CONSTRAINT "asset_print_back_frontAssetId_fkey" FOREIGN KEY ("frontAssetId") REFERENCES "asset" ("id") ON DELETE CASCADE,
      CONSTRAINT "asset_print_back_backAssetId_fkey" FOREIGN KEY ("backAssetId") REFERENCES "asset" ("id") ON DELETE CASCADE,
      CONSTRAINT "asset_print_back_two_assets" CHECK ("frontAssetId" <> "backAssetId")
    );
  `.execute(db);
  await sql`CREATE INDEX "idx_asset_print_back_search_text" ON "asset_print_back" USING gin (f_unaccent("searchText") gin_trgm_ops);`.execute(
    db,
  );
  await sql`
    CREATE OR REPLACE FUNCTION asset_print_back_released() RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
    BEGIN
      UPDATE asset SET visibility = OLD."backPreviousVisibility"
        WHERE id = OLD."backAssetId" AND visibility = 'hidden';
      IF OLD."frontLockReason" IS NOT NULL THEN
        INSERT INTO asset_lock ("assetId", reason)
          SELECT id, OLD."frontLockReason" FROM asset WHERE id = OLD."backAssetId"
          ON CONFLICT DO NOTHING;
      END IF;
      RETURN NULL;
    END;
    $$;
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION asset_print_back_front_deleting() RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
    BEGIN
      UPDATE asset_print_back pair SET "frontLockReason" = lock.reason
        FROM asset_lock lock
        WHERE pair."frontAssetId" = OLD.id AND lock."assetId" = OLD.id;
      RETURN OLD;
    END;
    $$;
  `.execute(db);
  await sql`
    CREATE TRIGGER "asset_print_back_released_trigger" AFTER DELETE ON "asset_print_back"
      FOR EACH ROW EXECUTE FUNCTION asset_print_back_released();
  `.execute(db);
  await sql`
    CREATE TRIGGER "asset_print_back_front_deleting_trigger" BEFORE DELETE ON "asset"
      FOR EACH ROW EXECUTE FUNCTION asset_print_back_front_deleting();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "asset_print_back_front_deleting_trigger" ON "asset";`.execute(db);
  // dropping the table must not leave backs hidden: restore them first, keeping a Locked front's back private
  await sql`UPDATE asset_print_back pair SET "frontLockReason" = lock.reason FROM asset_lock lock WHERE lock."assetId" = pair."frontAssetId";`.execute(
    db,
  );
  await sql`DELETE FROM "asset_print_back";`.execute(db);
  await sql`DROP TABLE "asset_print_back";`.execute(db);
  await sql`DROP FUNCTION asset_print_back_released();`.execute(db);
  await sql`DROP FUNCTION asset_print_back_front_deleting();`.execute(db);
}
