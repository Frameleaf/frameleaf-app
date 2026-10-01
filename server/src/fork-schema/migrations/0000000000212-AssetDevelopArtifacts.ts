import { Kysely, sql } from 'kysely';

/**
 * Develop artifacts (FL-233): the mask bitmaps and generated Clean Up fills a client computed for a
 * photo and uploaded so recipes can reference them by SHA-256 (`POST assets/:id/develop/artifacts`).
 * They are a person's work, not regenerable: the row tracks the file (so the integrity check never
 * offers it for deletion), its size (counted against the owner's quota), and when it was stored (so
 * an artifact no saved version references is released after a grace period).
 *
 * Fork-owned: no foreign key into the official schema; a removed asset's artifacts are released
 * with it.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.asset_develop_artifact (
      "assetId" uuid NOT NULL,
      id text NOT NULL,
      "ownerId" uuid NOT NULL,
      kind text NOT NULL,
      path text NOT NULL,
      bytes bigint NOT NULL,
      width integer NOT NULL,
      height integer NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT asset_develop_artifact_pkey PRIMARY KEY ("assetId", id),
      CONSTRAINT asset_develop_artifact_kind_check CHECK (kind IN ('mask', 'fill')),
      CONSTRAINT asset_develop_artifact_id_check CHECK (id ~ '^[0-9a-f]{64}$')
    )
  `.execute(db);
  await sql`CREATE INDEX asset_develop_artifact_owner_idx ON immich_fork.asset_develop_artifact ("ownerId")`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX asset_develop_artifact_path_key ON immich_fork.asset_develop_artifact (path)`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.asset_develop_artifact`.execute(db);
}
