import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_palette" (
  "assetId" uuid NOT NULL,
  "version" integer NOT NULL,
  "sourceRevision" text NOT NULL,
  "ownerOnly" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL,
  "swatches" jsonb NOT NULL,
  "hasTransparency" boolean NOT NULL,
  "representative" text NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_palette_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_palette_pkey" PRIMARY KEY ("assetId")
);`.execute(db);
  await sql`CREATE TABLE "asset_palette_swatch" (
  "assetId" uuid NOT NULL,
  "position" integer NOT NULL,
  "l" double precision NOT NULL,
  "a" double precision NOT NULL,
  "b" double precision NOT NULL,
  "weight" double precision NOT NULL,
  CONSTRAINT "asset_palette_swatch_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_palette_swatch_pkey" PRIMARY KEY ("assetId", "position")
);`.execute(db);
  await sql`CREATE INDEX "asset_palette_swatch_color_idx" ON "asset_palette_swatch" ("l", "a", "b", "weight");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_palette_swatch, asset_palette;`.execute(db);
}
