import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE source_resource_grant (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "sourceId" uuid NOT NULL REFERENCES photo_source(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "photoSessionId" uuid NOT NULL REFERENCES session(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "tokenHash" bytea NOT NULL, "scopeFingerprint" varchar NOT NULL,
    "authorizationEpoch" integer NOT NULL, "lastSequence" integer NOT NULL DEFAULT 0,
    "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT source_resource_grant_sourceid_uq UNIQUE ("sourceId")
  )`.execute(db);
  await sql`CREATE INDEX source_resource_grant_photosessionid_idx ON source_resource_grant ("photoSessionId")`.execute(db);
  await sql`CREATE TABLE source_resource_grant_nonce (
    "sourceId" uuid NOT NULL REFERENCES photo_source(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "requestId" uuid NOT NULL, "expiresAt" timestamptz NOT NULL,
    PRIMARY KEY ("sourceId", "requestId")
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('source_resource_grant_nonce').execute();
  await db.schema.dropTable('source_resource_grant').execute();
}
