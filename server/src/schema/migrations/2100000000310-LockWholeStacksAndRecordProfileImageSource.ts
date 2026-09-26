import { Kysely, sql } from 'kysely';

/**
 * Owner decisions, September 22, 2026 (FL-53).
 *
 * 1. A profile picture copied from a photo records that photo (`user.profileImageAssetId`), so the
 *    picture can be replaced when the photo becomes Locked. Pictures saved before this recorded
 *    nothing and stay as they are.
 * 2. A stack is Locked as a whole: when any photo of a stack is Locked, every photo of it is.
 *
 * Revised with FL-34: Locked is a lock record (`asset_lock`), which migration 2100000000320-AddAssetLock
 * creates. That migration locks half-Locked stacks as a whole on the lock records, after it has moved
 * the upstream Locked folder and the sensitive marks into them, and then repairs the covers, featured
 * photos and face thumbnails those photos held exactly as 2100000000300 does. This migration therefore
 * no longer writes `visibility = locked`; on a fresh upgrade from Immich the combined result is the
 * same, and nothing is written into the upstream Locked folder that 320 would have to move again.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "user" ADD COLUMN "profileImageAssetId" uuid;`.execute(db);
  await sql`ALTER TABLE "user" ADD CONSTRAINT "user_profileImageAssetId_fkey" FOREIGN KEY ("profileImageAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );
  await sql`CREATE INDEX "user_profileImageAssetId_idx" ON "user" ("profileImageAssetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "user_profileImageAssetId_idx";`.execute(db);
  await sql`ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_profileImageAssetId_fkey";`.execute(db);
  await sql`ALTER TABLE "user" DROP COLUMN IF EXISTS "profileImageAssetId";`.execute(db);
}
