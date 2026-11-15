import { Kysely, sql } from 'kysely';

// FL-869 custom photo order and FL-881 text cards. Positions are plain doubles placed by midpoint; an
// album keeps them when it switches back to date order, so switching again restores the custom order.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD "isCustomOrder" boolean NOT NULL DEFAULT false`.execute(db);
  await sql`ALTER TABLE "album_asset" ADD "position" double precision`.execute(db);
  await sql`CREATE INDEX "album_asset_position_idx" ON "album_asset" ("albumId", "position")`.execute(db);
  await sql`CREATE TABLE "album_text_card" (
    "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
    "albumId" uuid NOT NULL,
    "position" double precision NOT NULL,
    "heading" text NOT NULL DEFAULT '',
    "body" text NOT NULL DEFAULT '',
    "createdById" uuid,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
    "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
    CONSTRAINT "album_text_card_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "album_text_card_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "album_text_card_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT "album_text_card_heading_check" CHECK (char_length(heading) <= 120),
    CONSTRAINT "album_text_card_body_check" CHECK (char_length(body) <= 2000)
  )`.execute(db);
  await sql`CREATE INDEX "album_text_card_position_idx" ON "album_text_card" ("albumId", "position")`.execute(db);
  await sql`CREATE INDEX "album_text_card_createdById_idx" ON "album_text_card" ("createdById")`.execute(db);
  await sql`CREATE INDEX "album_text_card_updateId_idx" ON "album_text_card" ("updateId")`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_text_card_updatedAt"
  BEFORE UPDATE ON "album_text_card"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "album_text_card"`.execute(db);
  await sql`DROP INDEX "album_asset_position_idx"`.execute(db);
  await sql`ALTER TABLE "album_asset" DROP COLUMN "position"`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "isCustomOrder"`.execute(db);
}
