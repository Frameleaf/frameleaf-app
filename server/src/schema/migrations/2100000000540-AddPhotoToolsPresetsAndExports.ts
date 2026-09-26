import { Kysely, sql } from 'kysely';

/**
 * Selective photo tools and external RAW round trips (FL-64, `REC-106`).
 *
 * `develop_preset` holds each account's reusable develop presets: a name and the settings they
 * apply. `develop_export` records every original handed out for development in another
 * application together with the SHA-256 of its bytes at that moment, so a developed file brought
 * back is accepted only against the unchanged original it was made from. The versions themselves
 * (recipes and imported files) live in `immich_fork.asset_develop_revision`.
 *
 * Constraint and index names follow the generator's conventions so `migrations:generate` produces
 * no drift against `src/schema/tables/photo-tools.table.ts`. No `updated_at` trigger: the queries
 * that change a preset write `updatedAt` themselves.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "develop_preset" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "name" character varying NOT NULL,
  "settings" jsonb NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "develop_preset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "develop_preset_ownerId_name_uq" UNIQUE ("ownerId", "name"),
  CONSTRAINT "develop_preset_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "develop_preset_ownerId_idx" ON "develop_preset" ("ownerId");`.execute(db);

  await sql`CREATE TABLE "develop_export" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "ownerId" uuid NOT NULL,
  "sourceChecksum" bytea NOT NULL,
  "fileName" character varying NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "develop_export_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "develop_export_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "develop_export_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "develop_export_assetId_idx" ON "develop_export" ("assetId");`.execute(db);
  await sql`CREATE INDEX "develop_export_ownerId_idx" ON "develop_export" ("ownerId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "develop_export";`.execute(db);
  await sql`DROP TABLE "develop_preset";`.execute(db);
}
