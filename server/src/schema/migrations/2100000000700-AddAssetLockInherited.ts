import { Kysely, sql } from 'kysely';

/**
 * FL-195 follow-up (owner decision, September 27, 2026: "yes they should unlock"): a lock a Studio
 * export result inherited from its sources is told apart from one the owner put on it directly.
 * Unlocking the last locked source releases an inherited lock; a direct lock is never released that
 * way.
 *
 * Existing rows: a lock is taken as inherited when nobody chose it (`lockedBy` is null) and its asset
 * is a published Studio export result whose recorded privacy carries that same reason. Anything else,
 * a detection on the result itself included, stays direct.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_lock" ADD "inherited" boolean NOT NULL DEFAULT false;`.execute(db);
  await sql`
    UPDATE "asset_lock"
    SET "inherited" = true
    FROM "studio_export_version" AS "version"
    WHERE "version"."resultAssetId" = "asset_lock"."assetId"
      AND "asset_lock"."lockedBy" IS NULL
      AND "version"."privacy" ->> 'lockReason' = "asset_lock"."reason"
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_lock" DROP COLUMN IF EXISTS "inherited";`.execute(db);
}
