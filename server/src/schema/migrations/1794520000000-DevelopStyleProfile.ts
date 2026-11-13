import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "develop_style_profile" (
    "userId" uuid NOT NULL PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "version" integer NOT NULL,
    "sampleCount" integer NOT NULL,
    "modelJson" jsonb NOT NULL,
    "trainedAt" timestamp with time zone NOT NULL
  )`.execute(db);
  await sql`ALTER TABLE "asset_develop_revision" ADD COLUMN "styleBatchId" uuid`.execute(db);
  await sql`CREATE UNIQUE INDEX "asset_develop_revision_style_batch_idx" ON "asset_develop_revision" ("ownerId", "styleBatchId", "assetId") WHERE "styleBatchId" IS NOT NULL`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_develop_revision" DROP COLUMN "styleBatchId"`.execute(db);
  await sql`DROP TABLE "develop_style_profile"`.execute(db);
}
