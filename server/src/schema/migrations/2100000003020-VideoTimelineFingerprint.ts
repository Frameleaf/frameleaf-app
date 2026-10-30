import { Kysely, sql } from 'kysely';

// FL-651: video look-alikes are confirmed from filmstrip timeline hashes; the four CLIP frames per
// video are no longer made or read. Their JPEGs are removed by the fingerprint job.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_video_fingerprint" (
  "assetId" uuid NOT NULL,
  "durationMs" integer NOT NULL,
  "hashes" bigint[] NOT NULL,
  CONSTRAINT "asset_video_fingerprint_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_video_fingerprint_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`DROP TABLE "asset_video_duplicate_frame";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  // The frames come back empty; the next video duplicate run would have to make them again.
  await sql`CREATE TABLE "asset_video_duplicate_frame" (
  "assetId" uuid NOT NULL,
  "frameIndex" integer NOT NULL,
  "timestampMs" integer NOT NULL,
  "path" character varying NOT NULL,
  "embedding" vector(512) NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "producerModelKey" character varying,
  "producerAdmissionKey" text NOT NULL DEFAULT 'legacy',
  CONSTRAINT "asset_video_duplicate_frame_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_video_duplicate_frame_producerAdmissionKey_fkey" FOREIGN KEY ("producerAdmissionKey") REFERENCES "desktop_clip_producer" ("key") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "asset_video_duplicate_frame_producer_key_check" CHECK ("producerModelKey" IS NULL OR "producerModelKey" ~ '^clip:[a-f0-9]{64}$'),
  CONSTRAINT "asset_video_duplicate_frame_pkey" PRIMARY KEY ("assetId", "frameIndex")
);`.execute(db);
  await sql`ALTER TABLE "asset_video_duplicate_frame" ALTER COLUMN "embedding" SET STORAGE EXTERNAL;`.execute(db);
  await sql`CREATE INDEX "asset_video_duplicate_frame_assetId_idx" ON "asset_video_duplicate_frame" ("assetId");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "asset_video_duplicate_frame_updatedAt" BEFORE UPDATE ON "asset_video_duplicate_frame" FOR EACH ROW EXECUTE FUNCTION media_health_updated_at();`.execute(
    db,
  );
  await sql`CREATE TRIGGER "asset_video_duplicate_frame_producer_guard" BEFORE INSERT OR UPDATE ON "asset_video_duplicate_frame" FOR EACH ROW EXECUTE FUNCTION desktop_clip_producer_guard();`.execute(
    db,
  );
  await sql`DROP TABLE "asset_video_fingerprint";`.execute(db);
}
