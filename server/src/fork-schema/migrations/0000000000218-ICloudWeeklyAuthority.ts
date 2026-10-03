import { Kysely, sql } from 'kysely';

/** Consent and private frozen obligations only. No producer or scheduled execution in foundation A. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE immich_fork.icloud_weekly_grant (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL, "connectionId" uuid NOT NULL,
    generation integer NOT NULL CHECK (generation>0), enabled boolean NOT NULL DEFAULT false,
    "includeProtected" boolean NOT NULL DEFAULT false, "configFingerprint" text NOT NULL,
    "privacyFingerprint" text NOT NULL, "pinBinding" text,
    "requestKey" uuid NOT NULL, "inputFingerprint" text NOT NULL,
    "requestHistory" jsonb NOT NULL CHECK (jsonb_typeof("requestHistory")='object'),
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "revokedAt" timestamptz,
    UNIQUE("connectionId","ownerId"), UNIQUE(id,"ownerId","connectionId"),
    CHECK (NOT "includeProtected" OR (enabled AND "pinBinding" IS NOT NULL)),
    CHECK (enabled OR "revokedAt" IS NOT NULL),
    FOREIGN KEY("connectionId","ownerId") REFERENCES immich_fork.icloud_connection(id,"ownerId") ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE TABLE immich_fork.icloud_weekly_cohort (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL, "connectionId" uuid NOT NULL,
    "weekStart" date NOT NULL CHECK (extract(isodow FROM "weekStart")=1),
    "grantId" uuid, "grantGeneration" integer, "configFingerprint" text NOT NULL, "privacyFingerprint" text NOT NULL,
    seed bytea NOT NULL CHECK (octet_length(seed)=32), "manifestDigest" bytea NOT NULL CHECK (octet_length("manifestDigest")=32),
    "populationCount" bigint NOT NULL CHECK ("populationCount">=0), "staleCount" bigint NOT NULL CHECK ("staleCount">=0),
    "selectedCount" bigint NOT NULL CHECK ("selectedCount">=0 AND "selectedCount"=("populationCount"+99)/100),
    "performedCount" bigint NOT NULL DEFAULT 0, "matchCount" bigint NOT NULL DEFAULT 0,
    "mismatchCount" bigint NOT NULL DEFAULT 0, "unavailableCount" bigint NOT NULL DEFAULT 0,
    "cancelledCount" bigint NOT NULL DEFAULT 0, "nextBatch" integer NOT NULL DEFAULT 0 CHECK ("nextBatch">=0),
    status text NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen','running','settled')),
    "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE("ownerId","connectionId","weekStart"), UNIQUE(id,"ownerId","connectionId"),
    UNIQUE(id,"ownerId","connectionId","grantId","grantGeneration"),
    CHECK (("grantId" IS NULL)=("grantGeneration" IS NULL)), CHECK ("grantGeneration" IS NULL OR "grantGeneration">0),
    CHECK ("matchCount">=0 AND "mismatchCount">=0 AND "unavailableCount">=0 AND "cancelledCount">=0
      AND "performedCount"="matchCount"+"mismatchCount"
      AND "performedCount"+"unavailableCount"+"cancelledCount"<="selectedCount"),
    CHECK (status<>'settled' OR "performedCount"+"unavailableCount"+"cancelledCount"="selectedCount"),
    FOREIGN KEY("connectionId","ownerId") REFERENCES immich_fork.icloud_connection(id,"ownerId") ON DELETE CASCADE,
    FOREIGN KEY("grantId","ownerId","connectionId") REFERENCES immich_fork.icloud_weekly_grant(id,"ownerId","connectionId")
  )`.execute(db);
  await sql`CREATE TABLE immich_fork.icloud_weekly_member (
    "cohortId" uuid NOT NULL, "ownerId" uuid NOT NULL, "connectionId" uuid NOT NULL,
    "receiptId" uuid NOT NULL, "resourceRoleKey" text NOT NULL,
    ordinal bigint NOT NULL CHECK (ordinal>=0), rank bytea NOT NULL CHECK (octet_length(rank)=32),
    selected boolean NOT NULL, "batchOrdinal" integer,
    "grantId" uuid, "grantGeneration" integer,
    "expectedSha256" bytea NOT NULL CHECK (octet_length("expectedSha256")=32),
    bindings jsonb NOT NULL CHECK (jsonb_typeof(bindings)='object'
      AND bindings ?& ARRAY['receipt','source','identity','original']),
    "technicalEligibility" text NOT NULL CHECK ("technicalEligibility" IN ('current','stale')),
    outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','match','mismatch','unavailable','cancelled')),
    "auditRequestId" uuid UNIQUE,
    PRIMARY KEY("cohortId",ordinal), UNIQUE("cohortId","receiptId"), UNIQUE("cohortId","resourceRoleKey"),
    UNIQUE("cohortId",ordinal,"ownerId","connectionId","grantId","grantGeneration","batchOrdinal"),
    CHECK (("grantId" IS NULL)=("grantGeneration" IS NULL)),
    CHECK ("grantGeneration" IS NULL OR "grantGeneration">0),
    CHECK ((selected AND "technicalEligibility"='current' AND "batchOrdinal" IS NOT NULL AND "batchOrdinal">=0)
      OR (NOT selected AND "batchOrdinal" IS NULL AND "auditRequestId" IS NULL)),
    CHECK ("auditRequestId" IS NULL OR (selected AND "grantId" IS NOT NULL)),
    FOREIGN KEY("cohortId","ownerId","connectionId") REFERENCES immich_fork.icloud_weekly_cohort(id,"ownerId","connectionId") ON DELETE CASCADE,
    FOREIGN KEY("cohortId","ownerId","connectionId","grantId","grantGeneration")
      REFERENCES immich_fork.icloud_weekly_cohort(id,"ownerId","connectionId","grantId","grantGeneration")
  )`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_identity_audit
    ALTER COLUMN "sessionId" DROP NOT NULL,
    ADD COLUMN purpose text NOT NULL DEFAULT 'manual-session',
    ADD COLUMN "grantId" uuid, ADD COLUMN "grantGeneration" integer,
    ADD COLUMN "cohortId" uuid, ADD COLUMN "memberOrdinal" bigint, ADD COLUMN "batchOrdinal" integer,
    ADD CONSTRAINT icloud_audit_weekly_binding UNIQUE
      (id,"cohortId","memberOrdinal","ownerId","connectionId","grantId","grantGeneration","batchOrdinal"),
    ADD CONSTRAINT icloud_audit_purpose CHECK (
      (purpose='manual-session' AND "sessionId" IS NOT NULL AND "grantId" IS NULL AND "grantGeneration" IS NULL
        AND "cohortId" IS NULL AND "memberOrdinal" IS NULL AND "batchOrdinal" IS NULL)
      OR (purpose='scheduled-weekly' AND "sessionId" IS NULL AND "grantId" IS NOT NULL
        AND "grantGeneration" IS NOT NULL AND "grantGeneration">0
        AND "cohortId" IS NOT NULL AND "memberOrdinal" IS NOT NULL AND "memberOrdinal">=0
        AND "batchOrdinal" IS NOT NULL AND "batchOrdinal">=0)),
    ADD CONSTRAINT icloud_audit_weekly_member FOREIGN KEY
      ("cohortId","memberOrdinal","ownerId","connectionId","grantId","grantGeneration","batchOrdinal")
      REFERENCES immich_fork.icloud_weekly_member
        ("cohortId",ordinal,"ownerId","connectionId","grantId","grantGeneration","batchOrdinal")`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_weekly_member ADD CONSTRAINT icloud_weekly_member_audit
    FOREIGN KEY("auditRequestId","cohortId",ordinal,"ownerId","connectionId","grantId","grantGeneration","batchOrdinal")
      REFERENCES immich_fork.icloud_identity_audit
        (id,"cohortId","memberOrdinal","ownerId","connectionId","grantId","grantGeneration","batchOrdinal")
      DEFERRABLE INITIALLY DEFERRED`.execute(db);
  // No mutable source/identity/asset FK: deleting those cannot erase a frozen obligation.
  await sql`CREATE FUNCTION immich_fork.retire_icloud_weekly_authority() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_row jsonb; new_row jsonb; owner_id uuid; connection_id uuid; changed boolean;
    BEGIN
      old_row := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
      new_row := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
      IF TG_TABLE_NAME='icloud_connection' THEN
        owner_id := (new_row->>'ownerId')::uuid; connection_id := (new_row->>'id')::uuid;
        changed := old_row->'config' IS DISTINCT FROM new_row->'config'
          OR old_row->'encryptedSession' IS DISTINCT FROM new_row->'encryptedSession'
          OR (new_row->>'lastError'='owner_removed' AND old_row->>'lastError' IS DISTINCT FROM 'owner_removed')
          OR (old_row->>'state' IS DISTINCT FROM new_row->>'state' AND new_row->>'state'<>'connected');
      ELSIF TG_TABLE_NAME='user' THEN
        owner_id := coalesce(new_row->>'id',old_row->>'id')::uuid;
        changed := TG_OP='DELETE' OR old_row->'pinCode' IS DISTINCT FROM new_row->'pinCode'
          OR old_row->'deletedAt' IS DISTINCT FROM new_row->'deletedAt';
      ELSE
        owner_id := coalesce(new_row->>'userId',old_row->>'userId')::uuid;
        changed := coalesce(new_row->>'key',old_row->>'key')='preferences'
          AND old_row->'value'->'privacy' IS DISTINCT FROM new_row->'value'->'privacy';
      END IF;
      IF changed THEN
        UPDATE immich_fork.icloud_weekly_grant SET enabled=false,"includeProtected"=false,
          "pinBinding"=NULL,generation=generation+1,"revokedAt"=clock_timestamp()
          WHERE "ownerId"=owner_id AND (connection_id IS NULL OR "connectionId"=connection_id) AND enabled;
      END IF;
      RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
    END $$`.execute(db);
  await sql`CREATE TRIGGER icloud_weekly_connection_retirement AFTER UPDATE ON immich_fork.icloud_connection
    FOR EACH ROW EXECUTE FUNCTION immich_fork.retire_icloud_weekly_authority()`.execute(db);
  await sql`CREATE TRIGGER icloud_weekly_pin_retirement AFTER UPDATE OR DELETE ON public.user
    FOR EACH ROW EXECUTE FUNCTION immich_fork.retire_icloud_weekly_authority()`.execute(db);
  await sql`CREATE TRIGGER icloud_weekly_privacy_retirement AFTER INSERT OR UPDATE OR DELETE ON public.user_metadata
    FOR EACH ROW EXECUTE FUNCTION immich_fork.retire_icloud_weekly_authority()`.execute(db);
  await sql`CREATE FUNCTION immich_fork.freeze_icloud_weekly_bindings() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='icloud_weekly_cohort' THEN
        IF (to_jsonb(NEW)-ARRAY['performedCount','matchCount','mismatchCount','unavailableCount','cancelledCount','nextBatch','status'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['performedCount','matchCount','mismatchCount','unavailableCount','cancelledCount','nextBatch','status'])
          THEN RAISE EXCEPTION 'icloud_weekly_cohort_frozen'; END IF;
      ELSE
        IF (to_jsonb(NEW)-ARRAY['outcome','auditRequestId']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['outcome','auditRequestId'])
          THEN RAISE EXCEPTION 'icloud_weekly_member_frozen'; END IF;
        IF OLD.outcome<>'pending' AND NEW.outcome IS DISTINCT FROM OLD.outcome
          THEN RAISE EXCEPTION 'icloud_weekly_outcome_frozen'; END IF;
        IF OLD."auditRequestId" IS NOT NULL AND NEW."auditRequestId" IS DISTINCT FROM OLD."auditRequestId"
          THEN RAISE EXCEPTION 'icloud_weekly_audit_binding_frozen'; END IF;
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER icloud_weekly_cohort_frozen BEFORE UPDATE ON immich_fork.icloud_weekly_cohort
    FOR EACH ROW EXECUTE FUNCTION immich_fork.freeze_icloud_weekly_bindings()`.execute(db);
  await sql`CREATE TRIGGER icloud_weekly_member_frozen BEFORE UPDATE ON immich_fork.icloud_weekly_member
    FOR EACH ROW EXECUTE FUNCTION immich_fork.freeze_icloud_weekly_bindings()`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  const result = await sql`SELECT 1 FROM immich_fork.icloud_weekly_grant UNION ALL
    SELECT 1 FROM immich_fork.icloud_weekly_cohort UNION ALL SELECT 1 FROM immich_fork.icloud_weekly_member
    UNION ALL SELECT 1 FROM immich_fork.icloud_identity_audit WHERE purpose<>'manual-session' LIMIT 1`.execute(db);
  if (result.rows.length > 0) {
    throw new Error('icloud_weekly_authority_requires_retention');
  }
  await sql`DROP TRIGGER icloud_weekly_privacy_retirement ON public.user_metadata`.execute(db);
  await sql`DROP TRIGGER icloud_weekly_pin_retirement ON public.user`.execute(db);
  await sql`DROP TRIGGER icloud_weekly_connection_retirement ON immich_fork.icloud_connection`.execute(db);
  await sql`DROP FUNCTION immich_fork.retire_icloud_weekly_authority()`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_weekly_member DROP CONSTRAINT icloud_weekly_member_audit`.execute(db);
  await sql`ALTER TABLE immich_fork.icloud_identity_audit DROP CONSTRAINT icloud_audit_weekly_member,
    DROP CONSTRAINT icloud_audit_weekly_binding, DROP CONSTRAINT icloud_audit_purpose,
    DROP COLUMN purpose, DROP COLUMN "grantId", DROP COLUMN "grantGeneration",
    DROP COLUMN "cohortId", DROP COLUMN "memberOrdinal", DROP COLUMN "batchOrdinal", ALTER COLUMN "sessionId" SET NOT NULL`.execute(db);
  await sql`DROP TABLE immich_fork.icloud_weekly_member,immich_fork.icloud_weekly_cohort,immich_fork.icloud_weekly_grant`.execute(db);
  await sql`DROP FUNCTION immich_fork.freeze_icloud_weekly_bindings()`.execute(db);
}
