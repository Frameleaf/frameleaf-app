import { Kysely, sql } from 'kysely';

// FL-926: UnifiedPush delivery. A device may register a UnifiedPush endpoint and its Web Push keys;
// an Android device that only uses UnifiedPush has no FCM token.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "push_device" ALTER COLUMN "pushToken" DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE "push_device" ADD COLUMN "unifiedPushEndpoint" text`.execute(db);
  await sql`ALTER TABLE "push_device" ADD COLUMN "unifiedPushPublicKey" text`.execute(db);
  await sql`ALTER TABLE "push_device" ADD COLUMN "unifiedPushAuth" text`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "push_device" WHERE "pushToken" IS NULL`.execute(db);
  await sql`ALTER TABLE "push_device" DROP COLUMN "unifiedPushAuth"`.execute(db);
  await sql`ALTER TABLE "push_device" DROP COLUMN "unifiedPushPublicKey"`.execute(db);
  await sql`ALTER TABLE "push_device" DROP COLUMN "unifiedPushEndpoint"`.execute(db);
  await sql`ALTER TABLE "push_device" ALTER COLUMN "pushToken" SET NOT NULL`.execute(db);
}
