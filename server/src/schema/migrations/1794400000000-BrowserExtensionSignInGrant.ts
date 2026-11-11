import { Kysely, sql } from 'kysely';

/** FL-1427: a sign-in code remembers what Allow was pressed for; codes made before it only save into Boards. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "browser_extension_sign_in_code" ADD "accessGrant" character varying NOT NULL DEFAULT 'capture';`.execute(
    db,
  );
  await sql`ALTER TABLE "browser_extension_sign_in_code" ADD CONSTRAINT "browser_extension_sign_in_code_grant_check" CHECK ("accessGrant" IN ('capture', 'media'));`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "browser_extension_sign_in_code" DROP CONSTRAINT "browser_extension_sign_in_code_grant_check";`.execute(
    db,
  );
  await sql`ALTER TABLE "browser_extension_sign_in_code" DROP COLUMN "accessGrant";`.execute(db);
}
