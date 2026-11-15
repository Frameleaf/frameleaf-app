import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "stack" ADD "isAutomatic" boolean NOT NULL DEFAULT false, ADD "autoVersion" smallint DEFAULT NULL`.execute(
    db,
  );
  await sql`CREATE TABLE "auto_stack_exclusion" (
    "assetId" uuid NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "auto_stack_exclusion_pkey" PRIMARY KEY ("assetId"),
    CONSTRAINT "auto_stack_exclusion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE
  )`.execute(db);
  // FL-953: automatic stacking starts on for new accounts; an account from before it starts off, until its owner
  // turns it on
  await sql`INSERT INTO "user_metadata" ("userId", "key", "value")
    SELECT "id", 'preferences', '{"autoStack":{"enabled":false}}'::jsonb FROM "user"
    ON CONFLICT ("userId", "key") DO UPDATE SET "value" = "user_metadata"."value" || '{"autoStack":{"enabled":false}}'::jsonb`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "auto_stack_exclusion"`.execute(db);
  await sql`ALTER TABLE "stack" DROP COLUMN "isAutomatic", DROP COLUMN "autoVersion"`.execute(db);
  await sql`UPDATE "user_metadata" SET "value" = "value" - 'autoStack' WHERE "key" = 'preferences'`.execute(db);
}
