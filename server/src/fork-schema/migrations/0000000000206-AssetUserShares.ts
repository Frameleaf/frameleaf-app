import { Kysely, sql } from 'kysely';

/**
 * Items shared with a person in this library (FL-83 AL-30b, owner decision 2026-09-27): the
 * prototype's "Share with people in this library" (`SharedLinks.jsx:425-590`). A row gives one
 * account (`sharedWithId`) access to one of the owner's items (`assetId`), not to an album or the
 * whole library. The recipient sees it in their own Frameleaf; nothing leaves the server.
 *
 * - One row per item and recipient; sharing again keeps the first row.
 * - Locked items are never shared: the service refuses them, and every read and access check
 *   leaves out an item that is locked now, so locking an item after it was shared hides it again.
 *
 * Fork-owned, so it lives in `immich_fork` and does not foreign-key into the official schema; a row
 * whose item or either account is gone is never read.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE immich_fork.asset_user_share (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      "assetId" uuid NOT NULL,
      "ownerId" uuid NOT NULL,
      "sharedWithId" uuid NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT asset_user_share_pkey PRIMARY KEY (id),
      CONSTRAINT asset_user_share_asset_recipient_key UNIQUE ("assetId", "sharedWithId")
    )
  `.execute(db);
  await sql`
    CREATE INDEX asset_user_share_recipient_idx
      ON immich_fork.asset_user_share ("sharedWithId", "createdAt")
  `.execute(db);
  await sql`
    CREATE INDEX asset_user_share_owner_idx ON immich_fork.asset_user_share ("ownerId", "assetId")
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE immich_fork.asset_user_share`.execute(db);
}
