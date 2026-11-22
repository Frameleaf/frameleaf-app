import { Kysely, sql } from 'kysely';

/**
 * FL-936: a photo can be dated to a year or a decade. Its capture date stays an ordinary date, the start of that
 * period, and `dateAccuracy` says how much of it is known (null: all of it). A Date & Time Doctor batch records the
 * accuracy with the date, so undoing it puts both back.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD "dateAccuracy" text`.execute(db);
  await sql`ALTER TABLE "asset" ADD CONSTRAINT "asset_dateAccuracy_check" CHECK ("dateAccuracy" = ANY (ARRAY['year'::text, 'decade'::text]))`.execute(
    db,
  );
  await sql`ALTER TABLE "date_fix_batch" ADD "dateAccuracy" text, ADD "periodStart" integer`.execute(db);
  await sql`ALTER TABLE "date_fix_item" ADD "previousDateAccuracy" text, ADD "newDateAccuracy" text`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "date_fix_item" DROP COLUMN "previousDateAccuracy", DROP COLUMN "newDateAccuracy"`.execute(db);
  await sql`ALTER TABLE "date_fix_batch" DROP COLUMN "dateAccuracy", DROP COLUMN "periodStart"`.execute(db);
  await sql`ALTER TABLE "asset" DROP CONSTRAINT "asset_dateAccuracy_check"`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "dateAccuracy"`.execute(db);
}
