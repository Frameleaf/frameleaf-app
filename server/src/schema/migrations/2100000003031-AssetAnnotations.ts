import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_annotation" (
  "assetId" uuid NOT NULL,
  "version" integer NOT NULL,
  "sourceRevision" text NOT NULL,
  "items" jsonb NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_annotation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_annotation_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_annotation;`.execute(db);
}
