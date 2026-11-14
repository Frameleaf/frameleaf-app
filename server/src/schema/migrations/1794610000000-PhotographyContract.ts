import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE photography_contract_template (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name text NOT NULL, body text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE photography_contract (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "ownerId" uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "templateId" uuid REFERENCES photography_contract_template(id) ON DELETE SET NULL,
    name text NOT NULL, "clientName" text NOT NULL, "clientEmail" text NOT NULL,
    body text NOT NULL, "documentSha256" text NOT NULL, status text NOT NULL DEFAULT 'draft',
    "tokenHash" text UNIQUE, "tokenExpiresAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "sentAt" timestamptz, "signedAt" timestamptz,
    "signerName" text, "signatureType" text, "signaturePng" bytea, "pdfPath" text, "finalPdfSha256" text
  )`.execute(db);
  await sql`CREATE TABLE photography_contract_event (
    "contractId" uuid NOT NULL REFERENCES photography_contract(id) ON DELETE CASCADE,
    seq integer NOT NULL, type text NOT NULL, actor text NOT NULL, at timestamptz NOT NULL,
    ip text, "userAgent" text, data jsonb NOT NULL, "prevEventSha256" text, sha256 text NOT NULL,
    PRIMARY KEY ("contractId", seq)
  )`.execute(db);
  await sql`CREATE INDEX photography_contract_template_owner_idx ON photography_contract_template ("ownerId")`.execute(db);
  await sql`CREATE INDEX photography_contract_owner_idx ON photography_contract ("ownerId","createdAt" DESC)`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE photography_contract_event, photography_contract, photography_contract_template`.execute(db);
}
