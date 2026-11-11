import { Kysely, sql } from 'kysely';

/** FL-1446, FL-1447: creators in Boards, what each saved item is, and what its owner has watched. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE media_creator (
      id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "ownerId" uuid NOT NULL REFERENCES "user" ON DELETE CASCADE ON UPDATE CASCADE,
      provider varchar NOT NULL, "creatorId" varchar NOT NULL, name varchar NOT NULL, handle varchar, about text, url text,
      "avatarUrl" text, "avatarPath" text, "bannerUrl" text, "bannerPath" text,
      "albumId" uuid REFERENCES album ON DELETE SET NULL ON UPDATE CASCADE,
      "seenAt" timestamptz NOT NULL DEFAULT now(),
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "media_creator_ownerId_provider_creatorId_key" UNIQUE ("ownerId", provider, "creatorId")
    );
    CREATE INDEX "media_creator_albumId_idx" ON media_creator ("albumId");
    CREATE TABLE media_watch (
      "ownerId" uuid NOT NULL REFERENCES "user" ON DELETE CASCADE ON UPDATE CASCADE,
      "assetId" uuid NOT NULL REFERENCES asset ON DELETE CASCADE ON UPDATE CASCADE,
      watched boolean NOT NULL DEFAULT false, position double precision NOT NULL DEFAULT 0,
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT media_watch_pkey PRIMARY KEY ("ownerId", "assetId")
    );
    CREATE INDEX "media_watch_assetId_idx" ON media_watch ("assetId");
    ALTER TABLE media_subscription
      ADD COLUMN "mediaCreatorId" uuid REFERENCES media_creator ON DELETE SET NULL ON UPDATE CASCADE,
      ADD COLUMN saves jsonb NOT NULL DEFAULT '{}', ADD COLUMN quality varchar NOT NULL DEFAULT 'best';
    CREATE INDEX "media_subscription_mediaCreatorId_idx" ON media_subscription ("mediaCreatorId");
    ALTER TABLE media_import
      ADD COLUMN "mediaCreatorId" uuid REFERENCES media_creator ON DELETE SET NULL ON UPDATE CASCADE,
      ADD COLUMN quality varchar NOT NULL DEFAULT 'best';
    CREATE INDEX "media_import_mediaCreatorId_idx" ON media_import ("mediaCreatorId");
    ALTER TABLE asset_source
      ADD COLUMN "mediaCreatorId" uuid REFERENCES media_creator ON DELETE SET NULL ON UPDATE CASCADE,
      ADD COLUMN section text, ADD COLUMN tags jsonb NOT NULL DEFAULT '[]', ADD COLUMN "playlistId" text,
      ADD COLUMN "playlistTitle" text, ADD COLUMN duration double precision, ADD COLUMN "posterPath" text;
    CREATE INDEX "asset_source_mediaCreatorId_idx" ON asset_source ("mediaCreatorId");

    -- Subscriptions made before creators existed keep their collection and gain their creator.
    INSERT INTO media_creator ("ownerId", provider, "creatorId", name, url, "albumId")
      SELECT DISTINCT ON ("ownerId", provider, "creatorId") "ownerId", provider, "creatorId", creator, url, "albumId"
      FROM media_subscription ORDER BY "ownerId", provider, "creatorId", (status = 'unsubscribed'), "createdAt" DESC;
    UPDATE media_subscription subscription SET "mediaCreatorId" = creator.id FROM media_creator creator
      WHERE creator."ownerId" = subscription."ownerId" AND creator.provider = subscription.provider
      AND creator."creatorId" = subscription."creatorId";
    UPDATE media_import operation SET "mediaCreatorId" = subscription."mediaCreatorId" FROM media_subscription subscription
      WHERE operation."subscriptionId" = subscription.id;
    UPDATE asset_source source SET "mediaCreatorId" = operation."mediaCreatorId"
      FROM media_import_item item JOIN media_import operation ON operation.id = item."importId"
      WHERE item."uploadId" = source."captureId" AND item."assetId" = source."assetId"
      AND operation."mediaCreatorId" IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE asset_source DROP COLUMN "mediaCreatorId", DROP COLUMN section, DROP COLUMN tags, DROP COLUMN "playlistId",
      DROP COLUMN "playlistTitle", DROP COLUMN duration, DROP COLUMN "posterPath";
    ALTER TABLE media_import DROP COLUMN "mediaCreatorId", DROP COLUMN quality;
    ALTER TABLE media_subscription DROP COLUMN "mediaCreatorId", DROP COLUMN saves, DROP COLUMN quality;
    DROP TABLE media_watch, media_creator;
  `.execute(db);
}
