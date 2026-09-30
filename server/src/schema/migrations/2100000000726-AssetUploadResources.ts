import { Kysely, sql } from 'kysely';

/** Owner deletion retains cleanup knowledge; only an explicitly cleaned resource releases its parts. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE asset_upload_resource (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "ownerId" uuid REFERENCES "user"(id) ON DELETE SET NULL ON UPDATE CASCADE,
    metadata jsonb NOT NULL, "expectedChecksum" bytea NOT NULL, "contentType" text NOT NULL,
    "expectedSize" bigint, "offset" bigint NOT NULL DEFAULT 0, "maxSize" bigint NOT NULL, "maxAppendSize" bigint NOT NULL,
    state text NOT NULL DEFAULT 'receiving', "finalPath" text, "verifiedChecksum" bytea, "legacyChecksum" bytea,
    "resultAssetId" uuid, "resultStatus" text, ingested boolean NOT NULL DEFAULT false,
    "ingestionToken" uuid, "ingestionLeaseExpiresAt" timestamp with time zone,
    "expiresAt" timestamp with time zone NOT NULL, "createdAt" timestamp with time zone NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX "asset_upload_resource_ownerId_idx" ON asset_upload_resource ("ownerId")`.execute(db);
  await sql`CREATE INDEX "asset_upload_resource_expiresAt_idx" ON asset_upload_resource ("expiresAt")`.execute(db);
  await sql`CREATE TABLE asset_upload_part (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "resourceId" uuid NOT NULL REFERENCES asset_upload_resource(id) ON DELETE CASCADE ON UPDATE CASCADE,
    path text NOT NULL, "offset" bigint NOT NULL, size bigint NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX "asset_upload_part_resourceId_idx" ON asset_upload_part ("resourceId")`.execute(db);
  await sql`CREATE UNIQUE INDEX "asset_upload_part_resourceId_offset_idx" ON asset_upload_part ("resourceId", "offset")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_upload_part`.execute(db);
  await sql`DROP TABLE asset_upload_resource`.execute(db);
}
