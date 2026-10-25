import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql.raw('ALTER TABLE "asset_edit" ADD "sourceReference" jsonb;').execute(db);
  await sql.raw('ALTER TABLE "video_edit_version" ADD "sourceReference" jsonb;').execute(db);
  // Historical reference recipes have no proven input; do not bind them to today's bytes.
  await sql`UPDATE asset_edit e SET "sourceReference"='{"kind":"unbound-reference"}'::jsonb
    FROM asset a WHERE a.id=e."assetId" AND a.type='IMAGE' AND a."originalPath" ILIKE 'frameleaf-source:%'`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE asset_edit, video_edit_version IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ retained: boolean }>`SELECT
    EXISTS (SELECT 1 FROM asset_edit WHERE "sourceReference" IS NOT NULL) OR
    EXISTS (SELECT 1 FROM video_edit_version WHERE "sourceReference" IS NOT NULL) AS retained`.execute(db);
  if (rows[0].retained) throw new Error('Cannot discard saved edit source references');
  await sql.raw('ALTER TABLE "asset_edit" DROP COLUMN "sourceReference";').execute(db);
  await sql.raw('ALTER TABLE "video_edit_version" DROP COLUMN "sourceReference";').execute(db);
}
