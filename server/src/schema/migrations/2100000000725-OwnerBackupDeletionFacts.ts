import { Kysely, sql } from 'kysely';
// Native migration loading needs a relative source import; TypeScript rewrites .ts to .js for production.
// eslint-disable-next-line no-restricted-imports
import { BACKUP_DELETION_CAPTURE_BODY } from '../../utils/cloud-backup-deletion-sql.ts';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE asset_backup_deletion (
    "assetId" uuid PRIMARY KEY, "ownerId" uuid NOT NULL, "deletedAt" timestamptz NOT NULL,
    visibility text NOT NULL, "wasLocked" boolean NOT NULL, checksum bytea, "checksumAlgorithm" text,
    "livePhotoVideoId" uuid, "evidenceVersion" integer NOT NULL, "modernPrivacyEvidenceUnavailable" boolean NOT NULL
  );`.execute(db);
  await sql`CREATE INDEX "asset_backup_deletion_ownerId_idx" ON asset_backup_deletion("ownerId");`.execute(db);
  await sql`CREATE INDEX "asset_backup_deletion_livePhotoVideoId_idx" ON asset_backup_deletion("livePhotoVideoId");`.execute(
    db,
  );
  await sql
    .raw(
      `CREATE FUNCTION asset_backup_deletion_capture() RETURNS trigger LANGUAGE plpgsql AS $capture$${BACKUP_DELETION_CAPTURE_BODY}$capture$;`,
    )
    .execute(db);
  await sql`CREATE TRIGGER asset_backup_deletion_capture_trigger BEFORE DELETE ON asset FOR EACH ROW EXECUTE FUNCTION asset_backup_deletion_capture();`.execute(
    db,
  );
  await db.insertInto('migration_overrides').values([
    { name: 'function_asset_backup_deletion_capture', value: { type: 'function', name: 'asset_backup_deletion_capture',
      sql: `CREATE OR REPLACE FUNCTION asset_backup_deletion_capture()
  RETURNS trigger
  LANGUAGE PLPGSQL
  AS $$
    ${BACKUP_DELETION_CAPTURE_BODY.trim()}
  $$;` } },
    { name: 'trigger_asset_backup_deletion_capture_trigger', value: { type: 'trigger', name: 'asset_backup_deletion_capture_trigger',
      sql: 'CREATE OR REPLACE TRIGGER "asset_backup_deletion_capture_trigger"\n  BEFORE DELETE ON "asset"\n  FOR EACH ROW\n  EXECUTE FUNCTION asset_backup_deletion_capture();' } },
  ]).execute();
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('migration_overrides').where('name', 'in', ['function_asset_backup_deletion_capture', 'trigger_asset_backup_deletion_capture_trigger']).execute();
  await sql`DROP TRIGGER asset_backup_deletion_capture_trigger ON asset; DROP FUNCTION asset_backup_deletion_capture(); DROP TABLE asset_backup_deletion;`.execute(
    db,
  );
}
