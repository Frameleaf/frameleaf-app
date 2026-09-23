import { Kysely, sql } from 'kysely';

/**
 * Studio export versions, their provenance and the remote references they leave behind (FL-106,
 * `STU-404`).
 *
 * `studio_export_version` is one export from render to published version; `(projectId, version)` is
 * unique so two publications can never claim the same number, and `renderOperationId` is unique so a
 * render produces at most one version. `studio_export_version_source` records what every render read,
 * without foreign keys to the sources or their owners, so provenance survives their deletion.
 * `studio_export_remote_reference` keeps what a remote destination still has to stop or delete until
 * it acknowledges it; it deliberately has no foreign key to the owner or the render job, so an account
 * deletion or an official handoff cannot forget it.
 *
 * Names follow the generator's conventions so `migrations:generate` produces no drift. No trigger:
 * the repository writes `updatedAt` with every state change.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "studio_export_version" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "projectId" uuid,
  "revision" integer NOT NULL,
  "revisionDigest" character varying NOT NULL,
  "renderOperationId" uuid,
  "publishOperationId" uuid,
  "state" character varying NOT NULL DEFAULT 'rendering',
  "version" integer,
  "scope" character varying,
  "destination" character varying NOT NULL,
  "settings" jsonb NOT NULL,
  "workerId" character varying,
  "engineDigest" character varying,
  "outputPath" character varying,
  "outputChecksum" bytea,
  "outputSizeInBytes" bigint,
  "outputContentType" character varying,
  "outputRemoteRef" character varying,
  "outputRemovedAt" timestamp with time zone,
  "resultAssetId" uuid,
  "privacy" jsonb,
  "errorCode" character varying,
  "error" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "publishedAt" timestamp with time zone,
  "cancelledAt" timestamp with time zone,
  CONSTRAINT "studio_export_version_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_export_version_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "studio_project" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_export_version_renderOperationId_fkey" FOREIGN KEY ("renderOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_export_version_publishOperationId_fkey" FOREIGN KEY ("publishOperationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_export_version_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_export_version_renderOperationId_uq" UNIQUE ("renderOperationId"),
  CONSTRAINT "studio_export_version_projectId_version_uq" UNIQUE ("projectId", "version"),
  CONSTRAINT "studio_export_version_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "studio_export_version_ownerId_idx" ON "studio_export_version" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "studio_export_version_projectId_idx" ON "studio_export_version" ("projectId");`.execute(db);
  await sql`CREATE INDEX "studio_export_version_renderOperationId_idx" ON "studio_export_version" ("renderOperationId");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_export_version_publishOperationId_idx" ON "studio_export_version" ("publishOperationId");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_export_version_resultAssetId_idx" ON "studio_export_version" ("resultAssetId");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_export_version_projectId_createdAt_idx" ON "studio_export_version" ("projectId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_export_version_state_updatedAt_idx" ON "studio_export_version" ("state", "updatedAt");`.execute(
    db,
  );

  await sql`CREATE TABLE "studio_export_version_source" (
  "versionId" uuid NOT NULL,
  "key" character varying NOT NULL,
  "kind" character varying NOT NULL,
  "resourceId" character varying NOT NULL,
  "assetId" uuid,
  "ownerId" uuid,
  "checksum" character varying,
  "sourceAccess" character varying NOT NULL,
  "locked" boolean,
  "lockReason" character varying,
  "sensitive" boolean,
  CONSTRAINT "studio_export_version_source_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "studio_export_version" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_export_version_source_pkey" PRIMARY KEY ("versionId", "key")
);`.execute(db);
  await sql`CREATE INDEX "studio_export_version_source_versionId_idx" ON "studio_export_version_source" ("versionId");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_export_version_source_assetId_idx" ON "studio_export_version_source" ("assetId");`.execute(
    db,
  );

  await sql`CREATE TABLE "studio_export_remote_reference" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "versionId" uuid,
  "operationId" uuid NOT NULL,
  "ownerId" uuid,
  "workerId" character varying,
  "destination" character varying NOT NULL,
  "remoteRef" character varying,
  "reason" character varying NOT NULL,
  "requestedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "acknowledgedAt" timestamp with time zone,
  CONSTRAINT "studio_export_remote_reference_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "studio_export_version" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_export_remote_reference_operationId_workerId_reason_uq" UNIQUE ("operationId", "workerId", "reason"),
  CONSTRAINT "studio_export_remote_reference_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "studio_export_remote_reference_versionId_idx" ON "studio_export_remote_reference" ("versionId");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_export_remote_reference_workerId_acknowledgedAt_idx" ON "studio_export_remote_reference" ("workerId", "acknowledgedAt");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "studio_export_remote_reference";`.execute(db);
  await sql`DROP TABLE "studio_export_version_source";`.execute(db);
  await sql`DROP TABLE "studio_export_version";`.execute(db);
}
