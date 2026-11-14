import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE oauth_authorization_code ADD COLUMN "accessPolicy" jsonb`.execute(db);
  await sql`ALTER TABLE oauth_grant ADD COLUMN "accessPolicy" jsonb,
    ADD COLUMN "policyRevision" integer NOT NULL DEFAULT 0`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE oauth_grant DROP COLUMN "policyRevision", DROP COLUMN "accessPolicy"`.execute(db);
  await sql`ALTER TABLE oauth_authorization_code DROP COLUMN "accessPolicy"`.execute(db);
}
