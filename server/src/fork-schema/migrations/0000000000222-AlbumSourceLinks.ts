import { Kysely, sql } from 'kysely';

/**
 * Album source links (FL-331, NAPI-015). A phone album (iOS Photos) or folder (Android) maps to one of
 * its owner's server albums, so the native apps can sync phone albums without ever creating a second
 * album for the same source, merging by name with albums already on the server.
 *
 * - `album_source_link`: one row per (owner, source kind, source id, device). `deviceKey` is set only
 *   when the source id is device-local (an iOS localIdentifier, an Android bucket); a cloud identifier
 *   leaves it null so every device shares the link. `lastSourceName` is the phone's name for the source
 *   when the server album last followed it (the rename guard).
 * - `album_source_asset`: the album memberships a link's sync added, so a removal on the phone only
 *   undoes the sync's own additions, never an asset someone put in the album by hand.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema: a link whose
 * album no longer exists (or was deleted) is ignored by every reader and dropped when it is next resolved.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.album_source_link (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      "userId" uuid NOT NULL,
      "albumId" uuid NOT NULL,
      "sourceKind" text NOT NULL,
      "sourceId" text NOT NULL,
      "deviceKey" text,
      "lastSourceName" text NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT album_source_link_pkey PRIMARY KEY (id),
      CONSTRAINT album_source_link_kind_check CHECK ("sourceKind" = ANY (ARRAY['ios-photos'::text, 'android-folder'::text])),
      CONSTRAINT album_source_link_source_check CHECK (length("sourceId") BETWEEN 1 AND 1024),
      CONSTRAINT album_source_link_device_check CHECK ("deviceKey" IS NULL OR length("deviceKey") BETWEEN 1 AND 256)
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX album_source_link_source_idx
      ON immich_fork.album_source_link ("userId", "sourceKind", "sourceId", (COALESCE("deviceKey", ''::text)))
  `.execute(db);
  await sql`CREATE INDEX album_source_link_album_idx ON immich_fork.album_source_link ("albumId")`.execute(db);

  await sql`
    CREATE TABLE immich_fork.album_source_asset (
      "linkId" uuid NOT NULL,
      "assetId" uuid NOT NULL,
      "addedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT album_source_asset_pkey PRIMARY KEY ("linkId", "assetId"),
      CONSTRAINT album_source_asset_link_fkey FOREIGN KEY ("linkId") REFERENCES immich_fork.album_source_link (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX album_source_asset_asset_idx ON immich_fork.album_source_asset ("assetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.album_source_asset`.execute(db);
  await sql`DROP TABLE immich_fork.album_source_link`.execute(db);
}
