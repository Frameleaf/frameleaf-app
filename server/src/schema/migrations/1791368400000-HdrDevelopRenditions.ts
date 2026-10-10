import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_develop_revision ADD COLUMN "hdrMasterPath" text,
    ADD COLUMN "hdrPreviewPath" text, ADD COLUMN "hdrRenditionChecksum" bytea,
    ADD CONSTRAINT asset_develop_revision_hdr_set_check CHECK (
      ("hdrMasterPath" IS NULL AND "hdrPreviewPath" IS NULL AND "hdrRenditionChecksum" IS NULL) OR
      ("hdrMasterPath" IS NOT NULL AND "hdrPreviewPath" IS NOT NULL AND "hdrRenditionChecksum" IS NOT NULL AND octet_length("hdrRenditionChecksum") = 32)
    )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.asset_develop_revision DROP CONSTRAINT asset_develop_revision_hdr_set_check,
    DROP COLUMN "hdrMasterPath", DROP COLUMN "hdrPreviewPath", DROP COLUMN "hdrRenditionChecksum"`.execute(db);
}
