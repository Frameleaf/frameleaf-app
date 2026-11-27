import { Kysely, sql } from 'kysely';

/**
 * FL-1814: a Date & Time Doctor fix can date photos to a month or "around" a year (`asset.dateDetail`), so each
 * item keeps the detail the photo had before and after; undo puts the first back while the photo still has the
 * second. New nullable columns only: existing items read as having had none, which is what every fix wrote.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "date_fix_item" ADD "previousDateDetail" text, ADD "newDateDetail" text`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "date_fix_item" DROP COLUMN "previousDateDetail", DROP COLUMN "newDateDetail"`.execute(db);
}
