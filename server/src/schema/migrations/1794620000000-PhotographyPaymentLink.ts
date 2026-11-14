import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE photography_payment_link (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    slug text NOT NULL UNIQUE, title text NOT NULL, description text NOT NULL DEFAULT '',
    amount integer NOT NULL CHECK (amount > 0), currency text NOT NULL, reusable boolean NOT NULL DEFAULT true,
    active boolean NOT NULL DEFAULT true, "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE photography_payment (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "linkId" uuid REFERENCES photography_payment_link(id) ON DELETE SET NULL,
    amount integer NOT NULL, currency text NOT NULL, "payerEmail" text NOT NULL,
    "checkoutId" text, "providerRef" text, status text NOT NULL DEFAULT 'pending',
    "createdAt" timestamptz NOT NULL DEFAULT now(), "paidAt" timestamptz
  )`.execute(db);
  await sql`CREATE INDEX photography_payment_link_owner_idx ON photography_payment_link ("ownerId", "createdAt" DESC)`.execute(db);
  await sql`CREATE INDEX photography_payment_owner_idx ON photography_payment ("ownerId", "createdAt" DESC)`.execute(db);
  await sql`CREATE INDEX photography_payment_link_id_idx ON photography_payment ("linkId")`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE photography_payment, photography_payment_link`.execute(db);
}
