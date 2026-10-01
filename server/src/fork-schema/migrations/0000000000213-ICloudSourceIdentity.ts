import { Kysely, sql } from 'kysely';

/**
 * iCloud source identity and claims (FL-296, NAPI-014), shared by iCloud Photos Sync and the native
 * app so the two paths that bring one iCloud photo to the server know about each other.
 *
 * - `icloud_source_identity`: which Apple item (CPLAsset and CPLMaster record names, library zone)
 *   and resource role a Frameleaf asset holds, its SHA-256, who delivered it, and the audit state.
 *   Written by the sync on import, reuse and repair, and by a device upload after its digest check.
 * - `icloud_claim`: a lease on one logical Apple item (all its roles), so only one path downloads
 *   and uploads it.
 * - `icloud_connection."unhealthySince"`: when a connection stopped being healthy (kept by a
 *   trigger, so every state change counts); after 72 hours devices take over its pending items.
 *   `"accountHint"`: the Apple Account, masked, for the coverage probe.
 *
 * Fork-owned: no foreign key into the official schema.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.icloud_source_identity (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL,
      "assetId" uuid NOT NULL,
      "libraryKey" text,
      library jsonb,
      "cplAssetRecordName" text NOT NULL,
      "cplMasterRecordName" text,
      role text NOT NULL,
      "editVersion" text NOT NULL DEFAULT '',
      sha256 bytea NOT NULL,
      "appleFingerprint" text,
      "cloudChecksum" text,
      "deliveredBy" text NOT NULL,
      "deliveredAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "lastVerifiedAt" timestamptz,
      "lastAuditResult" text,
      "cloudIdentifier" text,
      "matchStrength" text,
      CONSTRAINT icloud_source_identity_pkey PRIMARY KEY (id),
      CONSTRAINT icloud_source_identity_role_check CHECK (role IN ('original', 'live-motion', 'raw-alternate', 'edit-render')),
      CONSTRAINT icloud_source_identity_edit_check CHECK ((role = 'edit-render') = ("editVersion" <> '')),
      CONSTRAINT icloud_source_identity_sha256_check CHECK (octet_length(sha256) = 32),
      CONSTRAINT icloud_source_identity_delivered_check CHECK ("deliveredBy" ~ '^(icloud-sync|device):.+$'),
      CONSTRAINT icloud_source_identity_audit_check CHECK ("lastAuditResult" IN ('match', 'mismatch')),
      CONSTRAINT icloud_source_identity_strength_check CHECK ("matchStrength" IN ('exact', 'corroborated', 'hint')),
      CONSTRAINT icloud_source_identity_key UNIQUE ("ownerId", "cplAssetRecordName", role, "editVersion", "assetId")
    )
  `.execute(db);
  await sql`CREATE INDEX icloud_source_identity_asset_idx ON immich_fork.icloud_source_identity ("assetId")`.execute(db);
  await sql`CREATE INDEX icloud_source_identity_sha256_idx ON immich_fork.icloud_source_identity ("ownerId", sha256)`.execute(
    db,
  );
  // the app looks items up by their CPLAsset record name, whatever its case
  await sql`
    CREATE INDEX icloud_record_asset_name_idx ON immich_fork.icloud_record ("connectionId", upper("recordId"))
    WHERE "recordType" = 'CPLAsset' AND NOT deleted
  `.execute(db);
  await sql`
    CREATE TABLE immich_fork.icloud_claim (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      "ownerId" uuid NOT NULL,
      "cplAssetRecordName" text NOT NULL,
      holder text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT icloud_claim_pkey PRIMARY KEY ("ownerId", "cplAssetRecordName"),
      CONSTRAINT icloud_claim_id_key UNIQUE (id),
      CONSTRAINT icloud_claim_holder_check CHECK (holder ~ '^(icloud-sync|device):.+$')
    )
  `.execute(db);
  await sql`
    ALTER TABLE immich_fork.icloud_connection
      ADD COLUMN "unhealthySince" timestamptz,
      ADD COLUMN "accountHint" text
  `.execute(db);
  await sql`UPDATE immich_fork.icloud_connection SET "unhealthySince" = "updatedAt" WHERE state <> 'connected'`.execute(db);
  await sql`
    CREATE FUNCTION immich_fork.icloud_connection_unhealthy_since() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.state = 'connected' THEN
        NEW."unhealthySince" := NULL;
      ELSIF NEW."unhealthySince" IS NULL THEN
        NEW."unhealthySince" := now();
      END IF;
      RETURN NEW;
    END
    $$
  `.execute(db);
  await sql`
    CREATE TRIGGER icloud_connection_unhealthy_since BEFORE INSERT OR UPDATE OF state ON immich_fork.icloud_connection
    FOR EACH ROW EXECUTE FUNCTION immich_fork.icloud_connection_unhealthy_since()
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER icloud_connection_unhealthy_since ON immich_fork.icloud_connection`.execute(db);
  await sql`DROP FUNCTION immich_fork.icloud_connection_unhealthy_since()`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_connection DROP COLUMN "unhealthySince", DROP COLUMN "accountHint"`.execute(db);
  await sql`DROP TABLE immich_fork.icloud_claim`.execute(db);
  await sql`DROP INDEX immich_fork.icloud_record_asset_name_idx`.execute(db);
  await sql`DROP TABLE immich_fork.icloud_source_identity`.execute(db);
}
