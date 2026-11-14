import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "connect_receipt" (
    "id" uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    "grantId" uuid NOT NULL REFERENCES "oauth_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "operation" text NOT NULL, "requestId" text NOT NULL, "requestHash" bytea NOT NULL,
    "status" text NOT NULL, "resultId" uuid NOT NULL, "result" jsonb NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(), "expiresAt" timestamptz NOT NULL,
    CONSTRAINT "connect_receipt_grantId_operation_requestId_uq" UNIQUE ("grantId", "operation", "requestId"),
    CONSTRAINT "connect_receipt_hash_check" CHECK (octet_length("requestHash") = 32)
  )`.execute(db);
  await sql`CREATE INDEX "connect_receipt_grantId_idx" ON "connect_receipt" ("grantId")`.execute(db);
  await sql`CREATE INDEX "connect_receipt_expiresAt_idx" ON "connect_receipt" ("expiresAt")`.execute(db);
  await sql`CREATE TABLE "connect_rendition_ticket" (
    "tokenHash" bytea PRIMARY KEY,
    "grantId" uuid NOT NULL REFERENCES "oauth_grant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "assetId" uuid NOT NULL REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "variant" text NOT NULL, "expiresAt" timestamptz NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX "connect_rendition_ticket_grantId_idx" ON "connect_rendition_ticket" ("grantId")`.execute(db);
  await sql`CREATE INDEX "connect_rendition_ticket_assetId_idx" ON "connect_rendition_ticket" ("assetId")`.execute(db);
  await sql`CREATE INDEX "connect_rendition_ticket_expiresAt_idx" ON "connect_rendition_ticket" ("expiresAt")`.execute(db);
  await sql`CREATE TABLE "connect_provenance" (
    "uploadId" uuid PRIMARY KEY,
    "assetId" uuid NOT NULL REFERENCES "asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "source" jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX "connect_provenance_assetId_idx" ON "connect_provenance" ("assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "connect_provenance", "connect_rendition_ticket", "connect_receipt"`.execute(db);
}
