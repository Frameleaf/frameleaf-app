import { Kysely, sql } from 'kysely';

/** Actual identity-adoption decisions only; never backfill from a hash-reuse/import identity. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.icloud_identity_reuse (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "ownerId" uuid NOT NULL, "connectionId" uuid NOT NULL,
    "sourceResourceId" uuid NOT NULL UNIQUE, "identityId" uuid NOT NULL, "assetId" uuid NOT NULL,
    "operationId" uuid NOT NULL, "itemClaimId" uuid NOT NULL,
    basis text NOT NULL CHECK (basis='exact-identity'),
    "libraryKey" text NOT NULL, "cplAssetRecordName" text NOT NULL, "cplMasterRecordName" text NOT NULL,
    role text NOT NULL CHECK (role IN ('original','live-motion','raw-alternate')),
    "editVersion" text NOT NULL DEFAULT '' CHECK ("editVersion"=''),
    "expectedSha256" bytea NOT NULL CHECK (octet_length("expectedSha256")=32),
    "appleFingerprint" text NOT NULL CHECK ("appleFingerprint" ~ '^[A-Za-z0-9+/]{28}$'
      AND get_byte(decode("appleFingerprint",'base64'),0)=1),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'
      AND snapshot ?& ARRAY['config','resourceKey','fingerprint','sourceRevision','masterRevision','originalPath',
        'updateId','checksum','algorithm','physicalId','forkPhysicalId','fileIdentity','sourceChecksum']
      AND jsonb_typeof(snapshot->'fileIdentity')='object'
      AND snapshot->'fileIdentity' ?& ARRAY['dev','ino','size','mtimeMs','ctimeMs']
      AND jsonb_typeof(snapshot->'fileIdentity'->'dev')='number'
      AND jsonb_typeof(snapshot->'fileIdentity'->'ino')='number'
      AND jsonb_typeof(snapshot->'fileIdentity'->'size')='number'
      AND jsonb_typeof(snapshot->'fileIdentity'->'mtimeMs')='number'
      AND jsonb_typeof(snapshot->'fileIdentity'->'ctimeMs')='number'),
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY ("connectionId","ownerId") REFERENCES immich_fork.icloud_connection(id,"ownerId") ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX icloud_identity_reuse_owner_connection_idx
    ON immich_fork.icloud_identity_reuse("ownerId","connectionId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const { rows } = await sql`SELECT 1 FROM immich_fork.icloud_identity_reuse LIMIT 1`.execute(db);
  if (rows.length > 0) {
    throw new Error('icloud_identity_reuse_receipts_require_retention');
  }
  await sql`DROP TABLE immich_fork.icloud_identity_reuse`.execute(db);
}
