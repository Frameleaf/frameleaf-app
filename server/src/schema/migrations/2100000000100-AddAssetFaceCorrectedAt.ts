import { Kysely, sql } from 'kysely';

/**
 * Frameleaf FL-57: durable marker for a manual face correction (reassign, merge, split),
 * distinct from the replaceable machine-learning embedding and detection state that
 * `sourceType` already tracks. Set by `PersonRepository.reassignFace`/`reassignFaces`
 * whenever a human moves a face between people; the facial-recognition job never writes
 * it, so reprocessing cannot erase a manual correction. Backs the person detail
 * "correction history" view (`GET /people/:id/corrections`).
 *
 * Naming: `2100xxxxxxxxx-` prefix is the fork-only timestamp convention (see
 * `2100000000010-AddAssetIsNsfwIndex.ts`) to keep fork migrations from colliding with
 * upstream's incrementing timestamps.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_face" ADD COLUMN IF NOT EXISTS "correctedAt" timestamp with time zone DEFAULT NULL;`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS "asset_face_correctedAt_idx" ON "asset_face" ("correctedAt");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "asset_face_correctedAt_idx";`.execute(db);
  await sql`ALTER TABLE "asset_face" DROP COLUMN IF EXISTS "correctedAt";`.execute(db);
}
