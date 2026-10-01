import { Kysely, sql } from 'kysely';

/**
 * FL-302: which APNs environment an iOS device's tokens belong to. Development builds get sandbox
 * tokens, which the push gateway must send through APNs sandbox (`apns-sandbox`); null is production.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE push_device ADD "apnsEnvironment" text;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE push_device DROP COLUMN "apnsEnvironment";`.execute(db);
}
