import { Kysely, sql } from 'kysely';

/**
 * Google Photos imports (FL-65, `IMP-001`).
 *
 * `takeout_import` is the wizard: its sources, its phase and the owner's import choices. The work
 * runs as durable `media_operation` jobs of kind `takeout_import`; `runOperationId` is the job that
 * currently holds the import. `takeout_source` lists staged archives and selected server
 * directories, `takeout_file` every file found in them, `takeout_item` each photo or video to import
 * with its outcome, `takeout_pair` possible Live Photo pairs and the owner's decisions, and
 * `takeout_album` the album each export folder became, so importing the same export again adds to
 * those albums instead of making new ones.
 *
 * Constraint and index names follow the generator's conventions (`{table}_{column}_fkey`,
 * `{table}_pkey`, `{table}_{columns}_uq`, and a `{table}_{column}_idx` index for every foreign-key
 * column that is not the primary key) so `migrations:generate` produces no drift against the table
 * classes in `src/schema/tables/takeout.table.ts`. No table has an `updated_at` trigger: the queries
 * that change a row write `updatedAt` themselves.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "takeout_import" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "name" character varying NOT NULL,
  "phase" character varying NOT NULL DEFAULT 'sources',
  "options" jsonb NOT NULL,
  "runOperationId" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_import_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_import_runOperationId_fkey" FOREIGN KEY ("runOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "takeout_import_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_import_ownerId_idx" ON "takeout_import" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "takeout_import_runOperationId_idx" ON "takeout_import" ("runOperationId");`.execute(db);
  await sql`CREATE INDEX "takeout_import_ownerId_createdAt_idx" ON "takeout_import" ("ownerId", "createdAt");`.execute(
    db,
  );

  await sql`CREATE TABLE "takeout_source" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "importId" uuid NOT NULL,
  "name" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "path" character varying NOT NULL,
  "size" bigint NOT NULL DEFAULT 0,
  "received" bigint NOT NULL DEFAULT 0,
  "rejected" integer NOT NULL DEFAULT 0,
  "scanned" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_source_importId_fkey" FOREIGN KEY ("importId") REFERENCES "takeout_import" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_source_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_source_importId_idx" ON "takeout_source" ("importId");`.execute(db);

  await sql`CREATE TABLE "takeout_file" (
  "id" uuid NOT NULL,
  "importId" uuid NOT NULL,
  "sourceId" uuid NOT NULL,
  "entryName" character varying NOT NULL,
  "relativePath" character varying NOT NULL,
  "folder" character varying NOT NULL,
  "name" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "path" character varying NOT NULL,
  "size" bigint NOT NULL,
  "checksum" bytea NOT NULL,
  "legacyChecksum" bytea NOT NULL,
  "modifiedAt" timestamp with time zone NOT NULL,
  "metadata" jsonb,
  CONSTRAINT "takeout_file_importId_fkey" FOREIGN KEY ("importId") REFERENCES "takeout_import" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_file_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "takeout_source" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_file_sourceId_entryName_uq" UNIQUE ("sourceId", "entryName"),
  CONSTRAINT "takeout_file_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_file_importId_idx" ON "takeout_file" ("importId");`.execute(db);
  await sql`CREATE INDEX "takeout_file_sourceId_idx" ON "takeout_file" ("sourceId");`.execute(db);
  await sql`CREATE INDEX "takeout_file_importId_folder_idx" ON "takeout_file" ("importId", "folder");`.execute(db);

  await sql`CREATE TABLE "takeout_item" (
  "id" uuid NOT NULL,
  "importId" uuid NOT NULL,
  "state" character varying NOT NULL DEFAULT 'ready',
  "metadata" jsonb NOT NULL,
  "sidecarId" uuid,
  "candidates" jsonb NOT NULL,
  "albums" jsonb NOT NULL,
  "warnings" jsonb NOT NULL,
  "locked" boolean NOT NULL DEFAULT false,
  "assetId" uuid,
  "resultKind" character varying,
  "createPath" character varying,
  "error" text,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "takeout_item_id_fkey" FOREIGN KEY ("id") REFERENCES "takeout_file" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_item_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "takeout_item_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_item_assetId_idx" ON "takeout_item" ("assetId");`.execute(db);
  await sql`CREATE INDEX "takeout_item_importId_state_idx" ON "takeout_item" ("importId", "state");`.execute(db);

  await sql`CREATE TABLE "takeout_pair" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "importId" uuid NOT NULL,
  "photoItemId" uuid NOT NULL,
  "videoItemId" uuid NOT NULL,
  "state" character varying NOT NULL DEFAULT 'suggested',
  "reason" character varying NOT NULL,
  "error" text,
  CONSTRAINT "takeout_pair_photoItemId_fkey" FOREIGN KEY ("photoItemId") REFERENCES "takeout_item" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_pair_videoItemId_fkey" FOREIGN KEY ("videoItemId") REFERENCES "takeout_item" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_pair_photoItemId_videoItemId_uq" UNIQUE ("photoItemId", "videoItemId"),
  CONSTRAINT "takeout_pair_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_pair_photoItemId_idx" ON "takeout_pair" ("photoItemId");`.execute(db);
  await sql`CREATE INDEX "takeout_pair_videoItemId_idx" ON "takeout_pair" ("videoItemId");`.execute(db);
  await sql`CREATE INDEX "takeout_pair_importId_state_idx" ON "takeout_pair" ("importId", "state");`.execute(db);

  await sql`CREATE TABLE "takeout_album" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "folder" character varying NOT NULL,
  "albumId" uuid NOT NULL,
  CONSTRAINT "takeout_album_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_album_albumId_fkey" FOREIGN KEY ("albumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "takeout_album_ownerId_folder_uq" UNIQUE ("ownerId", "folder"),
  CONSTRAINT "takeout_album_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "takeout_album_ownerId_idx" ON "takeout_album" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "takeout_album_albumId_idx" ON "takeout_album" ("albumId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // Staged copies on disk are left for the owner-deletion and discard paths; they are never library
  // originals, and nothing an import created in the library is touched here.
  await sql`DROP TABLE "takeout_album";`.execute(db);
  await sql`DROP TABLE "takeout_pair";`.execute(db);
  await sql`DROP TABLE "takeout_item";`.execute(db);
  await sql`DROP TABLE "takeout_file";`.execute(db);
  await sql`DROP TABLE "takeout_source";`.execute(db);
  await sql`DROP TABLE "takeout_import";`.execute(db);
}
