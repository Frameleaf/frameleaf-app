import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE backup_device (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "ownerId" uuid NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "deviceKey" uuid NOT NULL, "displayName" text NOT NULL, model text NOT NULL, platform text NOT NULL, "appVersion" text NOT NULL,
    "reportedAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "lastSuccessfulBackupAt" timestamptz, "pendingCount" integer NOT NULL, "deletedAt" timestamptz,
    CONSTRAINT "backup_device_ownerId_deviceKey_uq" UNIQUE("ownerId", "deviceKey")
  );`.execute(db);
  await sql`CREATE INDEX "backup_device_ownerId_idx" ON backup_device("ownerId");`.execute(db);
  await sql`CREATE TABLE backup_reconciliation (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "deviceId" uuid NOT NULL REFERENCES backup_device(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "ownerId" uuid NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "startedAt" timestamptz NOT NULL DEFAULT clock_timestamp(), "checkedAt" timestamptz NOT NULL, "completedAt" timestamptz,
    "itemsChecked" integer NOT NULL, "itemsMissing" integer NOT NULL, progress jsonb NOT NULL
  );`.execute(db);
  await sql`CREATE INDEX "backup_reconciliation_deviceId_idx" ON backup_reconciliation("deviceId");`.execute(db);
  await sql`CREATE INDEX "backup_reconciliation_ownerId_idx" ON backup_reconciliation("ownerId");`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE backup_reconciliation; DROP TABLE backup_device;`.execute(db);
}
