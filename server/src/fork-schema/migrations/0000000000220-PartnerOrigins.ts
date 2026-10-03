import { Kysely, sql } from 'kysely';

/**
 * Partner sharing v2 (FL-326, spec §4.2): a partner receives their own copies of what is shared with
 * them. Each copy records where it came from and which fields its owner has changed since, so the
 * propagation job can keep pushing the source's edits into every field the owner left alone.
 *
 * - `asset_origin` and `album_origin` key one row per copy (`assetId`, `albumId`); `person_origin`
 *   keys it by the copy's `ownerId` and `personGroupId`, as a person is keyed. `ownerId` is the copy's
 *   owner, `rootOwnerId` the original uploader (the "from partner" label), `partnerSharedById` the
 *   partner whose sharing produced the copy. `following` turns off when that partnership ends; the
 *   copy stays.
 * - `partner_backfill` is the resumable cursor of the first copy of a partner's library.
 *
 * Fork-owned, so these live in `immich_fork` and do not foreign-key into the official schema (as
 * every fork table). A source that is gone simply has no row to read; a copy that is gone is archived
 * as an orphan on return (`ORPHAN_FAMILIES`).
 */
export async function up(db: Kysely<any>): Promise<void> {
  for (const [table, key, source] of [
    ['asset_origin', 'assetId', 'sourceAssetId'],
    ['album_origin', 'albumId', 'sourceAlbumId'],
  ] as const) {
    await sql`
      CREATE TABLE immich_fork.${sql.raw(table)} (
        ${sql.id(key)} uuid NOT NULL,
        ${sql.id(source)} uuid,
        "ownerId" uuid NOT NULL,
        "rootOwnerId" uuid NOT NULL,
        "partnerSharedById" uuid NOT NULL,
        "overriddenFields" text[] NOT NULL DEFAULT '{}'::text[],
        following boolean NOT NULL DEFAULT true,
        "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT ${sql.raw(`${table}_pkey`)} PRIMARY KEY (${sql.id(key)})
      )
    `.execute(db);
    await sql`
      CREATE INDEX ${sql.raw(`${table}_source_idx`)} ON immich_fork.${sql.raw(table)} (${sql.id(source)}) WHERE following
    `.execute(db);
    await sql`
      CREATE INDEX ${sql.raw(`${table}_partner_idx`)} ON immich_fork.${sql.raw(table)} ("partnerSharedById", "ownerId")
    `.execute(db);
  }

  // A person is keyed by its owner and person group (faces point at the group), so is its origin.
  await sql`
    CREATE TABLE immich_fork.person_origin (
      "ownerId" uuid NOT NULL,
      "personGroupId" uuid NOT NULL,
      "sourceOwnerId" uuid NOT NULL,
      "sourcePersonGroupId" uuid NOT NULL,
      "rootOwnerId" uuid NOT NULL,
      "partnerSharedById" uuid NOT NULL,
      "overriddenFields" text[] NOT NULL DEFAULT '{}'::text[],
      following boolean NOT NULL DEFAULT true,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT person_origin_pkey PRIMARY KEY ("ownerId", "personGroupId"),
      CONSTRAINT person_origin_source_key UNIQUE ("ownerId", "sourcePersonGroupId")
    )
  `.execute(db);
  await sql`
    CREATE INDEX person_origin_source_idx ON immich_fork.person_origin ("sourceOwnerId", "sourcePersonGroupId") WHERE following
  `.execute(db);
  await sql`
    CREATE INDEX person_origin_partner_idx ON immich_fork.person_origin ("partnerSharedById", "ownerId")
  `.execute(db);

  await sql`
    CREATE TABLE immich_fork.partner_backfill (
      "sharedById" uuid NOT NULL,
      "sharedWithId" uuid NOT NULL,
      state text NOT NULL DEFAULT 'pending',
      cursor uuid,
      total integer NOT NULL DEFAULT 0,
      done integer NOT NULL DEFAULT 0,
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT partner_backfill_pkey PRIMARY KEY ("sharedById", "sharedWithId")
    )
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.partner_backfill`.execute(db);
  await sql`DROP TABLE immich_fork.person_origin`.execute(db);
  await sql`DROP TABLE immich_fork.album_origin`.execute(db);
  await sql`DROP TABLE immich_fork.asset_origin`.execute(db);
}
