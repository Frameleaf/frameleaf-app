import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE photo_source (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "ownerId" uuid NOT NULL REFERENCES "user"(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "deviceId" uuid NOT NULL REFERENCES desktop_device(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "photoSessionId" uuid NOT NULL, kind varchar NOT NULL, mode varchar NOT NULL,
    name varchar NOT NULL, "scopeFingerprint" varchar NOT NULL,
    "revokedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE photo_source_run (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "sourceId" uuid NOT NULL REFERENCES photo_source(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "maxBytes" bigint NOT NULL, "maxItems" integer NOT NULL,
    state varchar NOT NULL DEFAULT 'open', "inventoryComplete" boolean NOT NULL DEFAULT false,
    "createdAt" timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE TABLE photo_source_resource (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "runId" uuid NOT NULL REFERENCES photo_source_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
    "resourceKey" varchar NOT NULL, version varchar NOT NULL, checksum bytea NOT NULL, bytes bigint NOT NULL,
    state varchar NOT NULL DEFAULT 'planned', "assetId" uuid, "uploadResourceId" uuid,
    "verifiedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT photo_source_resource_runid_resourcekey_version_uq UNIQUE ("runId", "resourceKey", version)
  )`.execute(db);
  await sql`CREATE INDEX photo_source_ownerid_idx ON photo_source ("ownerId")`.execute(db);
  await sql`CREATE INDEX photo_source_deviceid_idx ON photo_source ("deviceId")`.execute(db);
  await sql`CREATE INDEX photo_source_run_sourceid_idx ON photo_source_run ("sourceId")`.execute(db);
}
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('photo_source_resource').execute();
  await db.schema.dropTable('photo_source_run').execute();
  await db.schema.dropTable('photo_source').execute();
}
