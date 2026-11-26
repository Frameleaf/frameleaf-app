import { Kysely, sql } from 'kysely';

/**
 * FL-967: the back of a print, kept with its front.
 *
 * The restore is a trigger on the pair because a front can leave through many delete paths, including cascades.
 * It runs after the row is gone, so a statement deleting both front and back never updates a row it is about to
 * delete. A Locked back keeps its own `asset_lock` row throughout, so it comes back Locked.
 *
 * `asset_print_back_not_shared` is the backstop under every writer of album and shared-link membership (smart
 * albums, rules, imports, restores): a paired back is skipped, whichever path tried to add it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE "asset_print_back" (
      "frontAssetId" uuid NOT NULL,
      "backAssetId" uuid NOT NULL,
      "backPreviousVisibility" asset_visibility_enum NOT NULL,
      "searchText" text NOT NULL DEFAULT '',
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
      RETURN NULL;
    END;
    $$;
  `.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION asset_print_back_not_shared() RETURNS TRIGGER LANGUAGE PLPGSQL AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM asset_print_back WHERE "backAssetId" = NEW."assetId") THEN
        RETURN NULL;
      END IF;
      RETURN NEW;
    END;
    $$;
  `.execute(db);
  await sql`
    CREATE TRIGGER "asset_print_back_released_trigger" AFTER DELETE ON "asset_print_back"
      FOR EACH ROW EXECUTE FUNCTION asset_print_back_released();
  `.execute(db);
  await sql`
    CREATE TRIGGER "album_asset_print_back_not_shared" BEFORE INSERT ON "album_asset"
      FOR EACH ROW EXECUTE FUNCTION asset_print_back_not_shared();
  `.execute(db);
  await sql`
    CREATE TRIGGER "shared_link_asset_print_back_not_shared" BEFORE INSERT ON "shared_link_asset"
      FOR EACH ROW EXECUTE FUNCTION asset_print_back_not_shared();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "album_asset_print_back_not_shared" ON "album_asset";`.execute(db);
  await sql`DROP TRIGGER "shared_link_asset_print_back_not_shared" ON "shared_link_asset";`.execute(db);
  // dropping the table must not leave backs hidden: the release trigger restores each one
  await sql`DELETE FROM "asset_print_back";`.execute(db);
  await sql`DROP TABLE "asset_print_back";`.execute(db);
  await sql`DROP FUNCTION asset_print_back_released();`.execute(db);
  await sql`DROP FUNCTION asset_print_back_not_shared();`.execute(db);
}
