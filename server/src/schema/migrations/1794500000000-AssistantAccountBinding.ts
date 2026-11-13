import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "oauth_authorization_code" ADD COLUMN "frameleafAccountId" character varying`.execute(db);
  await sql`ALTER TABLE "oauth_grant" ADD COLUMN "frameleafAccountId" character varying`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "oauth_grant" DROP COLUMN "frameleafAccountId"`.execute(db);
  await sql`ALTER TABLE "oauth_authorization_code" DROP COLUMN "frameleafAccountId"`.execute(db);
}
