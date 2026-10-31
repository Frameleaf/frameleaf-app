import { Kysely, sql } from 'kysely';

// FL-653: a source address brought over by an Eagle import is marked as imported, so Boards says it
// came from Eagle rather than the browser extension. Null for every source the extension saved.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_source" ADD "importedFrom" character varying;`.execute(db);
  await sql`ALTER TABLE "asset_source" ADD CONSTRAINT "asset_source_importedFrom_check" CHECK ("importedFrom" IN ('eagle'));`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_source" DROP CONSTRAINT "asset_source_importedFrom_check";`.execute(db);
  await sql`ALTER TABLE "asset_source" DROP COLUMN "importedFrom";`.execute(db);
}
