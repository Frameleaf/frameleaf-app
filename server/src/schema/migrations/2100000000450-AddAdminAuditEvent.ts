import { Kysely, sql } from 'kysely';

/**
 * The administrator audit trail behind the account detail's Activity tab (FL-76).
 *
 * A new table and nothing is backfilled: each account's history starts when this migration runs.
 * Rows hold user and library ids plus the names and settings an administrator changed, never a
 * photo, a path or a secret, so dropping the table loses only the history, never an account, a
 * library or a setting.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // NOTE: constraint and index names follow the generator's conventions so
  // `migrations:generate` produces no drift against AdminAuditEventTable:
  // `{table}_{column}_fkey`, `{table}_pkey`, a `{table}_{column}_idx` index for
  // every foreign-key column, plus the one composite index named on the class.
  await sql`CREATE TABLE "admin_audit_event" (
  "id" uuid NOT NULL DEFAULT immich_uuid_v7(),
  "userId" uuid NOT NULL,
  "actorId" uuid,
  "libraryId" uuid,
  "action" character varying NOT NULL,
  "subject" character varying NOT NULL,
  "detail" character varying,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "admin_audit_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "admin_audit_event_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "admin_audit_event_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "admin_audit_event_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "admin_audit_event_userId_idx" ON "admin_audit_event" ("userId");`.execute(db);
  await sql`CREATE INDEX "admin_audit_event_actorId_idx" ON "admin_audit_event" ("actorId");`.execute(db);
  await sql`CREATE INDEX "admin_audit_event_libraryId_idx" ON "admin_audit_event" ("libraryId");`.execute(db);
  await sql`CREATE INDEX "admin_audit_event_userId_createdAt_idx" ON "admin_audit_event" ("userId", "createdAt");`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "admin_audit_event";`.execute(db);
}
