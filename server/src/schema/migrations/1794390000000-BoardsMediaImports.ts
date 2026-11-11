import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE media_connection (
      id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "ownerId" uuid NOT NULL REFERENCES "user" ON DELETE CASCADE ON UPDATE CASCADE,
      provider varchar NOT NULL, label varchar NOT NULL, domains jsonb NOT NULL, "encryptedSession" text,
      status varchar NOT NULL DEFAULT 'connected', revision integer NOT NULL DEFAULT 1,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX "media_connection_ownerId_idx" ON media_connection ("ownerId");
    CREATE TABLE media_subscription (
      id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "ownerId" uuid NOT NULL REFERENCES "user" ON DELETE CASCADE ON UPDATE CASCADE,
      "idempotencyKey" varchar NOT NULL, "requestHash" varchar NOT NULL,
      provider varchar NOT NULL, "creatorId" varchar NOT NULL, creator varchar NOT NULL, url text NOT NULL, "extractionUrl" text,
      "albumId" uuid REFERENCES album ON DELETE SET NULL ON UPDATE CASCADE,
      "connectionId" uuid REFERENCES media_connection ON DELETE SET NULL ON UPDATE CASCADE, "apiKeyId" uuid,
      history jsonb NOT NULL, "intervalMinutes" integer NOT NULL DEFAULT 60, status varchar NOT NULL DEFAULT 'active',
      generation integer NOT NULL DEFAULT 1, checkpoint text, "historyComplete" boolean NOT NULL DEFAULT false,
      "nextCheckAt" timestamptz NOT NULL DEFAULT now(), "lastSuccessAt" timestamptz, "lastReconcileAt" timestamptz,
      limitation text, error text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "media_subscription_ownerId_idempotencyKey_key" UNIQUE ("ownerId", "idempotencyKey")
    );
    CREATE INDEX "media_subscription_ownerId_idx" ON media_subscription ("ownerId");
    CREATE INDEX "media_subscription_status_nextCheckAt_idx" ON media_subscription (status, "nextCheckAt");
    CREATE INDEX "media_subscription_albumId_idx" ON media_subscription ("albumId");
    CREATE INDEX "media_subscription_connectionId_idx" ON media_subscription ("connectionId");
    CREATE TABLE media_import (
      id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "ownerId" uuid NOT NULL REFERENCES "user" ON DELETE CASCADE ON UPDATE CASCADE,
      "idempotencyKey" varchar, "requestHash" varchar, "apiKeyId" uuid, "authorization" varchar NOT NULL DEFAULT 'media-import.create',
      "subscriptionId" uuid REFERENCES media_subscription ON DELETE SET NULL ON UPDATE CASCADE, "subscriptionGeneration" integer,
      "connectionId" uuid REFERENCES media_connection ON DELETE SET NULL ON UPDATE CASCADE, "connectionRevision" integer,
      "albumId" uuid REFERENCES album ON DELETE SET NULL ON UPDATE CASCADE, "tagIds" jsonb NOT NULL DEFAULT '[]', urls jsonb NOT NULL,
      state varchar NOT NULL DEFAULT 'inspecting', generation integer NOT NULL DEFAULT 1, "jobRunId" uuid,
      "streamMp4" boolean NOT NULL DEFAULT false, "overrideSuppression" boolean NOT NULL DEFAULT false, inspection jsonb,
      error text, retries integer NOT NULL DEFAULT 0, "availableAt" timestamptz NOT NULL DEFAULT now(), "retryKeys" jsonb NOT NULL DEFAULT '[]',
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "media_import_ownerId_idempotencyKey_key" UNIQUE ("ownerId", "idempotencyKey")
    );
    CREATE INDEX "media_import_ownerId_createdAt_idx" ON media_import ("ownerId", "createdAt");
    CREATE INDEX media_import_state_idx ON media_import (state);
    CREATE INDEX "media_import_subscriptionId_idx" ON media_import ("subscriptionId");
    CREATE INDEX "media_import_connectionId_idx" ON media_import ("connectionId");
    CREATE INDEX "media_import_albumId_idx" ON media_import ("albumId");
    CREATE INDEX "media_import_ownerId_idx" ON media_import ("ownerId");
    CREATE TABLE media_import_item (
      id uuid PRIMARY KEY DEFAULT immich_uuid_v7(), "importId" uuid NOT NULL REFERENCES media_import ON DELETE CASCADE ON UPDATE CASCADE,
      "ownerId" uuid NOT NULL REFERENCES "user" ON DELETE CASCADE ON UPDATE CASCADE,
      "sourceKey" varchar NOT NULL, entry jsonb NOT NULL, state varchar NOT NULL DEFAULT 'discovered',
      "assetId" uuid, "uploadId" uuid, suppression text, error text, bytes double precision NOT NULL DEFAULT 0,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "media_import_item_importId_sourceKey_key" UNIQUE ("importId", "sourceKey")
    );
    CREATE INDEX "media_import_item_importId_idx" ON media_import_item ("importId");
    CREATE INDEX "media_import_item_ownerId_idx" ON media_import_item ("ownerId");
    CREATE INDEX "media_import_item_ownerId_sourceKey_idx" ON media_import_item ("ownerId", "sourceKey");
    CREATE INDEX "media_import_item_assetId_idx" ON media_import_item ("assetId");
    ALTER TABLE asset_source ADD COLUMN provider text, ADD COLUMN "creatorId" text, ADD COLUMN "postId" text,
      ADD COLUMN "attachmentId" text, ADD COLUMN "publishedAt" timestamptz, ADD COLUMN "postText" text;

    CREATE FUNCTION media_import_asset_removed() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      IF TG_OP = 'DELETE' OR (NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL) THEN
        UPDATE media_import_item SET suppression = 'owner', "updatedAt" = clock_timestamp()
          WHERE "assetId" = OLD.id;
      END IF;
      RETURN NULL;
    END;
    $body$;
    CREATE TRIGGER media_import_asset_deleted AFTER DELETE ON asset
      FOR EACH ROW EXECUTE FUNCTION media_import_asset_removed();
    CREATE TRIGGER media_import_asset_trashed AFTER UPDATE OF "deletedAt" ON asset
      FOR EACH ROW EXECUTE FUNCTION media_import_asset_removed();
    CREATE FUNCTION media_import_collection_removed() RETURNS trigger LANGUAGE plpgsql AS $body$
    BEGIN
      UPDATE media_import_item item SET suppression = 'subscription', "updatedAt" = clock_timestamp()
        FROM media_import operation WHERE item."importId" = operation.id
        AND operation."subscriptionId" IS NOT NULL AND operation."albumId" = OLD."albumId"
        AND item."assetId" = OLD."assetId" AND item.suppression IS DISTINCT FROM 'owner';
      RETURN NULL;
    END;
    $body$;
    CREATE TRIGGER media_import_collection_removed AFTER DELETE ON album_asset
      FOR EACH ROW EXECUTE FUNCTION media_import_collection_removed();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP TRIGGER media_import_collection_removed ON album_asset;
    DROP TRIGGER media_import_asset_trashed ON asset;
    DROP TRIGGER media_import_asset_deleted ON asset;
    DROP FUNCTION media_import_collection_removed();
    DROP FUNCTION media_import_asset_removed();
    ALTER TABLE asset_source DROP COLUMN provider, DROP COLUMN "creatorId", DROP COLUMN "postId",
      DROP COLUMN "attachmentId", DROP COLUMN "publishedAt", DROP COLUMN "postText";
    DROP TABLE media_import_item, media_import, media_subscription, media_connection;
  `.execute(db);
}
