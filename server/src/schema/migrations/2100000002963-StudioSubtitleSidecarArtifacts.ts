import { Kysely, sql } from 'kysely';

/** Reserved additive sibling identity. Historical exports remain NULL; no caption backfill. */
export async function up(db: Kysely<any>): Promise<void> {
  for (const table of ['media_operation_checkpoint', 'studio_export_version']) {
    await sql`ALTER TABLE ${sql.table(table)}
      ADD COLUMN "subtitlePath" character varying,
      ADD COLUMN "subtitleChecksum" bytea,
      ADD COLUMN "subtitleSizeInBytes" bigint,
      ADD CONSTRAINT ${sql.ref(`${table}_subtitle_identity_check`)} CHECK (
        ("subtitlePath" IS NULL AND "subtitleChecksum" IS NULL AND "subtitleSizeInBytes" IS NULL) OR
        ("subtitlePath" IS NOT NULL AND "subtitleChecksum" IS NOT NULL AND "subtitleSizeInBytes" IS NOT NULL
          AND octet_length("subtitleChecksum")=32 AND "subtitleSizeInBytes">=0))`.execute(db);
  }
  await sql`ALTER TABLE public.studio_export_version ADD COLUMN "subtitleRemovedAt" timestamptz`.execute(db);
  await sql`ALTER TABLE public.studio_export_version_source ADD COLUMN "sourceEpoch" bigint,
    ADD CONSTRAINT studio_export_version_source_epoch_check CHECK ("sourceEpoch" IS NULL OR "sourceEpoch">=0)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE public.studio_export_version_source DROP CONSTRAINT studio_export_version_source_epoch_check,
    DROP COLUMN "sourceEpoch"`.execute(db);
  await sql`ALTER TABLE public.studio_export_version DROP COLUMN "subtitleRemovedAt"`.execute(db);
  for (const table of ['studio_export_version', 'media_operation_checkpoint']) {
    await sql`ALTER TABLE ${sql.table(table)} DROP CONSTRAINT ${sql.ref(`${table}_subtitle_identity_check`)},
      DROP COLUMN "subtitlePath", DROP COLUMN "subtitleChecksum", DROP COLUMN "subtitleSizeInBytes"`.execute(db);
  }
}
