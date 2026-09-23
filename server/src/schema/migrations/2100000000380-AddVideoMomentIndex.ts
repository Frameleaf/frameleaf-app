import { Kysely, sql } from 'kysely';

/**
 * Reusable video frames and the timestamped moment index (FL-59, `REC-101`).
 *
 * - `video_moment_index`: one row per video with frames, pinning the source, model, prompt and
 *   identity provenance its generated results were made from, and the owner's chosen cover.
 * - `video_moment_frame`: six evenly spaced, ranked frames per video, cut once and reused by the
 *   description grid, the moment index and moment captions. Independent of duplicate detection.
 * - `video_moment_frame_embedding`: the search embedding of each frame. A separate table because a
 *   change of search model empties every embedding table (`DatabaseRepository.setDimensionSize`),
 *   and that must never remove frames or moments. It takes the current dimension of
 *   `smart_search.embedding` so the two always match.
 * - `video_moment`: generated moments (one per frame, optional caption) and the owner's manual
 *   moments with an optional typed transcript. Refreshing generated results never touches a manual
 *   moment; the frame reference is `SET NULL` so a manual moment outlives the frames.
 *
 * `media_operation_enrichment_plan_requestKey_uq` makes an enrichment plan's client idempotency key
 * unique per owner, so two submits of the same plan racing each other create one plan, not two.
 *
 * Constraint and index names follow the generator's conventions (`{table}_{column}_fkey`,
 * `{table}_pkey`, `{table}_{columns}_uq`, a `{table}_{column}_idx` index for every foreign-key
 * column that is not the primary key) so `migrations:generate` produces no drift.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "video_moment_index" (
  "assetId" uuid NOT NULL,
  "sourceFingerprint" character varying NOT NULL,
  "extractorVersion" character varying NOT NULL,
  "frameCount" integer NOT NULL DEFAULT 0,
  "framesExtractedAt" timestamp with time zone,
  "embeddingModel" character varying,
  "embeddingDestinationId" uuid,
  "indexedAt" timestamp with time zone,
  "captionModel" character varying,
  "captionConfigHash" character varying,
  "captionIdentityHash" character varying,
  "captionDestinationId" uuid,
  "captionedAt" timestamp with time zone,
  "coverTimestampMs" integer,
  "coverSetById" uuid,
  "coverSetAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "video_moment_index_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "video_moment_index_coverSetById_fkey" FOREIGN KEY ("coverSetById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "video_moment_index_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE INDEX "video_moment_index_coverSetById_idx" ON "video_moment_index" ("coverSetById");`.execute(db);
  await sql`CREATE TRIGGER "video_moment_index_updatedAt"
  BEFORE UPDATE ON "video_moment_index"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "video_moment_frame" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "assetId" uuid NOT NULL,
  "frameIndex" integer NOT NULL,
  "timestampMs" integer NOT NULL,
  "path" character varying NOT NULL,
  "width" integer,
  "height" integer,
  "score" double precision NOT NULL,
  "rank" integer NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "video_moment_frame_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "video_moment_frame_assetId_frameIndex_uq" UNIQUE ("assetId", "frameIndex"),
  CONSTRAINT "video_moment_frame_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "video_moment_frame_assetId_idx" ON "video_moment_frame" ("assetId");`.execute(db);
  await sql`CREATE TRIGGER "video_moment_frame_updatedAt"
  BEFORE UPDATE ON "video_moment_frame"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  // The embedding column takes smart_search's current dimension: a library indexed with a
  // non-default search model must not get a table its embeddings cannot be written to.
  await sql`DO $$
DECLARE
  dimension integer;
BEGIN
  SELECT atttypmod INTO dimension
  FROM pg_attribute
  WHERE attrelid = 'smart_search'::regclass AND attname = 'embedding';
  IF dimension IS NULL OR dimension < 1 THEN
    dimension := 512;
  END IF;
  EXECUTE format(
    'CREATE TABLE "video_moment_frame_embedding" (
      "frameId" uuid NOT NULL,
      "embedding" vector(%s) NOT NULL,
      "modelName" character varying NOT NULL,
      CONSTRAINT "video_moment_frame_embedding_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES "video_moment_frame" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "video_moment_frame_embedding_pkey" PRIMARY KEY ("frameId")
    )',
    dimension
  );
END $$;`.execute(db);
  await sql`ALTER TABLE "video_moment_frame_embedding" ALTER COLUMN "embedding" SET STORAGE EXTERNAL;`.execute(db);

  await sql`CREATE TABLE "video_moment" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "assetId" uuid NOT NULL,
  "source" character varying NOT NULL,
  "timestampMs" integer NOT NULL,
  "endMs" integer,
  "frameId" uuid,
  "caption" text,
  "transcript" text,
  "provenance" jsonb,
  "createdById" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "video_moment_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "video_moment_frameId_fkey" FOREIGN KEY ("frameId") REFERENCES "video_moment_frame" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "video_moment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "video_moment_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "video_moment_assetId_idx" ON "video_moment" ("assetId");`.execute(db);
  await sql`CREATE INDEX "video_moment_frameId_idx" ON "video_moment" ("frameId");`.execute(db);
  await sql`CREATE INDEX "video_moment_createdById_idx" ON "video_moment" ("createdById");`.execute(db);
  await sql`CREATE INDEX "video_moment_assetId_timestampMs_idx" ON "video_moment" ("assetId", "timestampMs");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "video_moment_updatedAt"
  BEFORE UPDATE ON "video_moment"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE UNIQUE INDEX "media_operation_enrichment_plan_requestKey_uq"
  ON "media_operation" ("ownerId", ("snapshot" ->> 'requestKey'))
  WHERE "kind" = 'enrichment_plan' AND ("snapshot" ->> 'requestKey') IS NOT NULL;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "media_operation_enrichment_plan_requestKey_uq";`.execute(db);
  await sql`DROP TABLE IF EXISTS "video_moment";`.execute(db);
  await sql`DROP TABLE IF EXISTS "video_moment_frame_embedding";`.execute(db);
  await sql`DROP TABLE IF EXISTS "video_moment_frame";`.execute(db);
  await sql`DROP TABLE IF EXISTS "video_moment_index";`.execute(db);
}
