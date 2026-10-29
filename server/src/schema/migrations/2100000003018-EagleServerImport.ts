import { Kysely, sql } from 'kysely';

// FL-653: an Eagle library in a folder the server can open is imported by the server, so it carries
// on with the tab closed. One row per import (its collections, tags and progress) and one per item
// brought over, so a stopped or interrupted import carries on without sending anything twice.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "eagle_import" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "rootId" character varying NOT NULL,
  "relativePath" character varying NOT NULL,
  "libraryPath" character varying NOT NULL,
  "libraryName" character varying NOT NULL,
  "fingerprint" character varying NOT NULL,
  "target" jsonb NOT NULL,
  "existingTop" jsonb NOT NULL DEFAULT '[]',
  "status" character varying NOT NULL DEFAULT 'running',
  "total" integer NOT NULL DEFAULT 0,
  "rootAlbumId" uuid,
  "albums" jsonb NOT NULL DEFAULT '{}',
  "tagIds" jsonb NOT NULL DEFAULT '{}',
  "failed" jsonb NOT NULL DEFAULT '[]',
  "recent" jsonb NOT NULL DEFAULT '[]',
  "error" text,
  "leaseOwner" character varying,
  "leaseExpiresAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "eagle_import_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "eagle_import_rootAlbumId_fkey" FOREIGN KEY ("rootAlbumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "eagle_import_status_check" CHECK ("status" IN ('running', 'stopping', 'stopped', 'finished')),
  CONSTRAINT "eagle_import_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "eagle_import_ownerId_createdAt_idx" ON "eagle_import" ("ownerId", "createdAt");`.execute(db);
  await sql`CREATE INDEX "eagle_import_ownerId_idx" ON "eagle_import" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "eagle_import_rootAlbumId_idx" ON "eagle_import" ("rootAlbumId");`.execute(db);
  await sql`CREATE TABLE "eagle_import_item" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "importId" uuid NOT NULL,
  "itemId" character varying NOT NULL,
  "assetId" uuid NOT NULL,
  "duplicate" boolean NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "eagle_import_item_importId_fkey" FOREIGN KEY ("importId") REFERENCES "eagle_import" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "eagle_import_item_importId_itemId_uq" UNIQUE ("importId", "itemId"),
  CONSTRAINT "eagle_import_item_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "eagle_import_item_importId_idx" ON "eagle_import_item" ("importId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Only the import records go; everything an import brought into Boards stays.
  await sql`DROP TABLE "eagle_import_item";`.execute(db);
  await sql`DROP TABLE "eagle_import";`.execute(db);
}
