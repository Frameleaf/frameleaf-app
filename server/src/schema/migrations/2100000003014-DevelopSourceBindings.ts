import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw('ALTER TABLE "asset_develop_revision" ADD "renderAttemptId" uuid;').execute(db);
  await sql.raw('ALTER TABLE "asset_develop_revision" ADD "sourceBinding" jsonb;').execute(db);
  await sql.raw('ALTER TABLE "asset_develop_revision" ADD "renderGenerationId" uuid;').execute(db);
  // Today's resource metadata cannot prove which original a historical recipe selected.
  await sql`UPDATE asset_develop_revision revision SET "sourceBinding"='{"kind":"unbound-reference"}'::jsonb
    WHERE EXISTS (SELECT 1 FROM asset a WHERE a.id IN (revision."assetId", revision."sourceAssetId")
      AND a."originalPath" ILIKE 'frameleaf-source:%')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE asset_develop_revision IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ retained: boolean }>`SELECT EXISTS (
    SELECT 1 FROM asset_develop_revision WHERE "sourceBinding" IS NOT NULL
      OR "renderAttemptId" IS NOT NULL OR "renderGenerationId" IS NOT NULL
  ) AS retained`.execute(db);
  if (rows[0].retained) throw new Error('Cannot discard retained develop source bindings');
  await sql.raw('ALTER TABLE "asset_develop_revision" DROP COLUMN "renderAttemptId";').execute(db);
  await sql.raw('ALTER TABLE "asset_develop_revision" DROP COLUMN "sourceBinding";').execute(db);
  await sql.raw('ALTER TABLE "asset_develop_revision" DROP COLUMN "renderGenerationId";').execute(db);
}
