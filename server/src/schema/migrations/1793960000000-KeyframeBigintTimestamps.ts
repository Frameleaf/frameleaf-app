import { Kysely, sql } from 'kysely';

/** Keyframe timestamps count time-base ticks: a long or fine-grained video passes 2^31. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_keyframe
    ALTER COLUMN "pts" TYPE bigint[],
    ALTER COLUMN "accDuration" TYPE bigint[],
    ALTER COLUMN "totalDuration" TYPE bigint`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_keyframe
    ALTER COLUMN "pts" TYPE integer[],
    ALTER COLUMN "accDuration" TYPE integer[],
    ALTER COLUMN "totalDuration" TYPE integer`.execute(db);
}
