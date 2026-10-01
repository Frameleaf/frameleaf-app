import { Kysely, sql } from 'kysely';

/**
 * FL-228: the push device registry. A registration belongs to one device session, so logout, session
 * revocation and account removal delete it (and its Live Activity tokens) through the foreign keys.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE push_device (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "userId" uuid NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "sessionId" uuid NOT NULL REFERENCES session(id) ON DELETE CASCADE ON UPDATE CASCADE,
    platform text NOT NULL, "pushToken" text NOT NULL, "pushToStartToken" text, "publicKey" text NOT NULL,
    "backupDeviceKey" uuid, "disabledEvents" text[] NOT NULL DEFAULT '{}',
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "lastDeliveredAt" timestamptz, "lastStaleWakeAt" timestamptz,
    CONSTRAINT "push_device_sessionId_uq" UNIQUE ("sessionId")
  );`.execute(db);
  await sql`CREATE INDEX "push_device_userId_idx" ON push_device ("userId");`.execute(db);
  await sql`CREATE INDEX "push_device_sessionId_idx" ON push_device ("sessionId");`.execute(db);
  await sql`CREATE TABLE push_device_activity (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "deviceId" uuid NOT NULL REFERENCES push_device(id) ON DELETE CASCADE ON UPDATE CASCADE,
    "activityId" text NOT NULL, kind text NOT NULL, token text NOT NULL,
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "push_device_activity_deviceId_activityId_uq" UNIQUE ("deviceId", "activityId")
  );`.execute(db);
  await sql`CREATE INDEX "push_device_activity_deviceId_idx" ON push_device_activity ("deviceId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE push_device_activity; DROP TABLE push_device;`.execute(db);
}
