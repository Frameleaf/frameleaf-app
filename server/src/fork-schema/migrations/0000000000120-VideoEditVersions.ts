import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Private references deliberately do not attach constraints to the official schema.
  await sql`CREATE TABLE immich_fork.video_edit_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "assetId" uuid NOT NULL,
    "ownerId" uuid NOT NULL,
    "sourcePath" text NOT NULL,
    "sourceChecksum" bytea NOT NULL,
    recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'array'),
    purpose text NOT NULL CHECK (purpose IN ('save', 'export', 'revert')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    files jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(files)='array'),
    "masterPath" text,
    "proxyPath" text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, "assetId", "ownerId"),
    CHECK (("masterPath" IS NULL) = ("proxyPath" IS NULL)),
    CHECK ("masterPath" IS NULL OR ("masterPath" <> "sourcePath" AND "proxyPath" <> "sourcePath" AND "masterPath" <> "proxyPath"))
  )`.execute(db);
  await sql`CREATE INDEX video_edit_version_asset_idx ON immich_fork.video_edit_version ("assetId", "createdAt" DESC)`.execute(
    db,
  );
  await sql`CREATE TABLE immich_fork.video_edit_selection (
    "assetId" uuid PRIMARY KEY,
    "ownerId" uuid NOT NULL,
    "requestedVersionId" uuid,
    "currentVersionId" uuid,
    FOREIGN KEY ("requestedVersionId", "assetId", "ownerId") REFERENCES immich_fork.video_edit_version (id, "assetId", "ownerId"),
    FOREIGN KEY ("currentVersionId", "assetId", "ownerId") REFERENCES immich_fork.video_edit_version (id, "assetId", "ownerId")
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.video_edit_selection`.execute(db);
  await sql`DROP TABLE immich_fork.video_edit_version`.execute(db);
}
