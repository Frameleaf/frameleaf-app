import { Kysely, sql } from 'kysely';

/**
 * FL-923: photos cut out of a flatbed scan remember their scan and where they lay on it. Deleting the photo or
 * the scan removes the row only; the other stays in the library.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE asset_scan_crop (
    "assetId" uuid NOT NULL,
    "sourceAssetId" uuid NOT NULL,
    quad jsonb NOT NULL,
    rotation integer NOT NULL,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT asset_scan_crop_pkey PRIMARY KEY ("assetId"),
    CONSTRAINT "asset_scan_crop_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES asset (id) ON DELETE CASCADE,
    CONSTRAINT "asset_scan_crop_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES asset (id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX "asset_scan_crop_sourceAssetId_idx" ON asset_scan_crop ("sourceAssetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_scan_crop`.execute(db);
}
