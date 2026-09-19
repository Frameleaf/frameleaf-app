import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.icloud_connection (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL,
      label text NOT NULL CHECK (length(label) BETWEEN 1 AND 256),
      state text NOT NULL DEFAULT 'paused',
      "encryptedSession" text,
      config jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(config) = 'object'),
      "lastError" text,
      "authAttempts" integer NOT NULL DEFAULT 0 CHECK ("authAttempts" >= 0),
      "authRetryAt" timestamptz,
      "nextRunAt" timestamptz,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, "ownerId")
    )
  `.execute(db);
  await sql`
    CREATE INDEX icloud_connection_owner_idx ON immich_fork.icloud_connection ("ownerId")
  `.execute(db);
  await sql`
    CREATE INDEX icloud_connection_due_idx ON immich_fork.icloud_connection ("nextRunAt") WHERE "nextRunAt" IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_run (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "connectionId" uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      counts jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
      "startedAt" timestamptz NOT NULL DEFAULT now(),
      "finishedAt" timestamptz,
      FOREIGN KEY ("connectionId", "ownerId") REFERENCES immich_fork.icloud_connection (id, "ownerId") ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    CREATE INDEX icloud_run_connection_started_idx ON immich_fork.icloud_run ("connectionId", "startedAt" DESC)
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_checkpoint (
      "connectionId" uuid NOT NULL REFERENCES immich_fork.icloud_connection (id) ON DELETE CASCADE,
      scope text NOT NULL,
      cursor jsonb,
      "snapshotId" uuid NOT NULL,
      complete boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("connectionId", scope)
    )
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_record (
      "connectionId" uuid NOT NULL REFERENCES immich_fork.icloud_connection (id) ON DELETE CASCADE,
      "libraryKey" text NOT NULL,
      "recordId" text NOT NULL,
      "recordType" text NOT NULL,
      revision text,
      "masterId" text,
      fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
      deleted boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("connectionId", "libraryKey", "recordId")
    )
  `.execute(db);
  await sql`
    CREATE INDEX icloud_record_master_idx ON immich_fork.icloud_record ("connectionId", "libraryKey", "masterId") WHERE "masterId" IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX icloud_record_type_idx ON immich_fork.icloud_record ("connectionId", "libraryKey", "recordType", "recordId") WHERE NOT deleted
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_resource (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "connectionId" uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      "libraryKey" text NOT NULL,
      library jsonb NOT NULL CHECK (jsonb_typeof(library) = 'object'),
      "sourceAssetId" text NOT NULL,
      "recordId" text NOT NULL,
      "resourceKey" text NOT NULL,
      role text NOT NULL,
      fingerprint text NOT NULL,
      source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
      "expectedSize" bigint NOT NULL CHECK ("expectedSize" >= 0 AND "expectedSize" <= 9007199254740991),
      status text NOT NULL DEFAULT 'pending',
      sha1 bytea CHECK (octet_length(sha1) = 20),
      sha256 bytea CHECK (octet_length(sha256) = 32),
      "assetId" uuid,
      path text,
      "stagingPath" text,
      "promotedPath" text,
      "expectedTarget" jsonb,
      verification jsonb,
      "pendingJobs" jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof("pendingJobs") = 'array'),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      "nextAttemptAt" timestamptz,
      "leaseToken" uuid,
      "leaseExpiresAt" timestamptz,
      "reservedBytes" bigint NOT NULL DEFAULT 0 CHECK ("reservedBytes" >= 0 AND "reservedBytes" <= 9007199254740991),
      "lastError" text,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY ("connectionId", "ownerId") REFERENCES immich_fork.icloud_connection (id, "ownerId") ON DELETE CASCADE,
      UNIQUE ("connectionId", "libraryKey", "sourceAssetId", "resourceKey", fingerprint),
      CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
    )
  `.execute(db);
  await sql`
    CREATE INDEX icloud_resource_pending_idx ON immich_fork.icloud_resource ("connectionId", status, "nextAttemptAt", id) WHERE status IN ('pending', 'retry')
  `.execute(db);
  await sql`
    CREATE INDEX icloud_resource_lease_idx ON immich_fork.icloud_resource ("leaseExpiresAt") WHERE "leaseToken" IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX icloud_resource_asset_idx ON immich_fork.icloud_resource ("assetId") WHERE "assetId" IS NOT NULL
  `.execute(db);
  await sql`
    CREATE INDEX icloud_resource_owner_idx ON immich_fork.icloud_resource ("ownerId", status)
  `.execute(db);
  await sql`
    CREATE INDEX icloud_resource_jobs_idx ON immich_fork.icloud_resource ("connectionId", id) WHERE "pendingJobs" <> '[]'::jsonb
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_album (
      "connectionId" uuid NOT NULL REFERENCES immich_fork.icloud_connection (id) ON DELETE CASCADE,
      "libraryKey" text NOT NULL,
      "sourceId" text NOT NULL,
      "parentSourceId" text,
      name text NOT NULL,
      "albumId" uuid,
      deleted boolean NOT NULL DEFAULT false,
      source jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(source) = 'object'),
      PRIMARY KEY ("connectionId", "libraryKey", "sourceId")
    )
  `.execute(db);
  await sql`
    CREATE INDEX icloud_album_parent_idx ON immich_fork.icloud_album ("connectionId", "libraryKey", "parentSourceId")
  `.execute(db);
  await sql`
    CREATE INDEX icloud_album_mapping_idx ON immich_fork.icloud_album ("albumId") WHERE "albumId" IS NOT NULL
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_membership (
      "connectionId" uuid NOT NULL REFERENCES immich_fork.icloud_connection (id) ON DELETE CASCADE,
      "libraryKey" text NOT NULL,
      "sourceAlbumId" text NOT NULL,
      "sourceAssetId" text NOT NULL,
      "albumId" uuid,
      "assetId" uuid,
      "addedBySync" boolean NOT NULL DEFAULT false,
      "snapshotId" uuid NOT NULL,
      "sourcePresent" boolean NOT NULL DEFAULT true,
      PRIMARY KEY ("connectionId", "libraryKey", "sourceAlbumId", "sourceAssetId")
    )
  `.execute(db);
  await sql`
    CREATE INDEX icloud_membership_asset_idx ON immich_fork.icloud_membership ("connectionId", "libraryKey", "sourceAssetId")
  `.execute(db);
  await sql`
    CREATE INDEX icloud_membership_snapshot_idx ON immich_fork.icloud_membership ("connectionId", "libraryKey", "sourceAlbumId", "snapshotId") WHERE "sourcePresent"
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP TABLE immich_fork.icloud_membership
  `.execute(db);
  await sql`
    DROP TABLE immich_fork.icloud_album
  `.execute(db);
  await sql`
    DROP TABLE immich_fork.icloud_resource
  `.execute(db);
  await sql`
    DROP TABLE immich_fork.icloud_record
  `.execute(db);
  await sql`
    DROP TABLE immich_fork.icloud_checkpoint
  `.execute(db);
  await sql`
    DROP TABLE immich_fork.icloud_run
  `.execute(db);
  await sql`
    DROP TABLE immich_fork.icloud_connection
  `.execute(db);
}
