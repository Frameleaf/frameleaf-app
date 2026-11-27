import { Kysely, sql } from 'kysely';

/**
 * FL-1814: the date field's "How sure are you?". A photo's `year` date can say a month (`month`, the date is the 1st
 * of it) or that the year is a guess (`about`); a person's dates of birth and passing get the same choices, with
 * `year`. New nullable columns only: existing rows keep meaning what they meant, and a client that never reads the
 * new columns reads every date as before.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset" ADD "dateDetail" text`.execute(db);
  await sql`ALTER TABLE "asset" ADD CONSTRAINT "asset_dateDetail_check" CHECK ("dateDetail" = ANY (ARRAY['month'::text, 'about'::text]))`.execute(
    db,
  );
  await sql`ALTER TABLE "person_profile" ADD "birthDatePrecision" text, ADD "deathDatePrecision" text`.execute(db);
  await sql`ALTER TABLE "person_profile" ADD CONSTRAINT "person_profile_birthDatePrecision_check" CHECK ("birthDatePrecision" = ANY (ARRAY['month'::text, 'year'::text, 'about'::text]))`.execute(
    db,
  );
  await sql`ALTER TABLE "person_profile" ADD CONSTRAINT "person_profile_deathDatePrecision_check" CHECK ("deathDatePrecision" = ANY (ARRAY['month'::text, 'year'::text, 'about'::text]))`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "person_profile" DROP CONSTRAINT "person_profile_deathDatePrecision_check"`.execute(db);
  await sql`ALTER TABLE "person_profile" DROP CONSTRAINT "person_profile_birthDatePrecision_check"`.execute(db);
  await sql`ALTER TABLE "person_profile" DROP COLUMN "birthDatePrecision", DROP COLUMN "deathDatePrecision"`.execute(db);
  await sql`ALTER TABLE "asset" DROP CONSTRAINT "asset_dateDetail_check"`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "dateDetail"`.execute(db);
}
