import { Kysely, sql } from 'kysely';

/**
 * FL-1469: Tidy up. A classification rule that Library care made for one kind of clutter (memes, receipts,
 * screenshots, …) says which kind in `careKind`; rules people write themselves leave it empty. One rule per
 * kind per person. NULLs are distinct, so any number of ordinary rules still fit.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "classification_rule" ADD COLUMN IF NOT EXISTS "careKind" character varying`.execute(db);
  await sql`ALTER TABLE "classification_rule" ADD CONSTRAINT "classification_rule_ownerId_careKind_uq" UNIQUE ("ownerId", "careKind")`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "classification_rule" DROP CONSTRAINT IF EXISTS "classification_rule_ownerId_careKind_uq"`.execute(
    db,
  );
  await sql`ALTER TABLE "classification_rule" DROP COLUMN IF EXISTS "careKind"`.execute(db);
}
