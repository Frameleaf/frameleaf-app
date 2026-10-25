import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE source_resource_read ADD COLUMN "backupOperationId" uuid,
    ADD COLUMN "backupClaimTokenHash" bytea,
    ADD CONSTRAINT source_resource_read_backup_check CHECK (
      ("backupOperationId" IS NULL AND "backupClaimTokenHash" IS NULL) OR
      ("backupOperationId" IS NOT NULL AND "backupClaimTokenHash" IS NOT NULL AND octet_length("backupClaimTokenHash")=32)
    )`.execute(db);
  await sql`DROP INDEX source_resource_read_active_uq`.execute(db);
  await sql`CREATE UNIQUE INDEX source_resource_read_active_uq ON source_resource_read
    ("assetId", "resourceId", "scopeFingerprint", "authorizationEpoch")
    WHERE state IN ('pending', 'claimed', 'delivering') AND "backupOperationId" IS NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX source_resource_read_backup_active_uq ON source_resource_read
    ("assetId", "resourceId", "scopeFingerprint", "authorizationEpoch", "backupOperationId", "backupClaimTokenHash")
    WHERE state IN ('pending', 'claimed', 'delivering') AND "backupOperationId" IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`LOCK TABLE source_resource_read IN ACCESS EXCLUSIVE MODE`.execute(db);
  const { rows } = await sql<{ retained: boolean }>`SELECT EXISTS (
    SELECT 1 FROM source_resource_read WHERE "backupOperationId" IS NOT NULL
  ) AS retained`.execute(db);
  if (rows[0].retained) throw new Error('Cannot discard source backup read authority');
  await sql`DROP INDEX source_resource_read_backup_active_uq`.execute(db);
  await sql`DROP INDEX source_resource_read_active_uq`.execute(db);
  await sql`CREATE UNIQUE INDEX source_resource_read_active_uq ON source_resource_read
    ("assetId", "resourceId", "scopeFingerprint", "authorizationEpoch")
    WHERE state IN ('pending', 'claimed', 'delivering')`.execute(db);
  await sql`ALTER TABLE source_resource_read DROP CONSTRAINT source_resource_read_backup_check,
    DROP COLUMN "backupClaimTokenHash", DROP COLUMN "backupOperationId"`.execute(db);
}
