import { Kysely, sql } from 'kysely';

/**
 * Revision-bound Studio preview frames (FL-96, `STU-402`).
 *
 * `revisionDigest` holds FL-90's authorized manifest digest when the request carried one, and
 * the graph revision digest otherwise. `grantToken` is the FL-90 preview read grant that frame
 * delivery verifies on every request.
 *
 * One row per (owner, project, revision digest, exact rational time, quality, viewport). `cacheKey` is
 * the digest over exactly those and carries the unique constraint, so the store can never hold
 * two rows claiming to be the same frame. `projectId` and `revisionDigest` are plain columns:
 * Studio project storage is a private sidecar owned by a story in flight, and the Studio plan
 * forbids adding a public foreign key for it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "studio_preview_frame" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "ownerId" uuid NOT NULL,
  "projectId" character varying NOT NULL,
  "revisionDigest" character varying NOT NULL,
  "projectRevision" integer,
  "grantToken" text,
  "grantSessionId" character varying,
  "cacheKey" character varying NOT NULL,
  "timeNumerator" bigint NOT NULL,
  "timeDenominator" bigint NOT NULL,
  "quality" character varying NOT NULL,
  "viewportWidth" integer NOT NULL,
  "viewportHeight" integer NOT NULL,
  "status" character varying NOT NULL DEFAULT 'pending',
  "operationId" uuid,
  "seekGeneration" bigint NOT NULL DEFAULT 0,
  "framePath" character varying,
  "contentType" character varying,
  "sizeInBytes" bigint,
  "frameChecksum" bytea,
  "framePts" bigint,
  "framePtsTimebase" character varying,
  "toneMapped" boolean NOT NULL DEFAULT false,
  "errorCode" character varying,
  "requestedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "readyAt" timestamp with time zone,
  "lastAccessedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "expiresAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "studio_preview_frame_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "studio_preview_frame_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "media_operation" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "studio_preview_frame_cacheKey_uq" UNIQUE ("cacheKey"),
  CONSTRAINT "studio_preview_frame_pkey" PRIMARY KEY ("id")
);`.execute(db);

  await sql`CREATE INDEX "studio_preview_frame_ownerId_projectId_revisionDigest_idx" ON "studio_preview_frame" ("ownerId", "projectId", "revisionDigest");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_preview_frame_projectId_requestedAt_idx" ON "studio_preview_frame" ("projectId", "requestedAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "studio_preview_frame_status_expiresAt_idx" ON "studio_preview_frame" ("status", "expiresAt");`.execute(
    db,
  );

  await sql`CREATE TRIGGER "studio_preview_frame_updatedAt"
  BEFORE UPDATE ON "studio_preview_frame"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "studio_preview_frame";`.execute(db);
}
