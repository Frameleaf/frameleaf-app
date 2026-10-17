import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Lineage survives source deletion; historical revisions cannot safely infer their motion source.
  await sql`ALTER TABLE public.asset_develop_revision ADD COLUMN "sourceAssetId" uuid`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_develop_revision DROP COLUMN "sourceAssetId"`.execute(db);
}
