import { Kysely, sql } from 'kysely';

/** FL-912: the Date & Time Doctor's findings, and the two EXIF offsets it compares. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_exif" ADD "offsetTimeOriginal" text, ADD "offsetTime" text;`.execute(db);
  await sql`CREATE TABLE "asset_date_finding" (
  "assetId" uuid NOT NULL,
  "cause" text NOT NULL,
  "currentDate" timestamp with time zone NOT NULL,
  "currentZone" text,
  "proposedDate" timestamp with time zone,
  "proposedZone" text,
  "confidence" real NOT NULL,
  "groupKey" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "dismissedAt" timestamp with time zone,
  CONSTRAINT "asset_date_finding_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_date_finding_pkey" PRIMARY KEY ("assetId", "cause")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_date_finding";`.execute(db);
  await sql`ALTER TABLE "asset_exif" DROP COLUMN "offsetTimeOriginal", DROP COLUMN "offsetTime";`.execute(db);
}
