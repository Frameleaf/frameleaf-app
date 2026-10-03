import { Kysely, sql } from 'kysely';

/** FL-296: independent fresh-source audits; never reopen a finalized ordinary transfer. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.icloud_identity_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ownerId" uuid NOT NULL, "connectionId" uuid NOT NULL, "sessionId" uuid NOT NULL,
    "operationId" uuid, "identityId" uuid NOT NULL, "originalAssetId" uuid NOT NULL,
    "sourceResourceId" uuid NOT NULL, "expectedSha256" bytea NOT NULL CHECK (octet_length("expectedSha256")=32),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
    "itemClaimId" uuid, result text NOT NULL DEFAULT 'queued'
      CHECK (result IN ('queued','running','match','mismatch','stale','cancelled','failed')),
    "resultAssetId" uuid, "verifiedAt" timestamptz, "lastError" text,
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY ("connectionId","ownerId") REFERENCES immich_fork.icloud_connection(id,"ownerId") ON DELETE CASCADE
  )`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_resource ADD COLUMN "auditRequestId" uuid
    REFERENCES immich_fork.icloud_identity_audit(id)`.execute(db);
  const { rows } = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
    WHERE conrelid='immich_fork.icloud_resource'::regclass AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE ("connectionId", "libraryKey", "sourceAssetId", "resourceKey", fingerprint)'`.execute(db);
  if (rows.length !== 1) { throw new Error('icloud_resource_identity_constraint_missing'); }
  await sql`ALTER TABLE immich_fork.icloud_resource DROP CONSTRAINT ${sql.id(rows[0].name)}`.execute(db);
  await sql`CREATE UNIQUE INDEX icloud_resource_ordinary_identity_key ON immich_fork.icloud_resource
    ("connectionId","libraryKey","sourceAssetId","resourceKey",fingerprint) WHERE "auditRequestId" IS NULL`.execute(db);
  await sql`CREATE UNIQUE INDEX icloud_resource_audit_request_key ON immich_fork.icloud_resource("auditRequestId")
    WHERE "auditRequestId" IS NOT NULL`.execute(db);
  await sql`CREATE INDEX icloud_identity_audit_operation_idx ON immich_fork.icloud_identity_audit("operationId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const { rows } = await sql`SELECT 1 FROM immich_fork.icloud_identity_audit LIMIT 1`.execute(db);
  if (rows.length > 0) { throw new Error('icloud_audit_receipts_require_retention'); }
  await sql`DROP INDEX immich_fork.icloud_resource_audit_request_key`.execute(db);
  await sql`DROP INDEX immich_fork.icloud_resource_ordinary_identity_key`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_resource DROP COLUMN "auditRequestId",
    ADD UNIQUE ("connectionId","libraryKey","sourceAssetId","resourceKey",fingerprint)`.execute(db);
  await sql`DROP TABLE immich_fork.icloud_identity_audit`.execute(db);
}
