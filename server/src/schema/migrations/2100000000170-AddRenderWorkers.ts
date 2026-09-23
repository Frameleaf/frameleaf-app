import { Kysely, sql } from 'kysely';

/**
 * Render worker admission (FL-95 `STU-401`).
 *
 * Worker identities with a hashed enrolment secret, the scoped and expiring sessions admission
 * hands out, per-account limits with an `instance` default row, and an audit trail that carries no
 * foreign keys so it outlives the workers and operations it describes. `media_operation` gains the
 * columns a refusal is recorded on, the output byte counter the output ceiling is checked against
 * and the start of the current attempt, so an automatic re-dispatch is charged from zero.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "render_worker" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "name" character varying NOT NULL,
  "destination" character varying NOT NULL,
  "status" character varying NOT NULL DEFAULT 'active',
  "enrolmentSecret" bytea NOT NULL,
  "kinds" character varying[] NOT NULL,
  "engineDigest" character varying,
  "conformanceMaxAgeMs" integer NOT NULL DEFAULT 604800000,
  "lastConformanceReportedAt" timestamp with time zone,
  "maxConcurrentOperations" integer NOT NULL DEFAULT 1,
  "maxWallClockMs" bigint,
  "maxOutputBytes" bigint,
  "gpuMemoryBytes" bigint,
  "lastAdmittedAt" timestamp with time zone,
  "lastSeenAt" timestamp with time zone,
  "revokedAt" timestamp with time zone,
  "createdBy" uuid,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "render_worker_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "render_worker_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "render_worker_enrolmentSecret_idx" ON "render_worker" ("enrolmentSecret");`.execute(db);
  await sql`CREATE INDEX "render_worker_status_destination_idx" ON "render_worker" ("status", "destination");`.execute(
    db,
  );
  await sql`CREATE TRIGGER "render_worker_updatedAt"
  BEFORE UPDATE ON "render_worker"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "render_worker_session" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "workerId" uuid NOT NULL,
  "token" bytea NOT NULL,
  "scopes" character varying[] NOT NULL,
  "gpuMemoryBytes" bigint,
  "engineDigest" character varying,
  "conformanceReportedAt" timestamp with time zone NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "revokedAt" timestamp with time zone,
  "lastUsedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "render_worker_session_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "render_worker" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "render_worker_session_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "render_worker_session_token_idx" ON "render_worker_session" ("token");`.execute(db);
  await sql`CREATE INDEX "render_worker_session_workerId_expiresAt_idx" ON "render_worker_session" ("workerId", "expiresAt");`.execute(
    db,
  );

  await sql`CREATE TABLE "render_worker_limit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "subject" character varying NOT NULL,
  "userId" uuid,
  "maxConcurrentOperations" integer NOT NULL DEFAULT 2,
  "maxWallClockMs" bigint,
  "maxOutputBytes" bigint,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "render_worker_limit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "render_worker_limit_subject_uq" UNIQUE ("subject"),
  CONSTRAINT "render_worker_limit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE TRIGGER "render_worker_limit_updatedAt"
  BEFORE UPDATE ON "render_worker_limit"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  await sql`CREATE TABLE "render_worker_audit" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "workerId" uuid,
  "event" character varying NOT NULL,
  "reason" character varying,
  "operationId" uuid,
  "actorId" uuid,
  "detail" jsonb,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "render_worker_audit_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "render_worker_audit_workerId_createdAt_idx" ON "render_worker_audit" ("workerId", "createdAt");`.execute(
    db,
  );
  await sql`CREATE INDEX "render_worker_audit_operationId_idx" ON "render_worker_audit" ("operationId");`.execute(db);

  await sql`ALTER TABLE "media_operation" ADD "lastAdmissionRefusalReason" character varying;`.execute(db);
  await sql`ALTER TABLE "media_operation" ADD "lastAdmissionRefusedAt" timestamp with time zone;`.execute(db);
  await sql`ALTER TABLE "media_operation" ADD "admissionRefusals" integer NOT NULL DEFAULT 0;`.execute(db);
  await sql`ALTER TABLE "media_operation" ADD "outputBytes" bigint NOT NULL DEFAULT 0;`.execute(db);
  await sql`ALTER TABLE "media_operation" ADD "attemptStartedAt" timestamp with time zone;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "media_operation" DROP COLUMN "attemptStartedAt";`.execute(db);
  await sql`ALTER TABLE "media_operation" DROP COLUMN "outputBytes";`.execute(db);
  await sql`ALTER TABLE "media_operation" DROP COLUMN "admissionRefusals";`.execute(db);
  await sql`ALTER TABLE "media_operation" DROP COLUMN "lastAdmissionRefusedAt";`.execute(db);
  await sql`ALTER TABLE "media_operation" DROP COLUMN "lastAdmissionRefusalReason";`.execute(db);
  await sql`DROP TABLE "render_worker_audit";`.execute(db);
  await sql`DROP TABLE "render_worker_limit";`.execute(db);
  await sql`DROP TABLE "render_worker_session";`.execute(db);
  await sql`DROP TABLE "render_worker";`.execute(db);
}
