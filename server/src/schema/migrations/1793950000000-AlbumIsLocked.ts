import { Kysely, sql } from 'kysely';

/** A locked album locks its owner's items, and every item of theirs added to it later. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.album ADD COLUMN "isLocked" boolean NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.album DROP COLUMN "isLocked"`.execute(db);
}
