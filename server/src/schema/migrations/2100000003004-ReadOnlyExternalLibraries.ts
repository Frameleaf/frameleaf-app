import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "library" ADD COLUMN "readOnly" boolean NOT NULL DEFAULT false`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE "library" IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ protectedLibrary: boolean }>`
    SELECT EXISTS (SELECT 1 FROM "library" WHERE "readOnly") AS "protectedLibrary"
  `.execute(db);
  if (rows[0].protectedLibrary) throw new Error('Cannot discard read-only library protection');
  await sql`ALTER TABLE "library" DROP COLUMN "readOnly"`.execute(db);
}
