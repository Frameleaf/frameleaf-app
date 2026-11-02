import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "bookmark" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "url" text NOT NULL,
  "title" text NOT NULL,
  "note" text,
  "previewAssetId" uuid,
  "libraryScope" library_scope_enum NOT NULL DEFAULT 'design',
  "isArchived" boolean NOT NULL DEFAULT false,
  "isLocked" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "deletedAt" timestamp with time zone,
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "bookmark_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "bookmark_previewAssetId_fkey" FOREIGN KEY ("previewAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "bookmark_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "bookmark_ownerId_libraryScope_idx" ON "bookmark" ("ownerId", "libraryScope");`.execute(db);
  await sql`CREATE INDEX "bookmark_previewAssetId_idx" ON "bookmark" ("previewAssetId");`.execute(db);
  await sql`CREATE INDEX "bookmark_updateId_idx" ON "bookmark" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "bookmark_updatedAt"
  BEFORE UPDATE ON "bookmark"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`CREATE TABLE "album_bookmark" (
  "albumId" uuid NOT NULL,
  "bookmarkId" uuid NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "album_bookmark_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_bookmark_bookmarkId_fkey" FOREIGN KEY ("bookmarkId") REFERENCES "bookmark" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "album_bookmark_pkey" PRIMARY KEY ("albumId", "bookmarkId")
);`.execute(db);
  await sql`CREATE INDEX "album_bookmark_albumId_idx" ON "album_bookmark" ("albumId");`.execute(db);
  await sql`CREATE INDEX "album_bookmark_bookmarkId_idx" ON "album_bookmark" ("bookmarkId");`.execute(db);
  await sql`CREATE TABLE "bookmark_tag" (
  "bookmarkId" uuid NOT NULL,
  "tagId" uuid NOT NULL,
  CONSTRAINT "bookmark_tag_bookmarkId_fkey" FOREIGN KEY ("bookmarkId") REFERENCES "bookmark" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "bookmark_tag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "tag" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "bookmark_tag_pkey" PRIMARY KEY ("bookmarkId", "tagId")
);`.execute(db);
  await sql`CREATE INDEX "bookmark_tag_bookmarkId_idx" ON "bookmark_tag" ("bookmarkId");`.execute(db);
  await sql`CREATE INDEX "bookmark_tag_tagId_idx" ON "bookmark_tag" ("tagId");`.execute(db);
  await sql`CREATE TABLE "asset_source" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "captureId" uuid NOT NULL,
  "pageUrl" text NOT NULL,
  "mediaUrl" text,
  "title" text NOT NULL,
  "capturedAt" timestamp with time zone NOT NULL,
  "note" text,
  "creator" text,
  "licenseUrl" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_source_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_source_captureId_uq" UNIQUE ("captureId"),
  CONSTRAINT "asset_source_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "asset_source_assetId_idx" ON "asset_source" ("assetId");`.execute(db);
}

export function down(): Promise<void> {
  return Promise.reject(new Error('Bookmarks and capture sources contain user data; restore a backup rather than discarding them'));
}
