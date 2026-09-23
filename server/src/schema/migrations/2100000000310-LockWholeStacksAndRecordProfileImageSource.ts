import { Kysely, sql } from 'kysely';
import { up as repairLockedCoverReferences } from 'src/schema/migrations/2100000000300-ClearLockedCoverReferences.js';

/**
 * Owner decisions, September 22, 2026 (FL-53).
 *
 * 1. A profile picture copied from a photo records that photo (`user.profileImageAssetId`), so the
 *    picture can be replaced when the photo becomes Locked. Pictures saved before this recorded
 *    nothing and stay as they are.
 * 2. A stack is Locked as a whole: when any photo of a stack is Locked, every photo of it is. Stacks
 *    saved half Locked before the fix are Locked as a whole here, and every cover, featured photo and
 *    face thumbnail those photos were is then repaired as migration 2100000000300 repairs them.
 *
 * The Locked state used here is the Locked folder (`asset.visibility = 'locked'`), the only lock that
 * exists at this point. FL-34 moves the Locked state into a fork lock record; this repair is to be
 * revised with it so it reads and writes that record instead.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "user" ADD COLUMN "profileImageAssetId" uuid;`.execute(db);
  await sql`ALTER TABLE "user" ADD CONSTRAINT "user_profileImageAssetId_fkey" FOREIGN KEY ("profileImageAssetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(
    db,
  );
  await sql`CREATE INDEX "user_profileImageAssetId_idx" ON "user" ("profileImageAssetId");`.execute(db);

  const { numAffectedRows } = await sql`
    UPDATE "asset"
    SET "visibility" = 'locked'
    WHERE "stackId" IN (SELECT "stackId" FROM "asset" WHERE "visibility" = 'locked' AND "stackId" IS NOT NULL)
      AND "visibility" != 'locked'
  `.execute(db);

  if (Number(numAffectedRows ?? 0n) > 0) {
    await repairLockedCoverReferences(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // The stacks stay Locked as a whole: which of their photos were Locked before is not recorded, and
  // unlocking any of them would show photos their owner put away.
  await sql`DROP INDEX IF EXISTS "user_profileImageAssetId_idx";`.execute(db);
  await sql`ALTER TABLE "user" DROP CONSTRAINT IF EXISTS "user_profileImageAssetId_fkey";`.execute(db);
  await sql`ALTER TABLE "user" DROP COLUMN IF EXISTS "profileImageAssetId";`.execute(db);
}
