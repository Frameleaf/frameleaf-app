import { Kysely, sql } from 'kysely';

/**
 * FL-63 — the owner's corrections to text read from photos.
 *
 * `asset_ocr` stays exactly what the text recognition produced and is still replaced wholesale when a
 * photo is read again. The owner's decisions (correct or dismiss a line; confirm, correct or dismiss a
 * suggested value) live here instead, keyed by what they are about and carrying the region and the
 * recognized text they were made against, so they survive a new reading without a foreign key to the
 * replaceable rows. See `AssetDocumentEditTable` for the columns.
 *
 * Additive only: nothing existing is rewritten. No triggers and no partial indexes, so the migration
 * needs no `migration_overrides` rows; `updatedAt` is written explicitly by `DocumentRepository`.
 * Idempotent, so a re-run after a partial failure finishes the job.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS "asset_document_edit" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "key" character varying NOT NULL,
  "action" character varying NOT NULL,
  "value" text,
  "sourceText" text,
  "x1" real,
  "y1" real,
  "x2" real,
  "y2" real,
  "x3" real,
  "y3" real,
  "x4" real,
  "y4" real,
  "revision" integer NOT NULL DEFAULT 1,
  "editedById" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_document_edit_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_document_edit_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "asset_document_edit_assetId_key_uq" UNIQUE ("assetId", "key"),
  CONSTRAINT "asset_document_edit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS "asset_document_edit_editedById_idx" ON "asset_document_edit" ("editedById");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE IF EXISTS "asset_document_edit";`.execute(db);
}
