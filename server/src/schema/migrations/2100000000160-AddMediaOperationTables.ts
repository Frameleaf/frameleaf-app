import { Kysely, sql } from 'kysely';

/**
 * Durable media operations and their render checkpoints (FL-43, FL-104).
 *
 * The job is a row, not a browser timer. `claimToken` is the lease every worker write is
 * conditioned on; `chunkKey` — not the chunk number — is what makes a checkpoint reusable.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "media_operation" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "kind" character varying NOT NULL,
  "status" character varying NOT NULL DEFAULT 'queued',
  "destination" character varying NOT NULL,
  "destinationDetail" character varying,
  "label" character varying NOT NULL,
  "assetId" uuid,
  "resultAssetId" uuid,
  "retryOfId" uuid,
  "projectId" character varying,
  "revisionId" character varying,
  "snapshot" jsonb NOT NULL,
  "settings" jsonb NOT NULL,
  "estimate" jsonb,
  "progress" double precision NOT NULL DEFAULT 0,
  "processedUnits" bigint NOT NULL DEFAULT 0,
  "totalUnits" bigint,
  "attempt" integer NOT NULL DEFAULT 0,
  "maxAttempts" integer NOT NULL DEFAULT 3,
  "claimToken" uuid,
  "claimedBy" character varying,
  "claimExpiresAt" timestamp with time zone,
  "heartbeatAt" timestamp with time zone,
  "cancelRequestedAt" timestamp with time zone,
  "cancelAcknowledgedAt" timestamp with time zone,
  "remoteJobId" character varying,
  "remoteReleasedAt" timestamp with time zone,
  "error" text,
  "errorCode" character varying,
  "startedAt" timestamp with time zone,
  "finishedAt" timestamp with time zone,
  "dismissedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "media_operation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "media_operation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "media_operation_resultAssetId_fkey" FOREIGN KEY ("resultAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "media_operation_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "media_operation_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "media_operation_ownerId_createdAt_idx" ON "media_operation" ("ownerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "media_operation_status_claimExpiresAt_idx" ON "media_operation" ("status", "claimExpiresAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "media_operation_kind_status_idx" ON "media_operation" ("kind", "status");`.execute(db);

  await sql`CREATE TRIGGER "media_operation_updatedAt"
  BEFORE UPDATE ON "media_operation"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "media_operation_checkpoint" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "operationId" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "state" character varying NOT NULL DEFAULT 'pending',
  "chunkKey" character varying NOT NULL,
  "inputDigest" character varying NOT NULL,
  "historyDigest" character varying NOT NULL,
  "configDigest" character varying NOT NULL,
  "seed" character varying,
  "timebase" character varying NOT NULL,
  "startTicks" bigint NOT NULL,
  "endTicks" bigint NOT NULL,
  "prerollTicks" bigint NOT NULL DEFAULT 0,
  "requiresSequentialContext" boolean NOT NULL DEFAULT false,
  "outputPath" character varying,
  "outputChecksum" bytea,
  "sizeInBytes" bigint,
  "attempt" integer NOT NULL DEFAULT 0,
  "claimToken" uuid,
  "completedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "media_operation_checkpoint_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "media_operation_checkpoint_operationId_sequence_uq" UNIQUE ("operationId", "sequence"),
  CONSTRAINT "media_operation_checkpoint_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "media_operation_checkpoint_operationId_chunkKey_idx" ON "media_operation_checkpoint" ("operationId", "chunkKey");`.execute(
    db,
  );

  await sql`CREATE TRIGGER "media_operation_checkpoint_updatedAt"
  BEFORE UPDATE ON "media_operation_checkpoint"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "media_operation_checkpoint";`.execute(db);
  await sql`DROP TABLE "media_operation";`.execute(db);
}
