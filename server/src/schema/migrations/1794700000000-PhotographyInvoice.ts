import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE photography_invoice (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    number integer NOT NULL, "clientName" text NOT NULL, "clientEmail" text NOT NULL, lines jsonb NOT NULL,
    "taxBasisPoints" integer NOT NULL, currency text NOT NULL, subtotal integer NOT NULL, tax integer NOT NULL,
    total integer NOT NULL, schedule jsonb NOT NULL, reminders boolean NOT NULL DEFAULT true,
    status text NOT NULL DEFAULT 'draft', "tokenHashes" text[] NOT NULL DEFAULT '{}', "sentAt" timestamptz, "lastReminderOn" date,
    "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("ownerId", number)
  )`.execute(db);
  await sql`ALTER TABLE photography_payment ADD COLUMN "invoiceId" uuid REFERENCES photography_invoice(id) ON DELETE SET NULL`.execute(
    db,
  );
  await sql`CREATE INDEX photography_payment_invoice_idx ON photography_payment ("invoiceId")`.execute(db);
  await sql`CREATE INDEX photography_invoice_due_idx ON photography_invoice (status) WHERE status IN ('sent','part')`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE photography_payment DROP COLUMN "invoiceId"`.execute(db);
  await sql`DROP TABLE photography_invoice`.execute(db);
}
