import { Kysely, sql } from 'kysely';

/**
 * Preview-first restoration revisions (FL-115).
 *
 * One row is one restoration attempt on one asset: the reviewed preview and, once accepted, the
 * full-resolution derivative it binds to. The row is a *revision* of the asset, never a
 * replacement: `resultPath` is a new file, the original is only ever read, and `isCurrent` is an
 * explicit choice the owner makes afterwards, never something the job sets.
 *
 * The durable job state (progress, cancel, retry, lineage) lives in `media_operation` (FL-104);
 * this row only points at the preview and full operations and carries the reviewed binding
 * (destination, workload, mode, upscale, source checksum) the full render must inherit exactly.
 * The retention columns are what the sweep reads: a preview nobody reviewed and the files of a
 * rejected or superseded result do not live forever.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_restoration" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "assetId" uuid NOT NULL,
  "ownerId" uuid NOT NULL,
  "revision" integer NOT NULL,
  "status" character varying NOT NULL DEFAULT 'preview_queued',
  "mode" character varying NOT NULL,
  "upscale" integer NOT NULL DEFAULT 1,
  "keepGrain" boolean NOT NULL DEFAULT false,
  "workload" character varying NOT NULL,
  "destinationId" uuid,
  "destinationKind" character varying NOT NULL,
  "destinationName" character varying NOT NULL,
  "sourceType" character varying NOT NULL,
  "sourceChecksum" bytea NOT NULL,
  "sourceWidth" integer NOT NULL,
  "sourceHeight" integer NOT NULL,
  "sourceDurationSeconds" double precision,
  "previewRegion" jsonb NOT NULL,
  "previewOperationId" uuid,
  "fullOperationId" uuid,
  "previewBeforePath" character varying,
  "previewAfterPath" character varying,
  "resultPath" character varying,
  "resultPreviewPath" character varying,
  "outputWidth" integer,
  "outputHeight" integer,
  "modelName" character varying,
  "modelVersion" character varying,
  "provenance" jsonb NOT NULL DEFAULT '{}',
  "estimate" jsonb,
  "error" text,
  "isCurrent" boolean NOT NULL DEFAULT false,
  "previewReadyAt" timestamp with time zone,
  "reviewedAt" timestamp with time zone,
  "restoredAt" timestamp with time zone,
  "previewExpiresAt" timestamp with time zone,
  "resultExpiresAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "asset_restoration_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_restoration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_restoration_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ml_destination" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "asset_restoration_previewOperationId_fkey" FOREIGN KEY ("previewOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "asset_restoration_fullOperationId_fkey" FOREIGN KEY ("fullOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "asset_restoration_assetId_revision_uq" UNIQUE ("assetId", "revision"),
  CONSTRAINT "asset_restoration_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "asset_restoration_ownerId_createdAt_idx" ON "asset_restoration" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "asset_restoration_assetId_idx" ON "asset_restoration" ("assetId");`.execute(db);
  await sql`CREATE INDEX "asset_restoration_ownerId_idx" ON "asset_restoration" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "asset_restoration_destinationId_idx" ON "asset_restoration" ("destinationId");`.execute(db);
  await sql`CREATE INDEX "asset_restoration_previewOperationId_idx" ON "asset_restoration" ("previewOperationId");`.execute(
    db,
  );
  await sql`CREATE INDEX "asset_restoration_fullOperationId_idx" ON "asset_restoration" ("fullOperationId");`.execute(db);
  await sql`CREATE INDEX "asset_restoration_status_previewExpiresAt_idx" ON "asset_restoration" ("status", "previewExpiresAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "asset_restoration_resultExpiresAt_idx" ON "asset_restoration" ("resultExpiresAt");`.execute(db);
  // At most one restoration is the asset's chosen playback version; the partial index keeps two
  // concurrent selections from both succeeding.
  await sql`CREATE UNIQUE INDEX "asset_restoration_assetId_isCurrent_uq" ON "asset_restoration" ("assetId") WHERE "isCurrent";`.execute(
    db,
  );

  await sql`CREATE TRIGGER "asset_restoration_updatedAt"
  BEFORE UPDATE ON "asset_restoration"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_restoration";`.execute(db);
}
