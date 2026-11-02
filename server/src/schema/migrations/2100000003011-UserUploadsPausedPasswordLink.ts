import { Kysely, sql } from 'kysely';

/**
 * FL-538: an administrator can pause new uploads for one person, and can email someone a single-use
 * link to choose their own password. Only the link's SHA-256 is stored, with when it stops working.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "user" ADD COLUMN "uploadsPaused" boolean NOT NULL DEFAULT false`.execute(db);
  await sql`ALTER TABLE "user" ADD COLUMN "passwordLinkHash" bytea`.execute(db);
  await sql`ALTER TABLE "user" ADD COLUMN "passwordLinkExpiresAt" timestamp with time zone`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "user" DROP COLUMN "passwordLinkExpiresAt"`.execute(db);
  await sql`ALTER TABLE "user" DROP COLUMN "passwordLinkHash"`.execute(db);
  await sql`ALTER TABLE "user" DROP COLUMN "uploadsPaused"`.execute(db);
}
