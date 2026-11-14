import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE photography_booking_type (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name text NOT NULL, description text NOT NULL DEFAULT '', "durationMinutes" integer NOT NULL CHECK ("durationMinutes" > 0),
    price integer NOT NULL CHECK (price >= 0), deposit integer NOT NULL DEFAULT 0 CHECK (deposit >= 0 AND deposit <= price),
    currency text NOT NULL, active boolean NOT NULL DEFAULT true, "addOns" jsonb NOT NULL DEFAULT '[]',
    "order" integer NOT NULL DEFAULT 0, "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE photography_booking (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "bookingTypeId" uuid REFERENCES photography_booking_type(id) ON DELETE SET NULL,
    "typeName" text NOT NULL, "clientName" text NOT NULL, "clientEmail" text NOT NULL, message text NOT NULL DEFAULT '',
    "preferredDates" jsonb NOT NULL DEFAULT '[]', "addOns" jsonb NOT NULL DEFAULT '[]',
    total integer NOT NULL, deposit integer NOT NULL DEFAULT 0, currency text NOT NULL,
    "depositPaymentId" uuid REFERENCES photography_payment(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'requested', "requestedAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX photography_booking_type_owner_idx ON photography_booking_type ("ownerId", "order")`.execute(db);
  await sql`CREATE INDEX photography_booking_owner_idx ON photography_booking ("ownerId", "requestedAt" DESC)`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE photography_booking, photography_booking_type`.execute(db);
}
